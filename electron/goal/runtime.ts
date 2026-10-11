/**
 * GoalRuntime:goal 模式的中枢状态机。
 *
 * 参考 pi-goal 的 cohesive 设计:continuation/记账/护栏共享同一组状态,
 * 避免拆散到多个模块导致不变量重复维护。
 *
 * 职责:
 * - 持有 activeGoal 与续跑票据
 * - agent run 归属判定(防用户插话被错计为 goal 续跑)
 * - token/墙钟记账(增量法)
 * - 安全护栏(automaticTurns / noProgressTurns 限额)
 *
 * 不直接访问 IPC / SDK,通过 host 接口解耦(便于测试)。
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import {
  type ActiveGoal,
  type GoalStatus,
  createGoal,
  serializeGoal,
  isTerminalGoalStatus,
  blocksToolCalls,
  loadGoalFromEntries
} from './persistence';

/** 续跑票据 */
interface ContinuationTicket {
  goalId: string;
  iteration: number;
  marker: string;
  prompt: string;
}

/** agent run 归属 */
interface AgentRunInfo {
  goalId: string | null;
  origin: 'manual' | 'automatic';
  toolAttempted: boolean;
  baselineUsage: TokenBaseline | null;
}

interface TokenBaseline {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 配置 */
export interface GoalRuntimeConfig {
  automaticTurns: number | null; // null = 不限额
  noProgressTurns: number | null;
}

export const DEFAULT_GOAL_CONFIG: GoalRuntimeConfig = {
  automaticTurns: 25,
  noProgressTurns: 3
};

/** 状态变更原因(供 host 决定是否持久化) */
export type GoalChangeReason = 'create' | 'status' | 'usage' | 'clear' | 'edit';

/** host 接口:runtime 通过它访问 SDK / IPC */
export interface GoalRuntimeHost {
  /** 取当前 session 的 token 累计统计 */
  getCurrentUsage(): TokenBaseline | null;
  /** 取当前会话分支的 session entries(用于恢复) */
  getBranchEntries(): any[];
  /** 持久化 goal-state custom entry */
  persistGoal(goal: ActiveGoal | null): void;
  /** 推状态快照到渲染进程 */
  emitUpdate(): void;
}

export class GoalRuntime {
  private activeGoal: ActiveGoal | null = null;
  private config: GoalRuntimeConfig = DEFAULT_GOAL_CONFIG;
  private host: GoalRuntimeHost;

  // 续跑票据(三层标记防竞态)
  private continuationIntent: ContinuationTicket | null = null;
  private continuationDelivery: ContinuationTicket | null = null;
  private cancelledContinuationMarkers = new Set<string>();
  private continuationDeferred = false; // fork/恢复后不立即自动跑

  // agent run 归属
  private currentRun: AgentRunInfo | null = null;

  // budget wrap-up
  private budgetWrapUpActive = false;

  constructor(host: GoalRuntimeHost, config?: Partial<GoalRuntimeConfig>) {
    this.host = host;
    if (config) this.config = { ...DEFAULT_GOAL_CONFIG, ...config };
  }

  // ─── 基础访问 ───

  get goal(): ActiveGoal | null {
    return this.activeGoal;
  }

  get hasActiveGoal(): boolean {
    return this.activeGoal !== null;
  }

  isGoalModeActive(): boolean {
    return this.activeGoal !== null;
  }

  setConfig(config: Partial<GoalRuntimeConfig>) {
    this.config = { ...this.config, ...config };
  }

  // ─── 目标生命周期 ───

  createGoal(text: string, tokenBudget?: number): ActiveGoal | null {
    // 仅当无未完成目标时才允许创建(complete 的会被新目标覆盖)
    if (this.activeGoal && this.activeGoal.status !== 'complete') {
      return null;
    }
    const goal = createGoal(text, tokenBudget);
    goal.baselineTokens = this.host.getCurrentUsage()?.input ?? 0;
    goal.goalMessageTimestamp = Date.now();
    this.activeGoal = goal;
    this.budgetWrapUpActive = false;
    this.continuationDeferred = false;
    this.cancelledContinuationMarkers.clear();
    this.persistAndEmit('create');
    return goal;
  }

  /** 状态迁移 */
  transitionGoal(requested: GoalStatus): ActiveGoal | null {
    if (!this.activeGoal) return null;
    const goal = this.activeGoal;
    // 请求 active 但预算已耗尽 → 自动降级 budget_limited
    if (requested === 'active' && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = 'budget_limited';
    } else {
      goal.status = requested;
    }
    goal.updatedAt = Date.now();
    if (goal.status === 'active') {
      goal.activeStartedAt = Date.now();
      this.continuationDeferred = false;
    } else {
      goal.activeStartedAt = undefined;
    }
    // 进入停止态时清理续跑票据
    if (isTerminalGoalStatus(goal.status)) {
      this.continuationIntent = null;
      this.continuationDelivery = null;
      // 完成时记录总用时
      if (goal.status === 'complete') {
        goal.completedTimeUsed = goal.timeUsedSeconds;
      }
    }
    this.persistAndEmit('status');
    return goal;
  }

  pauseGoal(): ActiveGoal | null {
    return this.transitionGoal('paused');
  }

  resumeGoal(): ActiveGoal | null {
    if (!this.activeGoal) return null;
    if (this.activeGoal.status === 'complete') return this.activeGoal;
    return this.transitionGoal('active');
  }

  clearGoal(): void {
    this.activeGoal = null;
    this.budgetWrapUpActive = false;
    this.continuationIntent = null;
    this.continuationDelivery = null;
    this.cancelledContinuationMarkers.clear();
    this.continuationDeferred = false;
    this.persistAndEmit('clear');
  }

  editGoal(text?: string, tokenBudget?: number | null): ActiveGoal | null {
    if (!this.activeGoal) return null;
    if (text !== undefined) this.activeGoal.text = text.trim();
    if (tokenBudget !== undefined) {
      this.activeGoal.tokenBudget = tokenBudget && tokenBudget > 0 ? tokenBudget : undefined;
    }
    this.activeGoal.updatedAt = Date.now();
    this.persistAndEmit('edit');
    return this.activeGoal;
  }

  // ─── 持久化与恢复 ───

  /** 仅清内存 goal 状态(会话切换前调用,不持久化不 emit) */
  clearGoalStateOnly(): void {
    this.activeGoal = null;
    this.budgetWrapUpActive = false;
    this.continuationIntent = null;
    this.continuationDelivery = null;
    this.cancelledContinuationMarkers.clear();
    this.continuationDeferred = false;
    this.currentRun = null;
  }

  /** 从 session entries 恢复(会话切换/启动时调用) */
  loadFromSession(): void {
    const entries = this.host.getBranchEntries();
    const restored = loadGoalFromEntries(entries);
    const customTypes = entries
      .filter((e: any) => e?.type === 'custom')
      .map((e: any) => e.customType);
    const hasGoalEntry = entries.some(
      (e: any) => e && e.type === 'custom' && e.customType === 'goal-state'
    );
    // 如果内存里已有 active goal,不要被 session 覆盖:
    // - session 无 entry:刚创建还没落盘
    // - session 有 entry 但 restored=null:可能是旧的 clear 记录,而内存是新创建的 goal
    // 只有内存无 goal 时才采纳 session 的 restored
    if (this.activeGoal && this.activeGoal.status !== 'complete') {
      this.host.emitUpdate();
      return;
    }
    this.activeGoal = restored;
    this.budgetWrapUpActive = false;
    this.continuationIntent = null;
    this.continuationDelivery = null;
    this.cancelledContinuationMarkers.clear();
    if (restored) {
      // fork/resume 恢复的 active goal 设 deferral,不立即自动跑
      if (restored.status === 'active') {
        this.continuationDeferred = true;
      }
    }
    this.host.emitUpdate();
  }

  private persistAndEmit(reason: GoalChangeReason): void {
    if (!this.activeGoal) {
      this.host.persistGoal(null);
    } else {
      // usage-only 变化不落盘(防写放大)
      if (reason === 'usage') {
        this.host.emitUpdate();
        return;
      }
      this.host.persistGoal(this.activeGoal);
    }
    this.host.emitUpdate();
  }

  /** 设置完成消息 timestamp(由 controller 在 goal_complete 后调用) */
  setCompletedMessage(timestamp: number): void {
    if (!this.activeGoal) return;
    this.activeGoal.completedMessageTimestamp = timestamp;
    this.persistAndEmit('status');
  }

  // ─── agent run 归属 ───

  /** agent run 开始时调用(before_agent_start) */
  beginAgentRun(origin: 'manual' | 'automatic'): void {
    const goalId = this.activeGoal?.id ?? null;
    this.currentRun = {
      goalId,
      origin,
      toolAttempted: false,
      baselineUsage: this.host.getCurrentUsage()
    };
  }

  /** 标记本轮动过工具 */
  markToolAttempted(): void {
    if (this.currentRun) this.currentRun.toolAttempted = true;
  }

  /** 当前 run 是否归属某 goal(防用户插话错计) */
  canRecordGoalUsage(): boolean {
    return this.currentRun?.goalId != null && this.currentRun.goalId === this.activeGoal?.id;
  }

  /** agent run 结束时调用(agent_end),返回是否应请求续跑 */
  finishAgentRun(): { shouldContinue: boolean } {
    const run = this.currentRun;
    if (!run || !this.activeGoal) {
      this.currentRun = null;
      return { shouldContinue: false };
    }

    // 记账(在清空 currentRun 之前 flush,确保拿到 baseline)
    this.flushUsage();
    this.currentRun = null;

    const goal = this.activeGoal;
    // 仅自动 run 计 automaticTurns
    if (run.origin === 'automatic' && goal.status === 'active') {
      goal.automaticModelTurns += 1;
      // 无进展检测
      this.updateNoProgressState(run);
    }

    // 安全限额检查
    if (goal.status === 'active') {
      const limited = this.checkSafetyLimits();
      if (limited) return { shouldContinue: false };
    }

    // budget wrap-up 期间不续跑(等模型收尾后 goal_complete 或停)
    if (this.budgetWrapUpActive) return { shouldContinue: false };

    const shouldContinue = goal.status === 'active' && !this.continuationDeferred;
    return { shouldContinue };
  }

  /** 重新classify 当前 run 为 manual(用户主动输入后) */
  reclassifyAsManual(): void {
    if (this.currentRun) {
      this.currentRun.origin = 'manual';
    }
  }

  // ─── 记账 ───

  /** 增量 flush token/墙钟(在 tool_execution_end / agent_end 调用) */
  flushUsage(): void {
    if (!this.activeGoal || !this.currentRun) return;
    const goal = this.activeGoal;
    if (goal.status !== 'active' && goal.status !== 'budget_limited') return;
    const current = this.host.getCurrentUsage();
    const baseline = this.currentRun.baselineUsage;
    if (!current || !baseline) return;

    const inputDelta = Math.max(0, current.input - baseline.input);
    const cacheWriteDelta = Math.max(0, current.cacheWrite - baseline.cacheWrite);
    const outputDelta = Math.max(0, current.output - baseline.output);
    const tokenDelta = inputDelta + cacheWriteDelta + outputDelta;
    // 不计入 cacheRead:缓存命中是复用前缀,不是新工作

    if (tokenDelta > 0) {
      goal.tokensUsed += tokenDelta;
      // 推进基线,避免重复累计
      this.currentRun.baselineUsage = { ...current };
      // 预算翻转检查
      if (
        goal.status === 'active' &&
        goal.tokenBudget != null &&
        goal.tokensUsed >= goal.tokenBudget
      ) {
        this.transitionToBudgetLimited();
      } else {
        this.persistAndEmit('usage');
      }
    }

    // 墙钟计时(仅 active)
    if (goal.status === 'active' && goal.activeStartedAt) {
      const now = Date.now();
      const elapsed = Math.floor((now - goal.activeStartedAt) / 1000);
      if (elapsed > 0) {
        goal.timeUsedSeconds += elapsed;
        // 前进 activeStartedAt 已结算的秒数(避免子秒漂移)
        goal.activeStartedAt += elapsed * 1000;
        this.persistAndEmit('usage');
      }
    }
  }

  private transitionToBudgetLimited(): void {
    if (!this.activeGoal) return;
    this.activeGoal.status = 'budget_limited';
    this.activeGoal.updatedAt = Date.now();
    this.activeGoal.activeStartedAt = undefined;
    this.budgetWrapUpActive = true;
    this.persistAndEmit('status');
  }

  /** budget wrap-up 是否激活(tool_call 拦截用) */
  isBudgetWrapUpActive(): boolean {
    return this.budgetWrapUpActive;
  }

  // ─── 安全限额 ───

  private checkSafetyLimits(): boolean {
    if (!this.activeGoal) return false;
    const goal = this.activeGoal;
    if (goal.status !== 'active') return false;

    if (
      this.config.automaticTurns != null &&
      goal.automaticModelTurns >= this.config.automaticTurns
    ) {
      this.pauseForSafety('continuation_limit');
      return true;
    }
    if (
      this.config.noProgressTurns != null &&
      goal.toolFreeRepeatCount >= this.config.noProgressTurns
    ) {
      this.pauseForSafety('no_progress');
      return true;
    }
    return false;
  }

  private pauseForSafety(cause: 'continuation_limit' | 'no_progress'): void {
    if (!this.activeGoal) return;
    this.activeGoal.status = 'paused';
    this.activeGoal.safetyPauseCause = cause;
    this.activeGoal.updatedAt = Date.now();
    this.activeGoal.activeStartedAt = undefined;
    this.continuationIntent = null;
    this.continuationDelivery = null;
    this.persistAndEmit('status');
  }

  /** 无进展检测:本轮没动工具且输出指纹重复 → toolFreeRepeatCount++ */
  private updateNoProgressState(run: AgentRunInfo): void {
    if (!this.activeGoal) return;
    const goal = this.activeGoal;
    if (run.toolAttempted) {
      goal.toolFreeRepeatCount = 0;
      goal.lastToolFreeOutputFingerprint = undefined;
      return;
    }
    // 无工具调用:取最后 assistant 文本指纹(由 setLastAssistantText 提供)
    const fp = this._lastAssistantFingerprint;
    if (fp && fp === goal.lastToolFreeOutputFingerprint) {
      goal.toolFreeRepeatCount += 1;
    } else {
      goal.toolFreeRepeatCount = 0;
      goal.lastToolFreeOutputFingerprint = fp;
    }
  }

  private _lastAssistantFingerprint?: string;
  setLastAssistantText(text: string | undefined): void {
    if (!text) {
      this._lastAssistantFingerprint = undefined;
      return;
    }
    this._lastAssistantFingerprint = createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  /** 用户主动输入后重置 safety epoch */
  resetSafetyEpoch(): void {
    if (!this.activeGoal) return;
    this.activeGoal.automaticModelTurns = 0;
    this.activeGoal.toolFreeRepeatCount = 0;
    this.reclassifyAsManual();
  }

  // ─── 续跑票据 ───

  /** 请求续跑(agent_end 正常结束时) */
  requestContinuation(buildPrompt: (goal: ActiveGoal, marker: string) => string): void {
    if (!this.activeGoal || this.activeGoal.status !== 'active') return;
    if (this.continuationDeferred) return;
    this.activeGoal.iteration += 1;
    const marker = `${this.activeGoal.id}:${this.activeGoal.iteration}:${randomUUID()}`;
    const prompt = buildPrompt(this.activeGoal, marker);
    this.continuationIntent = {
      goalId: this.activeGoal.id,
      iteration: this.activeGoal.iteration,
      marker,
      prompt
    };
  }

  /** agent_settled 时派发续跑(返回 followUp 文本,或 null 不续跑) */
  dispatchContinuation(isIdle: boolean, hasPendingMessages: boolean): string | null {
    if (!this.continuationIntent) return null;
    if (!this.activeGoal || this.activeGoal.status !== 'active') {
      this.continuationIntent = null;
      return null;
    }
    if (this.continuationDeferred) {
      this.continuationIntent = null;
      return null;
    }
    // 已有 delivery 未被认领时,不重复派发(防同一 followUp 多次投递)
    if (this.continuationDelivery) {
      return null;
    }
    if (!isIdle || hasPendingMessages) {
      // 不满足派发条件,保留 intent 等下次 settled
      return null;
    }
    const ticket = this.continuationIntent;
    this.continuationIntent = null;
    this.continuationDelivery = ticket;
    return ticket.prompt;
  }

  /** before_agent_start 时从 prompt 解析 marker 认领续跑 */
  claimContinuation(prompt: string): boolean {
    if (!this.continuationDelivery) return false;
    const m = prompt.match(/<!-- goal-continuation: ([\w:-]+) -->/);
    if (!m) return false;
    const marker = m[1];
    // 已取消的续跑(延迟投递的幽灵)→ 丢弃,返回 true 表示"这是我的续跑"
    if (this.cancelledContinuationMarkers.has(marker)) {
      this.cancelledContinuationMarkers.add(marker);
      this.continuationDelivery = null;
      return true;
    }
    if (marker === this.continuationDelivery.marker) {
      this.continuationDelivery = null;
      return true;
    }
    return false;
  }

  /** 取消当前续跑(用户 abort / 切走时) */
  cancelContinuation(): void {
    if (this.continuationDelivery) {
      this.cancelledContinuationMarkers.add(this.continuationDelivery.marker);
      this.continuationDelivery = null;
    }
    if (this.continuationIntent) {
      this.cancelledContinuationMarkers.add(this.continuationIntent.marker);
      this.continuationIntent = null;
    }
  }

  /** 清除 deferral(用户 resume 或发消息后) */
  clearDeferral(): void {
    this.continuationDeferred = false;
  }

  /** 判断输入文本是否是自己的续跑消息 */
  isOwnContinuation(text: string): boolean {
    return /<!-- goal-continuation: [\w:-]+ -->/.test(text);
  }

  /** 判断当前 goal 是否应拦截工具调用 */
  shouldBlockToolCall(toolName: string): boolean {
    if (!this.activeGoal) return false;
    // budget wrap-up:只允许 goal_complete
    if (this.budgetWrapUpActive && toolName !== 'goal_complete') return true;
    // 停止态拦截残留工具
    if (blocksToolCalls(this.activeGoal.status)) return true;
    return false;
  }

  /** 序列化当前状态(供 emitUpdate) */
  snapshot() {
    if (!this.activeGoal) {
      return { goal: null, remainingTokens: null, mode: 'none' as const };
    }
    const g = this.activeGoal;
    const remaining = g.tokenBudget != null ? Math.max(0, g.tokenBudget - g.tokensUsed) : null;
    const mode = g.status === 'complete' ? ('exiting' as const) : ('active' as const);
    return {
      goal: serializeGoal(g),
      remainingTokens: remaining,
      mode
    };
  }
}
