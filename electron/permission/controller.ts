/**
 * PermissionController：权限沙箱闸门（主进程侧）。
 *
 * 不走 pi extension，直接链式包装 SDK Agent 的 beforeToolCall 钩子：
 * AgentSession 构造时会把 agent.beforeToolCall 安装为"转发到 extension runner"
 * 的钩子（agent-session.js _installAgentToolHooks），goal/plan/memory 内联扩展的
 * tool_call 拦截都依赖它。因此本控制器必须**包装**该钩子而不是覆盖：
 *
 *   原 agent.beforeToolCall (extension runner 转发)
 *     ↑ 被包装为：
 *   permission gate → 未拦截 → 调用原钩子（保留扩展拦截能力）
 *
 * 决策流（参考 pi-permission-system 的三态模型简化）：
 *   allow-all                → 放行（用户明确选择的 yolo，不做危险检测）
 *   classifier-auto          → 每次先由模型判定：safe 且置信度达标→放行，否则人工审批
 *                              （开了「默认放行工作目录写入」时，工作目录内的 write/edit 不调模型直接放行）
 *   reviewer-auto            → 每次起一个只读的评审员子会话（读对话转录 + 只读查证）判定：
 *                              allow→放行，deny→阻断；评审员不可用（超时/解析失败/未配模型/
 *                              命中风险地板/熔断）时按配置回退人工审批（默认）或拒绝
 *   ask-all / auto-safe      → 危险规则优先，其次会话授权，再检查 auto-safe 白名单
 *   其余                     → 推送审批请求到渲染进程，等待用户允许/拒绝
 *
 * 安全不变量：
 * - fail-closed：闸门内部异常 → block（而非放行）
 * - 决策模型的任何失败（未配模型/超时/stopReason 非 stop/未知等级/置信度不足）
 *   一律回退人工审批，绝不自动放行（见 classifier-gate.ts）
 * - 会话切换时清理挂起请求（拒绝而非悬空）
 * - classifier-auto 中白名单和会话授权均不能绕过模型，人工许可仅对本次调用生效；
 *   唯一例外是用户显式开启的「默认放行工作目录写入」（allowWriteInCwd，作用域与 auto-safe
 *   相同：必须在工作目录内、不能在家目录、不能落在 .git/.ssh 等敏感目录、不能经符号链接逃逸）
 * - ask-all / auto-safe 中，危险规则优先于会话授权和白名单
 * - reviewer-auto 中：评审员放行**不登记**会话级放行（否则第 5 档退化成 allow-all 子集）；
 *   命中「风险地板」类目与连续拒绝熔断时跳过评审员直接人工，不让自动判定为自己开脱
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PiBridge } from '../pi-bridge';
import type { SessionHost } from '../session-slot';
import {
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_REVIEWER_MAX_DENIALS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  checkDangerousToolCall,
  isPermissionPolicy,
  isSafeToolCall,
  isSafeWriteInCwd,
  normalizeClassifierApprovalConfig,
  normalizeReviewerApprovalConfig,
  summarizeToolInput,
  type AutoSafeConfig,
  type ClassifierApprovalConfig,
  type DangerousBashCheck,
  type PermissionPolicy,
  type ReviewerApprovalConfig
} from './policy';
import {
  buildApprovalState,
  classifyToolCall,
  type ClassifierRuntime,
  type ClassifierVerdict
} from './classifier-gate';
import { buildReviewRequest } from './reviewer/context';
import { buildReviewerSystemPrompt, reviewerPromptHash } from './reviewer/policy-prompt';
import { runReview } from './reviewer/review';
import {
  ReviewerSessionPool,
  createReviewerSession,
  type ReviewerSessionLike
} from './reviewer/session-pool';
import type { ReviewerVerdict } from './reviewer/verdict';
import { describeArgs, logPermissionEvent, logToolEvent } from '../logs/channel-logs';

/** 各策略在提示文案里的简短说明（拒绝理由/审批面板用） */
const POLICY_SUMMARY: Record<PermissionPolicy, string> = {
  'ask-all': '每条指令均审批',
  'auto-safe': '自动审批安全指令',
  'classifier-auto': '决策模型自动审批',
  'reviewer-auto': '帮我审批',
  'allow-all': '允许所有指令'
};

/**
 * 「风险地板」：命中这些危险类目的调用**跳过评审员**，直接人工审批。
 *
 * 为什么不是「命中任何危险规则都跳过」：`destructive-remove`（rm -rf）与 `shell-escape`
 * 恰恰是评审员最能发挥作用的地方（「用户让清掉构建目录」vs「用户没提过删东西」）——
 * 一律踢回人工等于把第 5 档退化成 ask-all。但磁盘/设备级写入与系统级自修改是**不可逆**的，
 * 任何对话授权都不应让它们被自动放行。
 */
const REVIEWER_FLOOR_CATEGORIES = new Set(['disk-write', 'self-modify']);

/** 内存里保留多少条最近的评审记录（面板展示 + 切换会话后主动拉取） */
const MAX_RECENT_REVIEWS = 20;

/**
 * 评审员结论通知（渲染进程展示「刚才那次调用是被自动放行/拒绝的」）。
 *
 * 只展示结论与理由，不作为审批入口：自动放行/拒绝不需要用户点确认（这正是第 5 档的意义）。
 */
export interface PermissionReviewNotice {
  id: string;
  toolName: string;
  preview: string;
  /** allow/deny = 评审员给出了结论；fallback = 评审员不可用，已回退人工审批 */
  outcome: 'allow' | 'deny' | 'fallback';
  riskLevel?: ReviewerVerdict['riskLevel'];
  userAuthorization?: ReviewerVerdict['userAuthorization'];
  rationale?: string;
  /** fallback/异常时的原因说明（中文，直接展示） */
  note?: string;
  /** 代码层强制改写的痕迹（模型说 allow 但被硬约束改成 deny） */
  coerced?: ReviewerVerdict['coerced'];
  elapsedMs: number;
  at: number;
}

/** 推送给渲染进程的审批请求 */
export interface PermissionRequest {
  id: string;
  toolName: string;
  /** 命令/参数预览（截断后的展示文本） */
  preview: string;
  /** 请求时间戳 */
  requestedAt: number;
  /** 危险命令检测结果（命中 denylist 时非空：审批面板据此显示高风险警示） */
  danger?: DangerousBashCheck;
  /** classifier-auto 策略下的决策模型判定（模型不可用时也带 ok:false，面板展示回退原因） */
  classifier?: ClassifierVerdict;
  /** reviewer-auto 策略下回退人工时的原因（评审员不可用/超时/熔断/风险地板） */
  reviewerNote?: string;
}

/** 用户决策 */
export type PermissionDecision = 'allow' | 'deny';

/** 渲染进程回传的决策值（allow-session：本次会话内同名工具自动放行） */
export type PermissionResponseValue = PermissionDecision | 'allow-session';

interface PendingRequest {
  resolve: (decision: PermissionDecision) => void;
  /** 推给渲染进程的请求原文：切回本会话时用它重推（replayPending） */
  request: PermissionRequest;
  /** 挂起请求对应的工具名（allow-session 决策时用于登记会话级放行） */
  toolName: string;
  /** 由请求产生时的策略决定，模型审批只接受单次许可 */
  allowSession: boolean;
}

/** 归一化字符串数组：过滤非 string、去首尾空白、去空串 */
function normalizeArray(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 评审员拒绝时给模型的拒绝理由（必须包含「不要绕过」约束，否则模型会换招重试） */
function reviewerRejectionText(verdict: ReviewerVerdict): string {
  const level = verdict.riskLevel ? `风险等级 ${verdict.riskLevel}` : '风险不可接受';
  const auth = verdict.userAuthorization ? `，用户授权 ${verdict.userAuthorization}` : '';
  const reason = verdict.rationale ? `：${verdict.rationale}` : '';
  return (
    `「帮我审批」评审员拒绝了该操作（${level}${auth}）${reason}。` +
    '不要尝试用其它方式、间接执行或绕过策略来达到同一目的；' +
    '如果认为用户确实授权了该操作，请向用户说明后请其调整权限策略。'
  );
}

/** 评审结论的日志字段（不落 rationale 全文超长时截断） */
function reviewLogFields(verdict: ReviewerVerdict): Record<string, unknown> {
  return {
    reviewer: {
      ...(verdict.riskLevel ? { riskLevel: verdict.riskLevel } : {}),
      ...(verdict.userAuthorization ? { userAuthorization: verdict.userAuthorization } : {}),
      ...(verdict.coerced ? { coerced: verdict.coerced } : {})
    }
  };
}

/** SDK beforeToolCall 返回类型（最小结构） */
interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** 评审员判定结果：allow/deny 为明确结论；unavailable 表示没判出来（按 onFailure 处理） */
type ReviewDecision =
  | { kind: 'allow'; verdict: ReviewerVerdict }
  | { kind: 'deny'; verdict: ReviewerVerdict }
  | { kind: 'unavailable'; note: string; fallback: boolean };

export class PermissionController {
  private piBridge: PiBridge;
  /**
   * 会话访问面：控制器按会话槽创建，所以审批/分类必须看「自己这一槽」的 session 与 cwd。
   * （旧实现读 piBridge.session / piBridge.cwd = 焦点会话，多会话下会拿错项目边界）
   */
  private host: SessionHost;
  private policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY;
  /** auto-safe 自定义白名单（设置页配置，立即生效） */
  private autoSafeConfig: AutoSafeConfig = {};
  /** classifier-auto 决策模型配置（设置页配置，立即生效） */
  private classifierConfig: ClassifierApprovalConfig = {};
  /** 本会话内用户选择「本次会话允许」的工具名（内存态，不持久化；切换会话清空） */
  private sessionAllowedTools = new Set<string>();
  /** 挂起的审批请求（id → resolver） */
  private pending = new Map<string, PendingRequest>();
  /** 已包装过的 agent 实例（防重复包装） */
  private wrappedAgents = new WeakSet<object>();
  /** reviewer-auto 评审员配置（设置页配置，立即生效） */
  private reviewerConfig: ReviewerApprovalConfig = {};
  /** 槽级评审员会话池（复用 + 串行 + 随槽释放） */
  private readonly reviewerPool = new ReviewerSessionPool();
  /** 连续拒绝计数（熔断用；一次放行或一次人工允许即清零） */
  private consecutiveDenials = 0;
  /** 最近的评审结论（供面板在切换会话/刷新后主动拉取） */
  private recentReviews: PermissionReviewNotice[] = [];

  constructor(piBridge: PiBridge, host: SessionHost) {
    this.piBridge = piBridge;
    this.host = host;
  }

  getPolicy(): PermissionPolicy {
    return this.policy;
  }

  /** 挂起审批数（侧栏「等待审批」徽标用；不暴露具体请求） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 设置策略（立即生效，含流式中的下一次工具调用） */
  setPolicy(policy: string): PermissionPolicy {
    if (!isPermissionPolicy(policy)) {
      return this.policy;
    }
    this.policy = policy;
    return this.policy;
  }

  /** 应用启动时从 ui-config.json 恢复策略 */
  restorePolicy(saved: unknown): void {
    if (isPermissionPolicy(saved)) {
      this.policy = saved;
    }
  }

  /** 应用启动时从 ui-config.json 恢复 auto-safe 自定义白名单 */
  restoreAutoSafeConfig(config: unknown): void {
    if (!config || typeof config !== 'object') return;
    this.autoSafeConfig = {
      safeTools: normalizeArray((config as AutoSafeConfig).safeTools),
      safeBashCommands: normalizeArray((config as AutoSafeConfig).safeBashCommands)
    };
  }

  getAutoSafeConfig(): AutoSafeConfig {
    return this.autoSafeConfig;
  }

  /** 设置 auto-safe 自定义白名单（立即生效，含流式中的下一次工具调用） */
  setAutoSafeConfig(config: unknown): AutoSafeConfig {
    if (!config || typeof config !== 'object') return this.autoSafeConfig;
    this.autoSafeConfig = {
      safeTools: normalizeArray((config as AutoSafeConfig).safeTools),
      safeBashCommands: normalizeArray((config as AutoSafeConfig).safeBashCommands)
    };
    return this.autoSafeConfig;
  }

  /** 应用启动时从 ui-config.json 恢复决策模型审批配置 */
  restoreClassifierConfig(config: unknown): void {
    this.classifierConfig = normalizeClassifierApprovalConfig(config);
  }

  getClassifierConfig(): ClassifierApprovalConfig {
    return this.classifierConfig;
  }

  /** 设置决策模型审批配置（立即生效） */
  setClassifierConfig(config: unknown): ClassifierApprovalConfig {
    this.classifierConfig = normalizeClassifierApprovalConfig(config);
    return this.classifierConfig;
  }

  /** 应用启动时从 ui-config.json 恢复「帮我审批」评审员配置 */
  restoreReviewerConfig(config: unknown): void {
    this.reviewerConfig = normalizeReviewerApprovalConfig(config);
  }

  getReviewerConfig(): ReviewerApprovalConfig {
    return this.reviewerConfig;
  }

  /**
   * 设置评审员配置（立即生效）。模型/策略/工具集可能变了，所以必须丢弃复用中的
   * 评审员会话 —— 否则模型上下文里还是旧策略，判定会与设置页显示的不一致。
   */
  setReviewerConfig(config: unknown): ReviewerApprovalConfig {
    const next = normalizeReviewerApprovalConfig(config);
    const changed =
      next.providerId !== this.reviewerConfig.providerId ||
      next.modelId !== this.reviewerConfig.modelId ||
      next.extraPolicy !== this.reviewerConfig.extraPolicy ||
      next.readOnlyTools !== this.reviewerConfig.readOnlyTools;
    this.reviewerConfig = next;
    // 熔断状态跟随配置变化重置：改了阈值就该按新阈值重新计数
    this.consecutiveDenials = 0;
    if (changed) void this.reviewerPool.drop();
    return this.reviewerConfig;
  }

  /** 最近的评审结论（新的在前） */
  getRecentReviews(): PermissionReviewNotice[] {
    return [...this.recentReviews];
  }

  /** 释放评审员会话池（槽销毁 / PiBridge dispose） */
  async dispose(): Promise<void> {
    await this.reviewerPool.dispose();
  }

  /** 解析评审模型：显式配置优先，否则跟随当前会话模型 */
  private resolveReviewerModel(): { model: unknown; key: string } | null {
    const runtime = this.piBridge.modelRuntime as {
      getModel?: (providerId: string, modelId: string) => unknown;
    } | null;
    const { providerId, modelId } = this.reviewerConfig;
    if (providerId && modelId) {
      const model = runtime?.getModel?.(providerId, modelId);
      return model ? { model, key: `${providerId}/${modelId}` } : null;
    }
    const session = this.host.current() as {
      model?: { provider?: string; id?: string };
    } | null;
    const model = session?.model;
    if (!model) return null;
    return { model, key: `${model.provider ?? '?'}/${model.id ?? '?'}` };
  }

  /** 评审员可信证据：全局 + 项目的 AGENTS.md（读不到就当没有，不影响评审） */
  private reviewerAgentsMd(): string | undefined {
    const read = (file: string): string => {
      try {
        return readFileSync(file, 'utf8').trim();
      } catch {
        return '';
      }
    };
    const parts: string[] = [];
    const agentDir = this.piBridge.agentDir;
    if (agentDir) {
      const global = read(path.join(agentDir, 'AGENTS.md'));
      if (global) parts.push(`# 全局 AGENTS.md\n${global}`);
    }
    const cwd = this.host.cwd();
    if (cwd) {
      // 与 SDK 的项目 context 文件顺序一致：AGENTS.md 优先，CLAUDE.md 兜底
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const text = read(path.join(cwd, name));
        if (text) {
          parts.push(`# 项目 ${name}\n${text}`);
          break;
        }
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  /** classifier-auto：取工具描述 + 打包 state，调决策模型判危险等级（永不抛错） */
  private async classifyForApproval(
    toolName: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<ClassifierVerdict> {
    // 工具描述：SDK 的 ToolDefinition.description（模型据此理解工具是干什么的）
    let toolDescription: string | undefined;
    try {
      const session = this.host.current() as {
        getToolDefinition?: (name: string) => { description?: string } | undefined;
      } | null;
      toolDescription = session?.getToolDefinition?.(toolName)?.description;
    } catch {
      /* 描述取不到不影响判定，state 里会标记为缺失 */
    }
    return classifyToolCall({
      runtime: this.piBridge.modelRuntime as ClassifierRuntime | null,
      config: this.classifierConfig,
      state: buildApprovalState({ toolName, toolDescription, args: input, cwd: this.host.cwd() }),
      signal
    });
  }

  /** 推一条评审结论给渲染进程并记入最近列表 */
  private pushReviewNotice(notice: PermissionReviewNotice): void {
    this.recentReviews = [notice, ...this.recentReviews].slice(0, MAX_RECENT_REVIEWS);
    this.host.sendSessionEvent('pi:permissionReview', notice);
  }

  /**
   * reviewer-auto：起一个只读的评审员子会话判定这次工具调用。
   *
   * **永不抛错**：任何失败都降级为 `unavailable`，由调用方按 `onFailure` 回退人工或拒绝。
   * 这不是 fail-open：unavailable 从不自动放行。
   */
  private async reviewWithReviewer(
    toolName: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<ReviewDecision> {
    const startedAt = Date.now();
    const id = randomUUID();
    const preview = summarizeToolInput(toolName, input);
    const fallbackToHuman = (this.reviewerConfig.onFailure ?? 'ask-user') === 'ask-user';

    const emit = (
      outcome: PermissionReviewNotice['outcome'],
      extra: Partial<PermissionReviewNotice> = {}
    ): void => {
      this.pushReviewNotice({
        id,
        toolName,
        preview,
        outcome,
        elapsedMs: Date.now() - startedAt,
        at: Date.now(),
        ...extra
      });
    };

    /** 没判出来：按 onFailure 决定展示成「已回退人工」还是「直接拒绝」 */
    const unavailable = (note: string): ReviewDecision => {
      emit(fallbackToHuman ? 'fallback' : 'deny', {
        note,
        ...(fallbackToHuman ? {} : { rationale: note })
      });
      logPermissionEvent(
        {
          phase: 'review',
          id,
          tool: toolName,
          outcome: 'unavailable',
          note,
          fallback: fallbackToHuman
        },
        'warn'
      );
      return { kind: 'unavailable', note, fallback: fallbackToHuman };
    };

    // ① 风险地板：不可逆的系统/设备级写入不让评审员为自己开脱
    const danger = checkDangerousToolCall(toolName, input);
    if (danger && REVIEWER_FLOOR_CATEGORIES.has(danger.category)) {
      return unavailable(`该操作命中不可自动放行的危险类目（${danger.reason}）`);
    }

    // ② 熔断：连续拒绝达阈值就不再问评审员（避免同一个错一再放行/一再拒绝的往复）
    const limit = this.reviewerConfig.maxConsecutiveDenials ?? DEFAULT_REVIEWER_MAX_DENIALS;
    if (limit > 0 && this.consecutiveDenials >= limit) {
      return unavailable(`已连续拒绝 ${this.consecutiveDenials} 次，暂停自动评审`);
    }

    // ③ 模型：显式配置优先，否则跟随当前会话模型
    const resolved = this.resolveReviewerModel();
    if (!resolved) {
      return unavailable(
        this.reviewerConfig.providerId
          ? '评审模型不可用（未配置密钥或模型不存在）'
          : '当前会话没有可用模型，无法评审'
      );
    }

    const config = this.reviewerConfig;
    const cwd = this.host.cwd();
    const readOnlyTools = config.readOnlyTools !== false;
    const request = buildReviewRequest({
      action: { toolName, input, cwd, danger },
      messages: ((this.host.current() as { messages?: unknown[] } | null)?.messages ??
        []) as readonly unknown[],
      agentsMd: this.reviewerAgentsMd()
    });
    // 复用键含模型 + 策略指纹 + cwd + 工具集：任一变化都不能复用旧会话
    const sessionKey = [
      resolved.key,
      reviewerPromptHash(config.extraPolicy),
      cwd,
      readOnlyTools ? 'readonly' : 'plain'
    ].join('|');
    const pool = this.reviewerPool;
    const agentDir = this.piBridge.agentDir;

    let result: Awaited<ReturnType<typeof runReview>>;
    try {
      result = await runReview({
        runExclusive: (fn) => pool.runExclusive(fn),
        acquire: () =>
          pool.acquire(sessionKey, () =>
            createReviewerSession({
              cwd,
              agentDir,
              modelRuntime: this.piBridge.modelRuntime,
              model: resolved.model,
              systemPrompt: buildReviewerSystemPrompt(config.extraPolicy),
              readOnlyTools
            })
          ),
        drop: () => pool.drop(),
        userMessage: request.userMessage,
        timeoutMs: config.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
        signal
      });
    } catch (error) {
      return unavailable(
        `评审员调用异常：${error instanceof Error ? error.message : String(error)}`
      );
    }

    const verdict = result.verdict;
    if (!verdict) {
      return unavailable(result.note ?? '评审员未能给出结论');
    }

    const detail = {
      ...(verdict.riskLevel ? { riskLevel: verdict.riskLevel } : {}),
      ...(verdict.userAuthorization ? { userAuthorization: verdict.userAuthorization } : {}),
      ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
      ...(verdict.coerced ? { coerced: verdict.coerced } : {}),
      model: resolved.key,
      attempts: result.attempts
    };

    if (verdict.outcome === 'allow') {
      this.consecutiveDenials = 0;
      emit('allow', detail);
      logPermissionEvent({ phase: 'review', id, tool: toolName, outcome: 'allow', ...detail });
      return { kind: 'allow', verdict };
    }

    this.consecutiveDenials += 1;
    emit('deny', detail);
    logPermissionEvent({ phase: 'review', id, tool: toolName, outcome: 'deny', ...detail }, 'warn');
    return { kind: 'deny', verdict };
  }

  /**
   * 在 session 上安装权限闸门（链式包装 agent.beforeToolCall）。
   * 在 PiBridge.createRuntimeFor 与 syncSession 之后调用。
   */ install(session: { agent: { beforeToolCall?: unknown } }): void {
    const agent = session?.agent;
    if (!agent || typeof (agent as any).beforeToolCall !== 'function') return;
    if (this.wrappedAgents.has(agent)) return; // 已包装（防重复）

    const original = (agent as any).beforeToolCall.bind(agent);
    this.wrappedAgents.add(agent);

    (agent as any).beforeToolCall = async (
      context: { toolCall: { name: string }; args: unknown },
      signal?: AbortSignal
    ): Promise<BeforeToolCallResult | undefined> => {
      // ① 权限闸门先行
      const gate = await this.gate(context.toolCall.name, context.args, signal);
      if (gate) return gate; // { block: true, reason }
      // ② 未拦截 → 透传原钩子（extension runner，goal/plan 拦截仍生效）
      return original(context, signal);
    };
  }

  /** 闸门：返回 undefined 放行；返回 {block} 拒绝 */
  private async gate(
    toolName: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    const policy = this.policy;
    // 工具通道日志：闸门每一步的结论都落盘（谁放行的/为什么交给模型/为什么弹审批）
    const logGate = (
      decision: 'allow' | 'ask' | 'deny' | 'error',
      source: string,
      extra: Record<string, unknown> = {},
      level: 'debug' | 'info' | 'warn' = 'info'
    ) =>
      logToolEvent(
        {
          phase: 'gate',
          policy,
          tool: toolName,
          args: describeArgs(input),
          decision,
          source,
          ...extra
        },
        level
      );
    try {
      if (signal?.aborted) {
        logGate('deny', 'aborted');
        return { block: true, reason: '工具调用已取消。' };
      }
      if (policy === 'allow-all') {
        logGate('allow', 'policy-allow-all', {}, 'debug');
        return undefined;
      }
      let classifier: ClassifierVerdict | undefined;
      // reviewer-auto 回退人工时带给面板的原因（超时/未配模型/熔断/风险地板）
      let reviewerNote: string | undefined;
      if (policy === 'classifier-auto') {
        // 用户显式开启「默认放行工作目录写入」：工作目录内的 write/edit 直接放行，不调模型。
        // 动机：判定所需的 arguments 会被按长度截断（classifier-gate 的 MAX_ARGS_CHARS），
        // 大型文件写入因此常常被判为 risky / 无法确认，反而每次都要人工点一下。
        // 开关关闭时行为不变；开启时也只在 isSafeWriteInCwd 认可的范围（项目内、非敏感目录）内生效。
        if (
          this.classifierConfig.allowWriteInCwd &&
          isSafeWriteInCwd(toolName, input, this.host.cwd())
        ) {
          logGate('allow', 'classifier-write-in-cwd');
          return undefined;
        }
        // 其余情况每次调用先交模型，白名单、危险规则和已有会话授权均不短路此分支。
        classifier = await this.classifyForApproval(toolName, input, signal);
        if (signal?.aborted) {
          logGate('deny', 'aborted');
          return { block: true, reason: '工具调用已取消。' };
        }
        logGate(
          classifier.autoAllowed ? 'allow' : 'ask',
          classifier.autoAllowed ? 'classifier-safe' : 'classifier-ask',
          {
            classifier: {
              ok: classifier.ok,
              ...(classifier.level ? { level: classifier.level } : {}),
              ...(typeof classifier.confidence === 'number'
                ? { confidence: classifier.confidence }
                : {}),
              ...(classifier.note ? { note: classifier.note } : {})
            }
          }
        );
        if (classifier.autoAllowed) return undefined;
      } else if (policy === 'reviewer-auto') {
        // 已知安全的调用不跑评审员：否则每一次 read / ls / git status 都要一次模型往返，
        // 「帮我审批」会慢到不可用。语义上第 5 档是把「本来会问用户的那些调用」交给评审员，
        // 而不是把白名单也一起重新审一遍（Codex 里沙箱允许的操作同样进不了 Guardian）。
        //
        // 但**危险规则优先级最高**：已判定危险的调用即使在本会话放行过也不短路
        // （与 ask-all / auto-safe 的分支顺序一致）。非地板的危险类目仍交评审员判断，
        // 不能因为「在白名单里」就放行。
        const danger = checkDangerousToolCall(toolName, input);
        if (!danger) {
          if (this.sessionAllowedTools.has(toolName)) {
            logGate('allow', 'session-allow');
            return undefined;
          }
          if (isSafeToolCall(toolName, input, this.autoSafeConfig, this.host.cwd())) {
            logGate('allow', 'static-whitelist');
            return undefined;
          }
        }
        const reviewed = await this.reviewWithReviewer(toolName, input, signal);
        if (signal?.aborted) {
          logGate('deny', 'aborted');
          return { block: true, reason: '工具调用已取消。' };
        }
        if (reviewed.kind === 'allow') {
          logGate('allow', 'reviewer-allow', reviewLogFields(reviewed.verdict));
          return undefined;
        }
        if (reviewed.kind === 'deny') {
          logGate('deny', 'reviewer-deny', reviewLogFields(reviewed.verdict));
          return { block: true, reason: reviewerRejectionText(reviewed.verdict) };
        }
        // 没判出来：配置为直接拒绝时不弹面板；否则带着原因回退人工
        if (!reviewed.fallback) {
          logGate('deny', 'reviewer-unavailable', { note: reviewed.note }, 'warn');
          return {
            block: true,
            reason: `评审员不可用，且当前配置为直接拒绝：${reviewed.note}。如需继续，请向用户说明或调整权限策略。`
          };
        }
        logGate('ask', 'reviewer-ask', { note: reviewed.note });
        reviewerNote = reviewed.note;
      } else {
        // ask-all / auto-safe 保留危险规则优先，不能被会话授权或白名单覆盖。
        const danger = checkDangerousToolCall(toolName, input);
        if (danger) {
          logGate('ask', 'static-denylist', { danger });
        } else if (this.sessionAllowedTools.has(toolName)) {
          logGate('allow', 'session-allow');
          return undefined;
        } else if (
          policy === 'auto-safe' &&
          isSafeToolCall(toolName, input, this.autoSafeConfig, this.host.cwd())
        ) {
          logGate('allow', 'static-whitelist');
          return undefined;
        }
      }

      // ask-all / auto-safe 中的非安全调用 / classifier-auto 未放行 / reviewer-auto 回退
      // → 请求用户审批
      const decision = await this.requestApproval(
        toolName,
        input,
        signal,
        classifier,
        reviewerNote
      );
      logGate(decision === 'allow' ? 'allow' : 'deny', 'user');
      if (decision === 'allow') return undefined;
      return {
        block: true,
        reason: `用户拒绝了该操作（权限策略：${POLICY_SUMMARY[policy]}）。如需继续，请向用户说明或调整权限策略。`
      };
    } catch (err) {
      // fail-closed：闸门异常 → 阻断而非放行
      logGate('error', 'gate-error', { error: err }, 'warn');
      return {
        block: true,
        reason: `权限闸门错误（fail-closed，已阻断）：${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  /** 推送审批请求并等待用户响应（classifier：决策模型判定结果，reviewerNote：评审回退原因） */
  private requestApproval(
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
    classifier?: ClassifierVerdict,
    reviewerNote?: string
  ): Promise<PermissionDecision> {
    if (signal?.aborted) return Promise.resolve('deny');
    return new Promise<PermissionDecision>((resolve) => {
      const id = randomUUID();
      // 人工审批请求附带危险提示。
      const danger = checkDangerousToolCall(toolName, input) ?? undefined;
      const request: PermissionRequest = {
        id,
        toolName,
        preview: summarizeToolInput(toolName, input),
        requestedAt: Date.now(),
        ...(danger ? { danger } : {}),
        ...(classifier ? { classifier } : {}),
        ...(reviewerNote ? { reviewerNote } : {})
      };

      const settle = (decision: PermissionDecision) => {
        this.pending.delete(id);
        cleanup();
        resolve(decision);
      };

      // abort（用户点停止）→ 视为拒绝
      const onAbort = () => settle('deny');
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      this.pending.set(id, {
        resolve: settle,
        toolName,
        allowSession: classifier === undefined,
        request
      });
      logPermissionEvent({
        phase: 'request',
        id,
        tool: toolName,
        policy: this.policy,
        preview: request.preview,
        ...(danger ? { danger } : {}),
        ...(classifier
          ? {
              classifier: {
                ok: classifier.ok,
                ...(classifier.level ? { level: classifier.level } : {}),
                ...(typeof classifier.confidence === 'number'
                  ? { confidence: classifier.confidence }
                  : {}),
                ...(classifier.note ? { note: classifier.note } : {})
              }
            }
          : {})
      });
      const win = this.piBridge.win;
      if (!win || win.isDestroyed()) {
        // 无窗口可用：缺权威 → 拒绝（最小权限，"用户从未被问过"≠允许）
        logPermissionEvent(
          { phase: 'decision', id, tool: toolName, decision: 'deny', reason: 'no-window' },
          'warn'
        );
        settle('deny');
        return;
      }
      // 走本槽的 host 推送：事件带本槽身份，渲染端按「焦点会话」过滤——后台槽的审批不会
      // 顶掉焦点会话的面板（侧栏 pendingApprovals 会亮），用户切过去时由 replayPending 重推。
      // 回传决策按请求 id 找回本槽（PiBridge.resolvePermissionRequest）。
      if (!this.host.sendSessionEvent('pi:permissionRequest', request)) settle('deny');
      // 挂起直至 pi:permissionResponse 或 abort
    });
  }

  /** 渲染进程回传审批决策。模型审批中的 allow-session 降为单次许可。 */
  resolvePermission(id: string, decision: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      // 挂起请求已不在（会话切换清理 / 重复点击 / 陈旧 id）：记一行便于排查
      logPermissionEvent(
        { phase: 'decision', id, decision: String(decision), applied: false },
        'warn'
      );
      return false;
    }
    const effectiveDecision =
      decision === 'allow-session' && !pending.allowSession ? 'allow' : decision;
    logPermissionEvent({
      phase: 'decision',
      id,
      tool: pending.toolName,
      decision: String(effectiveDecision),
      applied: true
    });
    if (effectiveDecision === 'allow-session') {
      this.sessionAllowedTools.add(pending.toolName);
      // 人工放行也算进展：清零熔断计数，避免面板里连续点几次允许后仍被锁在人工
      this.consecutiveDenials = 0;
      pending.resolve('allow');
    } else {
      if (effectiveDecision === 'allow') this.consecutiveDenials = 0;
      pending.resolve(effectiveDecision === 'allow' ? 'allow' : 'deny');
    }
    return true;
  }

  /** 本会话已登记「本次会话允许」的工具名列表（供 UI 展示） */
  getSessionAllowedTools(): string[] {
    return [...this.sessionAllowedTools];
  }

  /** 清空会话级放行（恢复逐次审批） */
  clearSessionAllowedTools(): void {
    this.sessionAllowedTools.clear();
  }

  /** 首个挂起的审批请求原文（渲染端刷新会话状态后主动拉取面板用） */
  firstPendingRequest(): PermissionRequest | null {
    for (const pending of this.pending.values()) {
      return pending.request;
    }
    return null;
  }

  /** 切回本会话时把挂起的审批重新推给渲染进程（后台期间的推送被渲染端按会话过滤丢掉） */
  replayPending(): void {
    for (const pending of this.pending.values()) {
      this.host.sendSessionEvent('pi:permissionRequest', pending.request);
    }
  }

  /** 会话切换/关闭时清空挂起请求与「本次会话允许」状态（挂起请求全部按拒绝结算） */
  clearPending(): void {
    for (const p of this.pending.values()) {
      p.resolve('deny');
    }
    this.pending.clear();
    this.sessionAllowedTools.clear();
    // 熔断计数随会话切换/重建重置：换了一个上下文，旧账不应继续挂在这个会话上
    this.consecutiveDenials = 0;
  }

  /** 测试专用：暴露私有 gate（避免测试绕过 beforeToolCall 包装直接驱动决策流） */
  gateForTest(toolName: string, input: unknown, signal?: AbortSignal) {
    return this.gate(toolName, input, signal);
  }
}
