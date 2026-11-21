/**
 * 评审请求的上下文构造（纯函数，无 IO）。
 *
 * 三块内容：**待审动作**（完整参数，是判断核心）+ **对话转录**（预算内，user 消息优先级最高）
 * + **项目约定**（AGENTS.md 摘录）。策略文本由 `policy-prompt.ts` 提供，不在这里。
 *
 * 两条硬约定：
 * 1. **user 消息优先保留**：它是 `user_authorization` 的唯一依据，比任何工具输出都重要；
 *    其它条目按「从新到旧」装进预算，装不下就丢弃并打 `<truncated/>`。
 * 2. **不可信内容必须标注**：工具输出是被审对象之外的第三方内容（网页、文件、
 *    甚至恶意仓库里的 README），转录里一律带「不可信」标记，让策略里的证据分级能落地。
 */
import type { DangerousBashCheck } from '../policy';

/** 转录总预算（字符）：评审成本不能超过被审的事本身 */
export const MAX_TRANSCRIPT_CHARS = 20000;
/** 单条消息截断上限（大文件写入、长日志） */
export const MAX_MESSAGE_CHARS = 4000;
/** 动作参数上限（动作是判断核心，比转录更重要，给得更宽） */
export const MAX_ACTION_CHARS = 8000;
/** AGENTS.md 摘录上限 */
export const MAX_AGENTS_MD_CHARS = 4000;
/** 最多保留多少条非 user 条目 */
export const MAX_OTHER_MESSAGES = 40;

export interface ReviewActionInput {
  toolName: string;
  input: unknown;
  cwd: string;
  /** auto-safe 的危险命令检测结果（命中时作为附加上下文，不是最终裁决） */
  danger?: DangerousBashCheck | null;
}

export interface BuildReviewRequestInput {
  action: ReviewActionInput;
  /** 会话消息（`AgentSession.messages`，含 custom 类型；形状按 role/content 归一化） */
  messages: readonly unknown[];
  /** AGENTS.md 摘录（全局 + 项目） */
  agentsMd?: string;
}

export interface ReviewRequestText {
  /** 动作块（含 JSON 参数与 cwd） */
  actionText: string;
  /** 转录块（含 <truncated/> 标记） */
  transcriptText: string;
  /** 项目约定块（无内容时为空串） */
  agentsText: string;
  /** 最终发给评审员的 user 消息 */
  userMessage: string;
}

/** 按字符上限裁剪，超限时保留头尾（大文件写入/长日志的关键信息常在两端） */
export function clipWithMarker(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = Math.floor(limit * 0.3);
  return `${text.slice(0, head)}\n…<truncated/>…\n${text.slice(text.length - tail)}`;
}

/** 把任意形状的 content 归一化成文本（thinking 丢弃：噪音大且不是证据） */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'toolCall' && typeof record.name === 'string') {
      // 只记工具名与参数摘要：assistant 想做什么也是判断「是否漂移」的线索
      parts.push(`[调用工具 ${record.name}] ${safeJson(record.arguments)}`);
    }
  }
  return parts.join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

interface TranscriptEntry {
  role: 'user' | 'assistant' | 'toolResult';
  /** 展示用的前缀（role 标签 + 不可信标记） */
  label: string;
  text: string;
}

/** 消息 → 转录条目（丢弃空文本与未知角色） */
export function toTranscriptEntries(messages: readonly unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') continue;
    let text = contentToText(record.content).trim();
    if (!text) continue;
    if (role === 'toolResult') {
      const name = typeof record.toolName === 'string' ? record.toolName : 'unknown';
      const failed = record.isError === true;
      text = clipWithMarker(text, MAX_MESSAGE_CHARS);
      out.push({
        role,
        label: `[工具 ${name}${failed ? ' 失败' : ''} · 不可信]`,
        text
      });
      continue;
    }
    text = clipWithMarker(text, MAX_MESSAGE_CHARS);
    out.push({
      role,
      label: role === 'user' ? '[用户 · 可信]' : '[助手 · 不可信]',
      text
    });
  }
  return out;
}

/**
 * 构造预算内的转录文本。
 *
 * - user 条目全部保留（授权依据），其它条目只保留最近 `MAX_OTHER_MESSAGES` 条；
 * - 再从**新到旧**装进 `MAX_TRANSCRIPT_CHARS`，装不下的丢弃并打 `<truncated/>`；
 *   但最近一条 user 消息永远保留（否则评审员看不到"用户要求了什么"）。
 */
export function summarizeTranscript(messages: readonly unknown[]): string {
  const entries = toTranscriptEntries(messages);
  if (entries.length === 0) return '（本会话还没有任何对话内容）';

  // 先按「user 全留 + 其它只留最近 N 条」筛选，保持原始顺序
  const otherIndices = entries
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.role !== 'user')
    .slice(-MAX_OTHER_MESSAGES)
    .map((item) => item.index);
  const keep = new Set(otherIndices);
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].role === 'user') keep.add(i);
  }
  const kept = entries.filter((_entry, index) => keep.has(index));

  // 新到旧装预算
  const selected: TranscriptEntry[] = [];
  let used = 0;
  let lastUserKept = false;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const entry = kept[i];
    const cost = entry.text.length + entry.label.length + 8;
    const isLastUser = !lastUserKept && entry.role === 'user';
    if (!isLastUser && used + cost > MAX_TRANSCRIPT_CHARS) continue;
    selected.push(entry);
    used += cost;
    if (entry.role === 'user') lastUserKept = true;
  }
  selected.reverse();

  const dropped = kept.length - selected.length;
  // `toTranscriptEntries` 阶段按条数裁掉的也要计入：评审员必须知道「有记录被省略了」
  const droppedByCount = entries.length - kept.length;
  const omitted = dropped + droppedByCount;
  const body = selected.map((entry) => `${entry.label}\n${entry.text}`).join('\n\n');
  const head =
    omitted > 0 ? `…<truncated/> 更早的 ${omitted} 条记录已省略（缺失上下文时应更保守）\n\n` : '';
  return `${head}${body}`;
}

/** 动作块：工具名 + 完整参数 + cwd（+ 危险规则命中提示） */
export function describeAction(action: ReviewActionInput): string {
  const argumentsText = clipWithMarker(safeJson(action.input), MAX_ACTION_CHARS);
  const lines = [`工具：${action.toolName}`, `工作目录：${action.cwd}`, `参数：${argumentsText}`];
  if (action.danger?.dangerous) {
    lines.push(
      `本地危险规则命中：${action.danger.category}（${action.danger.reason}）`,
      '注意：命中危险规则不等于一定拒绝，但它说明该动作会造成难以撤销的影响，请核对授权与范围。'
    );
  }
  return lines.join('\n');
}

/** 组装最终发给评审员的 user 消息 */
export function buildReviewRequest(input: BuildReviewRequestInput): ReviewRequestText {
  const actionText = describeAction(input.action);
  const transcriptText = summarizeTranscript(input.messages);
  const agentsText = input.agentsMd
    ? clipWithMarker(input.agentsMd.trim(), MAX_AGENTS_MD_CHARS)
    : '';

  const sections = ['## 待审动作', actionText, '', '## 对话转录（越靠后越新）', transcriptText];
  if (agentsText) {
    sections.push('', '## 项目约定（AGENTS.md，可信）', agentsText);
  }
  sections.push('', '## 输出', '严格按约定只输出 JSON。');

  return {
    actionText,
    transcriptText,
    agentsText,
    userMessage: sections.join('\n')
  };
}
