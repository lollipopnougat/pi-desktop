/**
 * GoalController:主进程侧桥接 IPC 与 GoalRuntime + 渲染进程推送。
 *
 * - 持有 GoalRuntime(状态机,纯逻辑)
 * - 实现 GoalRuntimeHost(访问 SDK session)
 * - 接收 goal-ipc 的指令(create/pause/resume/clear/edit/get)
 * - 把状态快照推到渲染进程(pi:goalUpdate)
 *
 * 注意:控制器不直接调 SDK 扩展 API(pi.on/registerTool),
 * 那些在 goalExtensionFactory 里注册。控制器通过 runtime 管状态,
 * 扩展钩子通过 controller 读写状态。
 */
import type { PiBridge } from '../pi-bridge';
import { GoalRuntime, DEFAULT_GOAL_CONFIG, type GoalRuntimeConfig } from './runtime';
import type { ActiveGoal, GoalStatus } from './persistence';
import { buildContinuePrompt } from './prompts';

export interface GoalEvent {
  goalMessageTimestamp: number;
  completedMessageTimestamp?: number;
  completedTimeUsed?: number;
  status: string;
}

export interface GoalSnapshot {
  goal: {
    id: string;
    text: string;
    status: GoalStatus;
    tokensUsed: number;
    tokenBudget?: number;
    timeUsedSeconds: number;
    iteration: number;
    automaticModelTurns: number;
    safetyPauseCause?: 'continuation_limit' | 'no_progress';
    goalMessageTimestamp?: number;
    completedMessageTimestamp?: number;
    completedTimeUsed?: number;
  } | null;
  remainingTokens: number | null;
  mode: 'active' | 'exiting' | 'none';
  /** 所有目标事件(用于消息标记匹配,支持多目标) */
  goalHistory: GoalEvent[];
}

export class GoalController {
  private piBridge: PiBridge;
  private runtime: GoalRuntime;
  private config: GoalRuntimeConfig = { ...DEFAULT_GOAL_CONFIG };

  constructor(piBridge: PiBridge) {
    this.piBridge = piBridge;
    this.runtime = new GoalRuntime(
      {
        getCurrentUsage: () => this.getCurrentUsage(),
        getBranchEntries: () => this.getBranchEntries(),
        persistGoal: (goal) => this.persistGoal(goal),
        emitUpdate: () => this.emitUpdate()
      },
      this.config
    );
  }

  get rt(): GoalRuntime {
    return this.runtime;
  }

  // ─── GoalRuntimeHost 实现 ───

  private getCurrentUsage() {
    try {
      const stats = this.piBridge.getSession()?.getSessionStats?.();
      if (!stats?.tokens) return null;
      return {
        input: stats.tokens.input ?? 0,
        output: stats.tokens.output ?? 0,
        cacheRead: stats.tokens.cacheRead ?? 0,
        cacheWrite: stats.tokens.cacheWrite ?? 0
      };
    } catch {
      return null;
    }
  }

  private getBranchEntries(): any[] {
    try {
      const sm = this.piBridge.getSession()?.sessionManager;
      if (!sm) return [];
      // ReadonlySessionManager.getBranch()
      return sm.getBranch?.() ?? sm.getEntries?.() ?? [];
    } catch {
      return [];
    }
  }

  private persistGoal(goal: ActiveGoal | null): void {
    try {
      const session = this.piBridge.getSession();
      if (!session) return;
      const sm = session.sessionManager;
      if (!sm) return;
      const data = goal ? { goal: this.serializeForPersist(goal) } : { goal: null };
      // appendCustomEntry(customType, data) — 不参与 LLM 上下文
      if (typeof sm.appendCustomEntry === 'function') {
        sm.appendCustomEntry('goal-state', data);
      }
    } catch (e) {}
  }

  private serializeForPersist(goal: ActiveGoal) {
    const {
      id,
      text,
      status,
      startedAt,
      updatedAt,
      iteration,
      tokenBudget,
      tokensUsed,
      timeUsedSeconds,
      baselineTokens,
      automaticModelTurns,
      toolFreeRepeatCount,
      lastToolFreeOutputFingerprint,
      safetyPauseCause,
      goalMessageTimestamp,
      completedMessageTimestamp,
      completedTimeUsed
    } = goal;
    return {
      id,
      text,
      status,
      startedAt,
      updatedAt,
      iteration,
      tokenBudget,
      tokensUsed,
      timeUsedSeconds,
      baselineTokens,
      automaticModelTurns,
      toolFreeRepeatCount,
      lastToolFreeOutputFingerprint,
      safetyPauseCause,
      goalMessageTimestamp,
      completedMessageTimestamp,
      completedTimeUsed
    };
  }

  private emitUpdate(): void {
    const snap = this.getSnapshot();
    this.piBridge.sendSessionEvent('pi:goalUpdate', snap);
  }

  // ─── IPC 指令(供 goal-ipc 调用) ───

  createGoal(text: string, tokenBudget?: number): boolean {
    // 进入 goal 前先退出 plan(互斥)
    this.piBridge.setPlanMode(false);
    const goal = this.runtime.createGoal(text, tokenBudget);
    this.refreshGoalToolVisibility();
    return goal !== null;
  }

  pauseGoal(): void {
    this.runtime.pauseGoal();
    // 暂停时立即中断当前正在运行的 turn
    try {
      this.piBridge.getSession()?.abort();
    } catch {}
    this.refreshGoalToolVisibility();
  }

  resumeGoal(): void {
    this.runtime.resumeGoal();
    this.refreshGoalToolVisibility();
    // 恢复后触发续跑,重新启动自治循环
    this.triggerContinuation();
  }

  /** 触发一次续跑(用于 resume / 激活后启动自治循环) */
  private triggerContinuation(): void {
    const rt = this.runtime;
    if (!rt.goal || rt.goal.status !== 'active') return;
    // 如果 agent 正在跑,不重复触发
    try {
      const session = this.piBridge.getSession();
      if (!session || session.isStreaming) return;
    } catch {
      return;
    }
    rt.requestContinuation((_goal: any, marker: string) => {
      return buildContinuePrompt(rt.goal!, marker);
    });
    // 直接派发(session idle 时)
    const prompt = rt.dispatchContinuation(true, false);
    if (prompt) {
      try {
        this.piBridge.getSession().sendUserMessage(prompt, { deliverAs: 'followUp' });
      } catch {}
    }
  }

  clearGoal(): void {
    this.runtime.clearGoal();
    // 清除时立即中断当前正在运行的 turn
    try {
      this.piBridge.getSession()?.abort();
    } catch {}
    this.refreshGoalToolVisibility();
  }

  editGoal(text?: string, tokenBudget?: number | null): boolean {
    const g = this.runtime.editGoal(text, tokenBudget);
    return g !== null;
  }

  /** 目标完成时,记录最后一条 assistant 消息 timestamp(供 UI 显示完成标记) */
  markCompletedMessage(): void {
    const rt = this.runtime;
    if (!rt.goal) return;
    try {
      const msgs = this.piBridge.getSession()?.messages ?? [];
      const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
      if (lastAssistant) {
        rt.setCompletedMessage(lastAssistant.timestamp);
      }
    } catch {}
  }

  /** 根据当前 goal 状态调整 goal 工具可见性(有 active goal 时可见,否则隐藏) */
  refreshGoalToolVisibility(): void {
    try {
      const session = this.piBridge.getSession();
      if (!session) return;
      const current = session.getActiveToolNames() as string[];
      const allTools = (session.getAllTools?.() ?? []).map((t: any) => t.name);
      const goalTools = ['goal_complete', 'goal_blocked'];
      const registeredGoalTools = goalTools.filter((n) => allTools.includes(n));
      const hasActiveGoal =
        !!this.runtime.goal &&
        this.runtime.goal.status !== 'complete' &&
        this.runtime.goal.status !== 'blocked';
      let next: string[];
      if (hasActiveGoal) {
        next = [...new Set([...current, ...registeredGoalTools])];
      } else {
        next = current.filter((n) => !goalTools.includes(n));
      }
      const changed = next.length !== current.length || next.some((n, i) => n !== current[i]);
      if (changed) {
        session.setActiveToolsByName(next);
        // 验证是否真的生效
        const after = session.getActiveToolNames() as string[];
      }
    } catch (e) {}
  }

  /** 从 session entries 收集所有目标事件(用于消息标记匹配,支持多目标) */
  private getGoalHistory(): GoalEvent[] {
    try {
      const entries = this.getBranchEntries();
      const events: GoalEvent[] = [];
      for (const e of entries) {
        if (e && e.type === 'custom' && e.customType === 'goal-state') {
          const data = (e.data ?? e.content) as { goal: any } | undefined;
          const g = data?.goal;
          if (g && typeof g === 'object' && g.goalMessageTimestamp != null) {
            events.push({
              goalMessageTimestamp: g.goalMessageTimestamp,
              completedMessageTimestamp: g.completedMessageTimestamp,
              completedTimeUsed: g.completedTimeUsed,
              status: g.status
            });
          }
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  getSnapshot(): GoalSnapshot {
    const snap = this.runtime.snapshot() as GoalSnapshot;
    snap.goalHistory = this.getGoalHistory();
    return snap;
  }

  setConfig(config: Partial<GoalRuntimeConfig>): void {
    this.config = { ...this.config, ...config };
    this.runtime.setConfig(config);
  }

  /** 会话切换时调用 */
  onSessionSwitch(): void {
    // 真正切换会话:先清内存 goal,再从新会话恢复
    this.runtime.clearGoalStateOnly();
    this.runtime.loadFromSession();
    // 显式刷新 goal 工具可见性(无 active goal 时移除 goal_complete/goal_blocked)
    this.refreshGoalToolVisibility();
  }
}
