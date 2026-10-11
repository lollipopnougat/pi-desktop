/**
 * 子 agent 会话文件:落盘目录、会话文件 → 对话数据转换、清理。
 *
 * 设计:
 * - 子会话用 `SessionManager.create(cwd, SUBAGENT_SESSIONS_DIR)` 落盘为标准 SDK
 *   会话文件(JSONL),与主会话 `sessions/` 同级但独立目录 —— SDK 的 listAll()
 *   会递归扫描 sessions/ 下的所有子目录,放独立目录才不会污染左侧会话列表
 * - 详情弹窗「对话」Tab 的数据源:运行中走内存实时采集(可流式),
 *   终态/重启后走本模块(会话文件里有完整工具结果,且不随内存丢失)
 * - run 记录被淘汰时同步删除对应文件(见 controller.pruneRuns)
 */
import fs from 'fs';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { DESKTOP_AGENT_DIR } from '../config-dir';
import { clipText, trimTranscript, MAX_TRANSCRIPT_ITEMS } from './transcript';
import type { ChildToolCall, ChildTranscriptItem } from './types';

/** 子 agent 会话文件目录(独立于主会话 sessions/,不进会话列表) */
export const SUBAGENT_SESSIONS_DIR = path.join(DESKTOP_AGENT_DIR, 'subagent-sessions');

/** 工具流水上限(与实时采集一致,超出丢弃最旧) */
const MAX_TOOL_CALLS = 200;

/** 会话文件里的对话数据(与实时采集同款形状,弹窗直接渲染) */
export interface SubagentConversation {
  transcript: ChildTranscriptItem[];
  toolCalls: ChildToolCall[];
}

/** 目录不存在时创建(SessionManager 落盘前必须存在) */
export function ensureSubagentSessionDir(): string {
  fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
  return SUBAGENT_SESSIONS_DIR;
}

/** 路径是否位于子 agent 会话目录内(删除前的边界校验,禁止越界删除) */
export function isSubagentSessionFile(file: string): boolean {
  const rel = path.relative(SUBAGENT_SESSIONS_DIR, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 删除会话文件(仅限子 agent 会话目录内;不存在/失败静默) */
export function deleteSubagentSessionFile(file: string | undefined): void {
  if (!file || !isSubagentSessionFile(file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 删除失败不影响 run 记录淘汰
  }
}

/**
 * 消息序列 → 对话流 + 工具流水。
 *
 * - assistant 内容块按顺序折算(正文/思考/工具调用),与实时采集的顺序语义一致
 * - toolResult 消息按 toolCallId 回填对应工具调用的结果与错误标记
 * - system / user 消息跳过:system 不进对话;任务正文由弹窗的「任务」块展示
 */
export function buildConversationFromMessages(messages: unknown[]): SubagentConversation {
  const transcript: ChildTranscriptItem[] = [];
  const toolCalls: ChildToolCall[] = [];
  const byToolCallId = new Map<string, ChildToolCall>();

  for (const raw of messages) {
    const msg = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      toolCallId?: string;
      isError?: boolean;
    } | null;
    if (!msg || typeof msg !== 'object') continue;
    const at = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();

    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const rawBlock of content) {
        const b = rawBlock as {
          type?: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          arguments?: unknown;
        } | null;
        if (b?.type === 'text' && b.text) {
          transcript.push({ kind: 'text', at, text: clipText(b.text) });
        } else if (b?.type === 'thinking' && b.thinking) {
          transcript.push({ kind: 'thinking', at, text: clipText(b.thinking) });
        } else if (b?.type === 'toolCall' && b.id) {
          transcript.push({ kind: 'tool', at, toolCallId: b.id });
          const tc: ChildToolCall = {
            toolCallId: b.id,
            toolName: typeof b.name === 'string' ? b.name : '',
            args: b.arguments,
            pending: false,
            startedAt: at
          };
          toolCalls.push(tc);
          byToolCallId.set(b.id, tc);
        }
      }
      continue;
    }

    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      const tc = byToolCallId.get(msg.toolCallId);
      if (tc) {
        tc.result = msg.content;
        tc.isError = msg.isError === true;
        tc.endedAt = at;
      }
    }
  }

  if (toolCalls.length > MAX_TOOL_CALLS) toolCalls.splice(0, toolCalls.length - MAX_TOOL_CALLS);
  trimTranscript(transcript);
  return { transcript, toolCalls };
}

/**
 * 读取会话文件里的完整对话;文件不存在/非子 agent 会话/解析失败返回 null。
 */
export function readSubagentConversation(
  sessionFile: string | undefined
): SubagentConversation | null {
  if (!sessionFile) return null;
  try {
    if (!fs.existsSync(sessionFile)) return null;
    const sm = SessionManager.open(sessionFile);
    const entries = sm.getBranch?.() ?? sm.getEntries?.() ?? [];
    const messages = (entries as Array<{ type?: string; message?: unknown }>)
      .filter((e) => e?.type === 'message' && e.message)
      .map((e) => e.message);
    if (messages.length === 0) return null;
    return buildConversationFromMessages(messages);
  } catch {
    return null;
  }
}

/** 读取会话文件 header 里的 parentSession(父主会话文件路径);无/解析失败返回 null */
export function readSessionParent(sessionFile: string): string | null {
  try {
    const fd = fs.openSync(sessionFile, 'r');
    let line = '';
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      line = buf.subarray(0, read).toString('utf8').split('\n')[0];
    } finally {
      fs.closeSync(fd);
    }
    const header = JSON.parse(line) as { type?: string; parentSession?: unknown };
    if (header?.type !== 'session') return null;
    return typeof header.parentSession === 'string' ? header.parentSession : null;
  } catch {
    return null;
  }
}

/** 列出子 agent 会话目录下的全部会话文件 */
function listSubagentSessionFiles(): string[] {
  try {
    return fs
      .readdirSync(SUBAGENT_SESSIONS_DIR)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(SUBAGENT_SESSIONS_DIR, name));
  } catch {
    return [];
  }
}

/**
 * 删除某个主会话关联的全部子 agent 会话文件,返回删除数量。
 * 依据是子会话文件 header 里的 parentSession(创建时由 executor 传入)。
 */
export function deleteSubagentSessionsForParent(parentSessionFile: string): number {
  const target = path.resolve(parentSessionFile);
  let removed = 0;
  for (const file of listSubagentSessionFiles()) {
    const parent = readSessionParent(file);
    if (parent && path.resolve(parent) === target) {
      deleteSubagentSessionFile(file);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 删除某个项目(主会话目录)下全部主会话关联的子 agent 会话文件,返回删除数量。
 * 用于「移除项目」:主会话目录整体删除前先清掉其子会话。
 */
export function deleteSubagentSessionsForProject(sessionDir: string): number {
  const dir = path.resolve(sessionDir);
  let removed = 0;
  for (const file of listSubagentSessionFiles()) {
    const parent = readSessionParent(file);
    if (parent && path.dirname(path.resolve(parent)) === dir) {
      deleteSubagentSessionFile(file);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 清理孤儿子会话文件(父主会话文件已不存在,或未记录父会话)。
 * 应用启动时调用一次:清理被删会话的残留与历史遗留文件。
 * minAgeMs 保护:跳过刚写入的文件(避免与另一个实例的进行中运行竞争)。
 */
export function deleteOrphanSubagentSessions(minAgeMs = 60_000): number {
  const now = Date.now();
  let removed = 0;
  for (const file of listSubagentSessionFiles()) {
    try {
      if (minAgeMs > 0 && now - fs.statSync(file).mtimeMs < minAgeMs) continue;
    } catch {
      continue;
    }
    const parent = readSessionParent(file);
    if (parent && fs.existsSync(parent)) continue;
    deleteSubagentSessionFile(file);
    removed += 1;
  }
  return removed;
}

/** 供测试/调试:常量导出 */
export const SESSION_FILE_LIMITS = { MAX_TOOL_CALLS, MAX_TRANSCRIPT_ITEMS } as const;
