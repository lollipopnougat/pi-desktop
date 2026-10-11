/**
 * git-ai 内联扩展：把 agent 的文件改动 / bash 执行以 checkpoint 形式
 * 上报给 git-ai（AI 改动溯源工具），使后续 `git-ai log/blame/diff`
 * 能区分 AI 与人类的改动归属。
 *
 * 移植自 pi CLI 的用户扩展 ~/.pi/agent/extensions/git-ai.ts（旧包名
 * @mariozechner/pi-coding-agent，默认导出工厂），适配 pi-desktop：
 * - 改用 @earendil-works/pi-coding-agent 的 InlineExtension 形态，
 *   经 pi-bridge 的 extensionFactories 注入（noExtensions 不影响内联扩展）
 * - session_id / model 改从 SDK ExtensionContext 直接取
 *   （ctx.sessionManager.getSessionId() / ctx.model），不再解析会话文件
 * - 使用通用 agent-v1 preset（而非 pi preset），agent 名可自定义，
 *   blame/log 中显示为 "Pi Desktop"；代价是 agent-v1 不登记
 *   StreamSource（无法回读 pi 会话文件提取 prompt），prompt 维度追踪降级
 *
 * checkpoint 事件（agent-v1 的 type 判别字段，snake_case）：
 * - human：edit/write 变更前，携带 will_edit_filepaths + dirty_files
 *   （改动前文件内容），把此前改动标记为人类
 * - ai_agent：edit/write 成功后，携带 edited_filepaths + 会话元数据
 * - pre_shell_command / post_shell_command：bash 工具前后，
 *   git-ai 快照机制自行做文件 diff
 *
 * 非阻塞设计：git-ai 二进制缺失 / spawn 失败 / 超时均不影响 agent 主流程
 * （未装 git-ai 时静默跳过；已装但执行失败时每个进程提示一次），超时 10s 杀进程。
 *
 * 跨平台：可执行文件路径经 os.homedir() 解析（Windows 无 HOME 环境变量，
 * 只有 USERPROFILE），Windows 下文件名补 .exe，spawn 带 windowsHide
 * 避免 GUI 进程弹出控制台窗口。
 *
 * 配置（设置页「智能体配置 → git-ai 改动溯源」，落盘 ~/.pi-desktop/git-ai.json）：
 * 总开关 / 二进制路径 / 上报范围（全部·仅文件·仅 shell）；每次事件处理时读一次
 * 配置，因此设置页改动即时生效，无需重启。
 */
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { readGitAiConfig, type GitAiConfig } from './config';
import { resolveGitAiBin, resolveAbsolutePath, type ResolvedGitAiBin } from './paths';

/** git-ai 中显示的 agent 名（AgentId.tool） */
const GIT_AI_AGENT_NAME = 'Pi Desktop';

/** 单文件 dirty_files 内容上限（字符）：超长截断，防 payload 过大 */
const MAX_DIRTY_FILE_CHARS = 200_000;

/** checkpoint 进程超时（ms）：git-ai 正常毫秒级完成，10s 兜底防卡 agent */
const CHECKPOINT_TIMEOUT_MS = 10_000;

/** agent-v1 preset 的 payload type 判别值 */
type AgentV1PayloadType = 'human' | 'ai_agent' | 'pre_shell_command' | 'post_shell_command';

/** 变更类工具 → 取路径的字段（edit/write 的路径都在 input.path） */
const MUTATING_TOOLS: Record<string, { filepathFields: string[] }> = {
  edit: { filepathFields: ['path'] },
  write: { filepathFields: ['path'] }
};

/** git-ai checkpoint agent-v1 preset 的 payload 格式（snake_case） */
interface CheckpointPayload {
  type: AgentV1PayloadType;
  repo_working_dir: string;
  agent_name?: string;
  model?: string;
  conversation_id?: string;
  tool_use_id?: string;
  /** human：即将被改的文件 → 当前内容；ai_agent：已改文件 → 改动前内容 */
  dirty_files?: Record<string, string>;
  will_edit_filepaths?: string[];
  edited_filepaths?: string[];
  command?: string;
  tool_input?: unknown;
  tool_result?: unknown;
}

/** 待结算的 edit/write 调用（toolCallId → 路径列表），tool_result 成功后上报 ai_agent */
interface PendingEditCall {
  filepaths: string[];
  toolInput: unknown;
}

/** 从工具 input 提取并归一化（绝对路径去重）文件路径列表 */
function extractFilepaths(cwd: string, input: unknown, filepathFields: string[]): string[] {
  const raw = input as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return [];
  const unique = new Set<string>();
  for (const field of filepathFields) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) {
      unique.add(resolveAbsolutePath(cwd, value));
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) {
          unique.add(resolveAbsolutePath(cwd, entry));
        }
      }
    }
  }
  return [...unique];
}

/** 从 bash 工具 input 提取命令字符串（agent-v1 pre/post_shell_command 的 command 字段） */
function extractBashCommand(input: unknown): string | undefined {
  const raw = input as Record<string, unknown> | null | undefined;
  const command = raw?.command ?? raw?.cmd;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

/** 读取文件当前内容作 dirty_files（读不到给空串，与原扩展一致） */
async function readDirtyFiles(filepaths: string[]): Promise<Record<string, string>> {
  const dirtyFiles: Record<string, string> = {};
  await Promise.all(
    filepaths.map(async (filepath) => {
      try {
        const content = await readFile(filepath, 'utf-8');
        dirtyFiles[filepath] =
          content.length > MAX_DIRTY_FILE_CHARS ? content.slice(0, MAX_DIRTY_FILE_CHARS) : content;
      } catch {
        dirtyFiles[filepath] = '';
      }
    })
  );
  return dirtyFiles;
}

/**
 * 二进制不可用时的提示，**每个进程只打一次**。
 *
 * 只在「本应可用」时提示（显式指定了覆盖路径，或官方安装目录下确有该文件）：
 * 没装 git-ai 的是多数用户，checkpoint 本就是可选旁路观测，不该反复打扰。
 */
let unavailableWarned = false;
function warnUnavailable(error: unknown, bin: ResolvedGitAiBin): void {
  if (unavailableWarned || !bin.expectAvailable) return;
  unavailableWarned = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[git-ai] checkpoint 上报不可用，本次会话不再提示：${detail}（二进制：${bin.bin}）。` +
      '请确认该文件存在且可执行，或在设置页「智能体配置 → git-ai 改动溯源」重新指定路径。'
  );
}

/** 按当前配置解析生效的二进制（设置页路径优先，留空则自动探测） */
function effectiveBin(config: GitAiConfig): ResolvedGitAiBin {
  return resolveGitAiBin({ overridePath: config.binPath });
}

/** 执行 git-ai checkpoint（agent-v1 preset）。非阻塞：任何失败只吞掉。 */
function runCheckpoint(payload: CheckpointPayload, bin: ResolvedGitAiBin): Promise<void> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin.bin, ['checkpoint', 'agent-v1', '--hook-input', 'stdin'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        // Windows 上 GUI 进程 spawn 控制台程序会额外弹一个控制台窗口，必须隐藏
        windowsHide: true
      });
    } catch (error) {
      warnUnavailable(error, bin);
      resolvePromise();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      done();
    }, CHECKPOINT_TIMEOUT_MS);

    child.on('error', (error) => {
      warnUnavailable(error, bin);
      done();
    });
    child.on('close', done);
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      // stdin 写入失败（进程已退出等）——close/error 兜底结算
    }
  });
}

/** 从 ExtensionContext 提取会话公共字段；无 session 时返回 null（跳过） */
function baseFields(ctx: {
  cwd: string;
  sessionManager: { getSessionId(): string };
  model?: { id?: string };
}): { repo_working_dir: string; conversation_id: string; model: string } | null {
  let sessionId = '';
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    return null;
  }
  if (!sessionId) return null;
  return {
    repo_working_dir: ctx.cwd,
    conversation_id: sessionId,
    model: ctx.model?.id ?? ''
  };
}

export function gitAiExtensionFactory(): InlineExtension {
  return {
    name: 'git-ai',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const pendingEdits = new Map<string, PendingEditCall>();
      /** 待结算的 bash 调用（toolCallId → 命令），tool_result 成功后上报 post_shell_command */
      const pendingBash = new Map<string, string | undefined>();

      // ─── before：edit/write / bash ───
      pi.on('tool_call', async (event, ctx) => {
        // 每次事件读一次配置：设置页改动即时生效（文件很小，开销远低于随后的 spawn）
        const config = readGitAiConfig();
        if (!config.enabled) return;

        // bash：快照机制自行 diff 文件系统，只上报事件不带文件内容
        if (event.toolName === 'bash') {
          if (config.scope === 'files') return;
          const base = baseFields(ctx);
          if (!base) return;
          const command = extractBashCommand(event.input);
          pendingBash.set(event.toolCallId, command);
          await runCheckpoint(
            {
              type: 'pre_shell_command',
              ...base,
              agent_name: GIT_AI_AGENT_NAME,
              tool_use_id: event.toolCallId,
              command,
              tool_input: event.input
            },
            effectiveBin(config)
          );
          return;
        }

        // edit/write：读当前内容作 dirty_files，记录待结算
        const toolDef = MUTATING_TOOLS[event.toolName];
        if (!toolDef) return;
        if (config.scope === 'shell') return;
        const filepaths = extractFilepaths(ctx.cwd, event.input, toolDef.filepathFields);
        if (filepaths.length === 0) return;

        const base = baseFields(ctx);
        if (!base) return;

        pendingEdits.set(event.toolCallId, {
          filepaths,
          toolInput: event.input
        });

        await runCheckpoint(
          {
            type: 'human',
            ...base,
            will_edit_filepaths: filepaths,
            dirty_files: await readDirtyFiles(filepaths),
            tool_input: event.input
          },
          effectiveBin(config)
        );
      });

      // ─── after：tool_result 结算（失败的工具调用不上报 after） ───
      pi.on('tool_result', async (event, ctx) => {
        // 配置可能在 tool_call 与 tool_result 之间被改（关开关/缩范围），此处再读一次
        const config = readGitAiConfig();
        if (!config.enabled) {
          // 关掉后不再结算，同时清掉待结算记录避免积压
          pendingBash.clear();
          pendingEdits.clear();
          return;
        }

        // bash 结算
        if (pendingBash.has(event.toolCallId)) {
          const command = pendingBash.get(event.toolCallId);
          pendingBash.delete(event.toolCallId);
          if (config.scope === 'files') return;
          if (event.isError) return;
          const base = baseFields(ctx);
          if (!base) return;
          await runCheckpoint(
            {
              type: 'post_shell_command',
              ...base,
              agent_name: GIT_AI_AGENT_NAME,
              tool_use_id: event.toolCallId,
              command,
              tool_result: {
                content: event.content,
                isError: event.isError
              }
            },
            effectiveBin(config)
          );
          return;
        }

        // edit/write 结算
        const pending = pendingEdits.get(event.toolCallId);
        if (!pending) return;
        pendingEdits.delete(event.toolCallId);
        if (config.scope === 'shell') return;
        if (event.isError) return;

        const base = baseFields(ctx);
        if (!base) return;

        await runCheckpoint(
          {
            type: 'ai_agent',
            ...base,
            agent_name: GIT_AI_AGENT_NAME,
            edited_filepaths: pending.filepaths,
            dirty_files: await readDirtyFiles(pending.filepaths),
            tool_input: pending.toolInput,
            tool_result: {
              content: event.content,
              isError: event.isError
            }
          },
          effectiveBin(config)
        );
      });
    }
  };
}
