/**
 * 生命周期钩子配置：~/.pi-desktop/hooks.json
 *
 * 事件直接对齐 pi SDK 的扩展事件（snake_case），共 18 种，按能力分三类：
 * - 可阻止（退出码 2）：tool_call / input / session_before_compact /
 *   session_before_switch / session_before_fork
 * - 可改写：input（stdout 非空 → 替换用户输入文本）
 * - 观察：其余全部
 *
 * 兼容：早期版本使用 Codex 风格命名（PreToolUse/PostToolUse/SessionStart/Stop），
 * 读取时自动归一化为 SDK 事件名，下次保存落盘为新名。
 *
 * 约定：
 * - 读写都是整文件操作，原子写（tmp + rename），文件损坏按空配置处理
 * - runner 每次事件实时重新读文件，设置页改动立即生效，无需重载
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getAgentDir } from '../provider-config';

/** 钩子事件 = pi SDK 扩展事件名（用户可挂载的子集） */
export type HookEvent =
  // 输入与消息
  | 'input'
  | 'before_agent_start'
  | 'message_end'
  // Agent 运行
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  // 工具调用
  | 'tool_call'
  | 'tool_result'
  // 会话生命周期
  | 'session_start'
  | 'session_before_compact'
  | 'session_compact'
  | 'session_before_switch'
  | 'session_before_fork'
  | 'session_shutdown'
  // 请求与模型
  | 'before_provider_request'
  | 'after_provider_response'
  | 'model_select'
  | 'thinking_level_select';

/** 早期 Codex 风格事件名 → SDK 事件名（读取时归一化） */
const LEGACY_EVENT_ALIAS: Record<string, HookEvent> = {
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  SessionStart: 'session_start',
  Stop: 'agent_end'
};

/** 退出码 2 → 阻止/取消 的事件 */
export const BLOCKABLE_EVENTS: readonly HookEvent[] = [
  'tool_call',
  'input',
  'session_before_compact',
  'session_before_switch',
  'session_before_fork'
];

/** stdout 非空 → 改写（替换用户输入文本）的事件 */
export const TRANSFORMABLE_EVENTS: readonly HookEvent[] = ['input'];

const HOOK_EVENTS: readonly HookEvent[] = [
  'input',
  'before_agent_start',
  'message_end',
  'agent_start',
  'agent_end',
  'agent_settled',
  'tool_call',
  'tool_result',
  'session_start',
  'session_before_compact',
  'session_compact',
  'session_before_switch',
  'session_before_fork',
  'session_shutdown',
  'before_provider_request',
  'after_provider_response',
  'model_select',
  'thinking_level_select'
];

export interface HookConfig {
  id: string;
  event: HookEvent;
  /** 显示名称（缺省取命令首段） */
  name: string;
  /** shell 命令（经 spawn shell:true 执行，事件 JSON 走 stdin） */
  command: string;
  /** 超时秒数，超时杀进程且不阻塞 */
  timeoutSec: number;
  enabled: boolean;
}

export const DEFAULT_HOOK_TIMEOUT_SEC = 60;
export const MAX_HOOK_TIMEOUT_SEC = 3600;

const hooksPath = () => path.join(getAgentDir(), 'hooks.json');

/** 事件名归一化：旧别名 → SDK 名；非法 → null */
function normalizeEvent(raw: unknown): HookEvent | null {
  if (typeof raw !== 'string') return null;
  const aliased = LEGACY_EVENT_ALIAS[raw] ?? raw;
  return (HOOK_EVENTS as readonly string[]).includes(aliased) ? (aliased as HookEvent) : null;
}

/** 归一化单条钩子（非法 → null） */
function normalizeHook(raw: unknown): HookConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.command !== 'string' || !h.command.trim()) return null;
  const event = normalizeEvent(h.event);
  if (!event) return null;
  const timeoutSec =
    typeof h.timeoutSec === 'number' && Number.isFinite(h.timeoutSec)
      ? Math.min(Math.max(Math.floor(h.timeoutSec), 1), MAX_HOOK_TIMEOUT_SEC)
      : DEFAULT_HOOK_TIMEOUT_SEC;
  const command = h.command.trim();
  return {
    id: typeof h.id === 'string' && h.id ? h.id : randomUUID(),
    event,
    name: typeof h.name === 'string' && h.name.trim() ? h.name.trim() : command.split(/\s+/)[0],
    command,
    timeoutSec,
    enabled: h.enabled !== false
  };
}

export function readHooks(): HookConfig[] {
  try {
    const raw = fs.readFileSync(hooksPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const arr = (parsed as { hooks?: unknown } | null)?.hooks;
    const list: unknown[] = Array.isArray(arr) ? arr : [];
    return list.map(normalizeHook).filter((h): h is HookConfig => h !== null);
  } catch {
    return [];
  }
}

function writeHooks(hooks: HookConfig[]): void {
  const fullPath = hooksPath();
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const tmp = `${fullPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ hooks }, null, 2), 'utf-8');
  fs.renameSync(tmp, fullPath);
}

/** 新增或更新（有 id 且存在 → 更新；否则新增），返回归一化后的钩子 */
export function upsertHook(input: unknown): HookConfig {
  const hook = normalizeHook(input);
  if (!hook) throw new Error('invalid hook: command/event required');
  const hooks = readHooks();
  const idx = hooks.findIndex((h) => h.id === hook.id);
  if (idx >= 0) {
    hooks[idx] = hook;
  } else {
    hooks.push(hook);
  }
  writeHooks(hooks);
  return hook;
}

export function deleteHook(id: string): boolean {
  const hooks = readHooks();
  const next = hooks.filter((h) => h.id !== id);
  if (next.length === hooks.length) return false;
  writeHooks(next);
  return true;
}

export function setHookEnabled(id: string, enabled: boolean): HookConfig | null {
  const hooks = readHooks();
  const hook = hooks.find((h) => h.id === id);
  if (!hook) return null;
  hook.enabled = enabled;
  writeHooks(hooks);
  return hook;
}
