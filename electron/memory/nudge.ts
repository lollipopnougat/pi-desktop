/**
 * 自动沉淀的判定逻辑（纯函数 + 每会话计数器）。
 *
 * 三个触发源：
 * - 轮次阈值：每 `nudgeTurns` 轮，或累计 `nudgeToolCalls` 次工具调用后沉淀一次
 * - 纠错捕获：用户消息命中纠正模式（「不对 / 应该是 / 我说的是」…）→ 立即沉淀
 * - 压缩前 flush：`session_before_compact` 时沉淀，避免被压缩掉的对话没进记忆
 *
 * 计数器只在内存里（按会话 id 分键）：自动沉淀是「尽力而为」的提醒机制，
 * 进程重启后从头计数没有副作用——会话水位线（state.json 的 mtimeMs/size）
 * 保证同一份对话不会被重复提取。
 */

/** 纠正的强度：strong 立即触发，weak 只在轮次阈值附近才触发（避免误报刷屏） */
export type CorrectionStrength = 'strong' | 'weak';

export interface CorrectionHit {
  strength: CorrectionStrength;
  /** 命中的片段（截断到 60 字符，用于日志与 UI 提示） */
  excerpt: string;
  /** 分类标签，便于排查误报 */
  label: string;
}

interface CorrectionPattern {
  label: string;
  strength: CorrectionStrength;
  re: RegExp;
}

/**
 * 纠正模式。宁可漏报也不要误报：误报会让模型反复跑提取（费 token），
 * 漏报还有轮次阈值兜底。
 */
export const CORRECTION_PATTERNS: CorrectionPattern[] = [
  // 明确的否定 + 改正
  { label: 'cn-not-that', strength: 'strong', re: /(不对|错了|不是这样|不是这个意思|理解错|搞错)/ },
  { label: 'cn-should-be', strength: 'strong', re: /应该(是|用|改|按|这样)/ },
  { label: 'cn-i-said', strength: 'strong', re: /我(说|讲)的(是|不是)/ },
  { label: 'cn-do-not', strength: 'strong', re: /(不要|别再|别再这么|不许)(这样|这么|再)/ },
  { label: 'cn-remember-later', strength: 'strong', re: /(记住|记一下|以后)(都|要|用|别|不要)/ },
  {
    label: 'en-wrong',
    strength: 'strong',
    re: /\b(that's (wrong|incorrect)|not what i (asked|meant))\b/i
  },
  {
    label: 'en-instead',
    strength: 'strong',
    re: /\b(no,? (use|do)|instead (use|do)|don't do that)\b/i
  },
  // 弱信号：可能是纠正，也可能只是补充
  { label: 'cn-actually', strength: 'weak', re: /(其实|实际上|正确(的)?做法)/ },
  { label: 'cn-prefer', strength: 'weak', re: /(下次|以后)(记得|要)/ },
  { label: 'en-actually', strength: 'weak', re: /\b(actually|in fact|rather)\b/i }
];

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 60 ? `${slice.slice(0, 60)}…` : slice;
}

/** 在用户消息里找纠正信号；没有则返回 null */
export function detectCorrection(text: string): CorrectionHit | null {
  if (!text || text.length < 4) return null;
  for (const pattern of CORRECTION_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) {
      return {
        strength: pattern.strength,
        label: pattern.label,
        excerpt: excerptAround(text, match.index, match[0].length)
      };
    }
  }
  return null;
}

export interface NudgeCounters {
  /** 累计轮次 */
  turns: number;
  /** 累计工具调用次数 */
  toolCalls: number;
  /** 上次沉淀时的轮次快照 */
  lastTurns: number;
  /** 上次沉淀时的工具调用快照 */
  lastToolCalls: number;
  /** 上次沉淀时间（ms），防抖用 */
  lastAt: number;
}

/** 两次沉淀之间的最小间隔：避免「纠错 + 轮次阈值」同时命中时连跑两次提取 */
export const MIN_SEDIMENT_GAP_MS = 60_000;
/** 纠错触发要求的最少轮次：开局一句「不对」不值得单独跑一次提取 */
export const CORRECTION_MIN_TURNS = 3;

export function emptyCounters(): NudgeCounters {
  return { turns: 0, toolCalls: 0, lastTurns: 0, lastToolCalls: 0, lastAt: 0 };
}

export interface NudgeThresholds {
  nudgeTurns: number;
  nudgeToolCalls: number;
}

/** 轮次或工具调用达到阈值 */
export function shouldSediment(
  counters: NudgeCounters,
  thresholds: NudgeThresholds,
  now = Date.now()
): boolean {
  if (now - counters.lastAt < MIN_SEDIMENT_GAP_MS) return false;
  const turns = Math.max(1, Math.floor(thresholds.nudgeTurns));
  const toolCalls = Math.max(1, Math.floor(thresholds.nudgeToolCalls));
  return (
    counters.turns - counters.lastTurns >= turns ||
    counters.toolCalls - counters.lastToolCalls >= toolCalls
  );
}

/** 纠错是否值得立即沉淀 */
export function shouldSedimentOnCorrection(
  hit: CorrectionHit | null,
  counters: NudgeCounters,
  now = Date.now()
): boolean {
  if (!hit || hit.strength !== 'strong') return false;
  if (counters.turns < CORRECTION_MIN_TURNS) return false;
  return now - counters.lastAt >= MIN_SEDIMENT_GAP_MS;
}

// ─── 每会话计数器（进程内，按会话 id 分键） ───

const counters = new Map<string, NudgeCounters>();

export function resetNudgeCounters(sessionKey: string): NudgeCounters {
  const fresh = emptyCounters();
  counters.set(sessionKey, fresh);
  return fresh;
}

export function getNudgeCounters(sessionKey: string): NudgeCounters {
  const existing = counters.get(sessionKey);
  if (existing) return existing;
  const fresh = emptyCounters();
  counters.set(sessionKey, fresh);
  return fresh;
}

/** 一轮结束：累加轮次与工具调用次数 */
export function recordTurn(sessionKey: string, toolCalls = 0): NudgeCounters {
  const state = getNudgeCounters(sessionKey);
  state.turns += 1;
  state.toolCalls += Math.max(0, Math.floor(toolCalls));
  return state;
}

/** 沉淀发生：记录基线，下一轮重新累计 */
export function markSedimented(sessionKey: string, now = Date.now()): void {
  const state = getNudgeCounters(sessionKey);
  state.lastTurns = state.turns;
  state.lastToolCalls = state.toolCalls;
  state.lastAt = now;
}

/** 仅测试用 */
export function resetAllNudgeCounters(): void {
  counters.clear();
}
