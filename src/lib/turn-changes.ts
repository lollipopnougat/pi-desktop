/**
 * 「本次改动」数据层：从会话消息里还原每一轮 agent 改了哪些文件。
 *
 * 为什么以消息为准而不是读 git / 实时 toolExecutions：
 * - 历史会话没有 toolExecutions（事件不重放），只有消息；按消息推导则历史轮次同样有改动卡片
 * - 不依赖 git（非 git 项目、新建文件同样可用），也不在主进程增加状态
 *
 * 两个数据来源：
 * - `edit`：工具结果 details.patch 就是精确 unified diff（含 context 行）
 * - `write`：SDK 的 write 工具不返回 patch（details 为 undefined），按整文件内容合成一个
 *   「全新增」patch —— 新建文件时完全准确；整文件重写时只表达「写入了什么」（kind='write'，
 *   UI 会标注）。bash / 外部进程造成的改动不在覆盖范围内。
 */
import { createTwoFilesPatch } from 'diff';
import type { TurnChanges, TurnFileChange } from '../types/shared';
import { countPatchChanges } from './patch-utils';

/** write 合成 patch 的上下文行数（与 SDK edit 的 4 行接近，取 3 足够展示） */
const WRITE_PATCH_CONTEXT = 3;

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

/** 从 assistant 消息里的 toolCall 块取 `{ 工具名, 入参 }` */
function readToolCalls(message: any): [string, ToolCallRecord][] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const calls: [string, ToolCallRecord][] = [];
  for (const block of content) {
    if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
    calls.push([
      block.id,
      {
        name: typeof block.name === 'string' ? block.name : '',
        args: (block.arguments ?? {}) as Record<string, unknown>
      }
    ]);
  }
  return calls;
}

/**
 * 扫描整段消息，返回 `toolCallId → 该次调用产生的文件改动`。
 *
 * 只收成功结果（`isError` 的调用没有真正改文件）。write 的 patch 在这里合成，
 * 因为 toolCall 的入参（path/content）只在 assistant 消息里，toolResult 里没有。
 */
export function collectToolCallChanges(messages: any[]): Map<string, TurnFileChange> {
  const calls = new Map<string, ToolCallRecord>();
  const changes = new Map<string, TurnFileChange>();
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'toolResult') {
      for (const [id, call] of readToolCalls(message)) calls.set(id, call);
      continue;
    }
    if (message.isError) continue;
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
    const call = calls.get(callId);
    if (!call) continue;
    const path = typeof call.args.path === 'string' ? call.args.path : '';
    if (!path) continue;

    let patch: string | undefined;
    let kind: TurnFileChange['kind'];
    if (call.name === 'edit') {
      const details = message.details as { patch?: unknown } | undefined;
      if (typeof details?.patch !== 'string' || !details.patch) continue;
      patch = details.patch;
      kind = 'edit';
    } else if (call.name === 'write') {
      const content = typeof call.args.content === 'string' ? call.args.content : null;
      if (content == null) continue;
      patch = createTwoFilesPatch(path, path, '', content, '', '', {
        context: WRITE_PATCH_CONTEXT
      });
      kind = 'write';
    } else {
      continue;
    }

    const counts = countPatchChanges(patch);
    changes.set(callId, {
      path,
      patches: [patch],
      additions: counts.additions,
      deletions: counts.deletions,
      kind
    });
  }
  return changes;
}

/**
 * 把一轮内多次改动按文件聚合：同一文件被改多次时合并 patch、累加统计。
 * `kind` 只有全部改动都来自 write 时才是 'write'（说明没有精确 patch）。
 */
export function aggregateTurnChanges(list: TurnFileChange[]): TurnChanges | undefined {
  if (list.length === 0) return undefined;
  const byPath = new Map<string, TurnFileChange>();
  for (const change of list) {
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, { ...change, patches: change.patches.slice() });
      continue;
    }
    existing.patches.push(...change.patches);
    existing.additions += change.additions;
    existing.deletions += change.deletions;
    if (change.kind === 'edit') existing.kind = 'edit';
  }
  const files = [...byPath.values()];
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0)
  };
}

/**
 * 展示用路径：项目内文件显示相对 cwd 的路径，项目外保持原样。
 * 工具上报的路径可能是相对路径（`src/a.ts`）也可能是绝对路径，统一按 `/` 归一化比较。
 */
export function relativeToCwd(filePath: string, cwd?: string | null): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (!cwd) return normalized;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return normalized;
  if (normalized === root) return normalized;
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** 拆分展示路径为「目录 + 文件名」，便于目录淡化、文件名高亮 */
export function splitDisplayPath(displayPath: string): { dir: string; name: string } {
  const index = displayPath.lastIndexOf('/');
  if (index < 0) return { dir: '', name: displayPath };
  return { dir: displayPath.slice(0, index + 1), name: displayPath.slice(index + 1) };
}

/**
 * 稳定短哈希（FNV-1a 32 位），只用于把「一轮改动」折叠成稳定的 tab id。
 * 不用 path 直接拼 id：路径很长且一个文件可能在不同轮次被改（需要不同的 diff tab）。
 */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 「本次改动」里一个文件的稳定标识（同一文件同一轮改动共用一个 diff tab）。
 * 带上 patch 的哈希：同一文件在不同轮次被改出相同统计时不能共用 tab（会显示上一轮的 diff）。
 */
export function changeSignature(change: TurnFileChange): string {
  const body = shortHash(change.patches.join('\n'));
  return `${change.path}:${change.additions}:${change.deletions}:${body}`;
}
