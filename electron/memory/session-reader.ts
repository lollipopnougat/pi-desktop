/**
 * 会话 JSONL 读取器：扫描项目会话目录、解析 transcript、水位线比对。
 *
 * 会话文件格式（SDK session-manager 持久化，每行一个 JSON）：
 * - {"type":"session","id","cwd",...}                      头
 * - {"type":"message","message":{role,content:[block]}}    消息
 *   content block: {type:"text"|"thinking"|"toolCall"|"toolResult",...}
 * - {"type":"custom"|"model_change"|...}                   其他（忽略）
 *
 * 过滤策略（参考 codex extractPersistableMessages + oh-my-pi）：
 * - 只保留 user / assistant 的 text block（thinking 丢弃，噪音大）
 * - assistant 的 toolCall 以单行摘要呈现（[tool: ...]），保留动作轨迹
 * - toolResult 保留有界结果摘要，明确区分失败与未经核验的结果
 * - 跳过空 user 消息（如系统注入的空 turn）
 *
 * 纯 node 依赖，可被 vitest 直接测试。
 */
import fs from 'fs';
import path from 'path';
import { revisionOf } from './persistence';
import { getSessionDir } from '../provider-config';
import { redactSecrets } from './store';

export interface SessionFileMeta {
  /** 文件绝对路径 */
  path: string;
  /** 文件名（含时间戳前缀） */
  name: string;
  mtimeMs: number;
  size: number;
}

export interface TranscriptLine {
  role: 'user' | 'assistant' | 'toolResult';
  entryId?: string;
  parentId?: string | null;
  timestamp?: string;
  fingerprint?: string;
  text: string;
}

/** 列出项目目录下全部会话 JSONL（按 mtime 升序） */
export function listSessionFiles(cwd: string, sessionDir?: string): SessionFileMeta[] {
  const dir = sessionDir ?? getSessionDir(cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SessionFileMeta[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    try {
      const st = fs.statSync(full);
      files.push({ path: full, name: e.name, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* 文件被并发删除则跳过 */
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 水位线键：会话绝对路径指纹（项目间同名会话相互隔离） */
export function watermarkKey(meta: SessionFileMeta): string {
  return revisionOf(path.resolve(meta.path));
}

/**
 * 解析单个会话 JSONL 为 transcript。
 * 不完整或损坏的 JSONL 报错，不能错误地推进完成水位。
 */
export function parseSessionTranscript(
  filePath: string,
  maxChars = 120_000
): { lines: TranscriptLine[]; truncated: boolean } {
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries: Array<Record<string, any>> = [];
  for (const [index, row] of raw.split('\n').entries()) {
    if (!row.trim()) continue;
    try {
      entries.push({ ...JSON.parse(row), rowIndex: index });
    } catch {
      throw new Error(`会话第 ${index + 1} 行不完整或损坏，请在写入完成后重试`);
    }
  }
  // JSONL 中可包含分叉：只沿最后一个带 parentId 的节点回溯当前分支。
  const linked = entries.filter((e) => typeof e.id === 'string' && 'parentId' in e);
  let active: Set<string> | undefined;
  if (linked.length) {
    active = new Set();
    const byId = new Map(entries.map((e) => [e.id, e]));
    let current: Record<string, any> | undefined = linked.at(-1);
    while (current?.id && !active.has(current.id)) {
      active.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  const lines: TranscriptLine[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of entries) {
    if (active && !active.has(entry.id)) continue;
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg || !['user', 'assistant', 'toolResult'].includes(msg.role)) continue;
    const role = msg.role as TranscriptLine['role'];
    const blocks =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content
          : [];
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (role === 'assistant' && block?.type === 'toolCall' && block.name)
        parts.push(`[${block.name}: ${summarizeToolArgs(block.arguments ?? block.input)}]`);
    }
    let text = parts.join('\n').trim();
    if (role === 'toolResult')
      text = `[工具 ${msg.toolName || msg.toolCallId || 'unknown'} ${msg.isError ? '失败' : '返回结果（需结合内容判断）'}] ${text.length > 800 ? text.slice(0, 400) + '\n…\n' + text.slice(-400) : text}`;
    if (!text) continue;
    const entryId = String(entry.id ?? `row-${entry.rowIndex}`);
    // 大消息分块而不是截掉尾部；每块有稳定的 entry/part/hash。
    for (let offset = 0; offset < text.length; offset += 16000) {
      const piece = text.slice(offset, offset + 16000);
      if (used + piece.length > maxChars) {
        truncated = true;
        break;
      }
      used += piece.length;
      lines.push({
        role,
        text: piece,
        entryId,
        parentId: entry.parentId,
        timestamp:
          entry.timestamp ??
          (typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString() : undefined),
        fingerprint: revisionOf(`${entryId}:${offset}:${piece}`)
      });
    }
    if (truncated) break;
  }
  return { lines, truncated };
}

/** 提取分块不丢尾部；水位线记录每个成功块的消息指纹。 */
export function transcriptChunks(lines: TranscriptLine[], maxChars = 24000): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length && size + line.text.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** 工具参数摘要：取关键参数的短预览 */
function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const key of [
    'command',
    'path',
    'file_path',
    'filePath',
    'pattern',
    'url',
    'query',
    'prompt'
  ]) {
    const v = a[key];
    if (typeof v === 'string' && v) {
      const s = v.replace(/\s+/g, ' ').trim();
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }
  }
  return Object.keys(a).slice(0, 3).join(',');
}

/** transcript → 送模型的文本（送出前脱敏） */
export function formatTranscript(lines: TranscriptLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    out.push(
      `[entry=${l.entryId || 'unknown'} time=${l.timestamp || 'unknown'}] ${l.role === 'user' ? '用户' : l.role === 'assistant' ? '助手（陈述不等于验证）' : '工具结果'}: ${l.text}`
    );
  }
  return redactSecrets(out.join('\n\n'));
}

/** 会话第一句用户消息（做 slug 用） */
export function firstUserText(lines: TranscriptLine[]): string {
  for (const l of lines) {
    if (l.role === 'user') return l.text;
  }
  return '';
}
