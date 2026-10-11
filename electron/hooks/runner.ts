/**
 * 钩子执行器：按事件过滤启用的钩子并逐个执行 shell 命令。
 *
 * 执行模型（对齐 Claude Code / Codex 约定）：
 * - 命令经 `spawn(command, { shell: true })` 执行，cwd 为当前项目目录
 * - 事件 JSON 经 stdin 传入；同时注入环境变量 PI_HOOK_EVENT / PI_HOOK_NAME
 * - 超时（hook.timeoutSec，默认 60s）SIGTERM → 2s 后 SIGKILL 兜底
 * - fail-open：spawn 失败 / 超时 / 非 0/2 退出码都只记录不阻塞
 * - 阻止语义仅对 BLOCKABLE_EVENTS 生效：退出码 2 → 阻止/取消该事件动作，
 *   stderr（缺省回退 stdout）作为原因反馈给模型/用户
 * - 改写语义仅对 TRANSFORMABLE_EVENTS 生效：退出码 0 且 stdout 非空 →
 *   用 stdout 替换事件字段（input 事件替换用户输入文本）
 */
import { spawn } from 'child_process';
import {
  readHooks,
  BLOCKABLE_EVENTS,
  TRANSFORMABLE_EVENTS,
  type HookConfig,
  type HookEvent,
  DEFAULT_HOOK_TIMEOUT_SEC
} from './config';

export interface HookOutcome {
  hookId: string;
  hookName: string;
  exitCode: number | null;
  timedOut: boolean;
  /** 截断后的 stdout / stderr（各最多 8KB） */
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HookRunSummary {
  event: HookEvent;
  ran: number;
  /** 仅 BLOCKABLE_EVENTS：某钩子以退出码 2 请求阻止 */
  blocked: boolean;
  reason?: string;
  /** 仅 TRANSFORMABLE_EVENTS：退出码 0 且 stdout 非空 → 新文本 */
  transformed?: string;
  outcomes: HookOutcome[];
}

const MAX_CAPTURE = 8 * 1024;
const MAX_REASON = 500;

function appendCapped(buf: string, chunk: Buffer): string {
  if (buf.length >= MAX_CAPTURE) return buf;
  return (buf + chunk.toString('utf-8')).slice(0, MAX_CAPTURE);
}

function runOne(
  hook: HookConfig,
  payload: Record<string, unknown>,
  cwd: string
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd,
        env: {
          ...process.env,
          PI_HOOK_EVENT: hook.event,
          PI_HOOK_NAME: hook.name
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({
        hookId: hook.id,
        hookName: hook.name,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: String(err)
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killFallback: NodeJS.Timeout | null = null;

    const timeoutMs = (hook.timeoutSec || DEFAULT_HOOK_TIMEOUT_SEC) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      killFallback = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 2000);
    }, timeoutMs);

    const done = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      resolve({ hookId: hook.id, hookName: hook.name, exitCode, timedOut, stdout, stderr, error });
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout = appendCapped(stdout, d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = appendCapped(stderr, d);
    });
    child.on('error', (err) => done(null, String(err)));
    child.on('close', (code) => done(code));

    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin 写入失败（进程已退出等）——close/error 会兜底结算
    }
  });
}

/**
 * 执行某事件下所有启用的钩子（按配置顺序串行）。
 * 阻止：blockable 事件下任一钩子退出码 2 → blocked，剩余钩子不再执行。
 * 改写：transformable 事件下退出码 0 且 stdout 非空 → 新文本（多钩子时后者覆盖前者）。
 */
const isBlockable = (event: HookEvent) => (BLOCKABLE_EVENTS as readonly string[]).includes(event);
const isTransformable = (event: HookEvent) =>
  (TRANSFORMABLE_EVENTS as readonly string[]).includes(event);

export async function runHooksForEvent(
  event: HookEvent,
  payload: Record<string, unknown>,
  cwd: string
): Promise<HookRunSummary> {
  const hooks = readHooks().filter((h) => h.enabled && h.event === event);
  const outcomes: HookOutcome[] = [];
  let blocked = false;
  let reason: string | undefined;
  let transformed: string | undefined;

  for (const hook of hooks) {
    const outcome = await runOne(hook, payload, cwd);
    outcomes.push(outcome);
    if (isBlockable(event) && !outcome.timedOut && outcome.exitCode === 2) {
      blocked = true;
      reason = (
        outcome.stderr.trim() ||
        outcome.stdout.trim() ||
        `钩子「${hook.name}」阻止了本次操作`
      ).slice(0, MAX_REASON);
      break;
    }
    if (isTransformable(event) && outcome.exitCode === 0) {
      const text = outcome.stdout.replace(/\n+$/, '');
      if (text.trim()) transformed = text.slice(0, MAX_REASON);
    }
  }

  return { event, ran: outcomes.length, outcomes, blocked, reason, transformed };
}
