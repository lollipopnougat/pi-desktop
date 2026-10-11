/**
 * Goal 模式数据模型与持久化。
 *
 * 设计参考 pi-goal / oh-my-pi:
 * - ActiveGoal:goal 的完整运行时状态
 * - GoalStatus:状态机(active/paused/blocked/budget_limited/complete)
 * - goal-state custom entry:序列化到 session 分支,跟随重载/分叉/压缩
 */
import { randomUUID } from 'crypto';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';

export interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  /** 每次自动续跑 +1 */
  iteration: number;
  /** 可选 token 预算硬上限(正整数) */
  tokenBudget?: number;
  /** 累计已用 token(只增不减) */
  tokensUsed: number;
  /** 累计已用墙钟秒数 */
  timeUsedSeconds: number;
  /** 激活时基线 token,跨 run 记账 */
  baselineTokens: number;
  /** active 计时起点(ms) */
  activeStartedAt?: number;
  /** 自动轮次计数(仅自动 run 计,对 automaticTurns 限额) */
  automaticModelTurns: number;
  /** 无进展轮次计数(对 noProgressTurns 限额) */
  toolFreeRepeatCount: number;
  /** 上一轮无工具调用的 assistant 输出指纹(sha256 前 16 位) */
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: 'continuation_limit' | 'no_progress';
  /** 目标对应的首条用户消息 timestamp(发送目标那条) */
  goalMessageTimestamp?: number;
  /** 目标完成时最后一条 assistant 消息 timestamp */
  completedMessageTimestamp?: number;
  /** 目标完成总用时(秒) */
  completedTimeUsed?: number;
}

/** 序列化到 session entry 的结构(剔除运行时临时字段) */
export interface SerializedGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  automaticModelTurns: number;
  toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: 'continuation_limit' | 'no_progress';
  goalMessageTimestamp?: number;
  completedMessageTimestamp?: number;
  completedTimeUsed?: number;
}

/** goal-state custom entry 的 canonical 数据 */
export interface GoalStateEntry {
  goal: SerializedGoal | null;
}

export const GOAL_STATE_ENTRY_TYPE = 'goal-state';

/** 终止性:除 active 外都不自动续跑 */
export function isTerminalGoalStatus(s: GoalStatus): boolean {
  return s !== 'active';
}

/** 是否拦截残留工具调用(paused/blocked 需拦截) */
export function blocksToolCalls(s: GoalStatus): boolean {
  return s === 'paused' || s === 'blocked';
}

/** 创建新目标 */
export function createGoal(text: string, tokenBudget?: number): ActiveGoal {
  const now = Date.now();
  return {
    id: randomUUID(),
    text: text.trim(),
    status: 'active',
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    tokenBudget: tokenBudget && tokenBudget > 0 ? tokenBudget : undefined,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    activeStartedAt: now
  };
}

/** 序列化(剔除 activeStartedAt 等临时字段) */
export function serializeGoal(goal: ActiveGoal): SerializedGoal {
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

/** 反序列化 + 规整(恢复时重置 activeStartedAt、清理非法字段) */
export function deserializeGoal(data: unknown): ActiveGoal | null {
  if (!data || typeof data !== 'object') return null;
  const g = data as Partial<SerializedGoal>;
  if (
    typeof g.id !== 'string' ||
    typeof g.text !== 'string' ||
    typeof g.status !== 'string' ||
    !['active', 'paused', 'blocked', 'budget_limited', 'complete'].includes(g.status)
  ) {
    return null;
  }
  const now = Date.now();
  return {
    id: g.id,
    text: g.text,
    status: g.status as GoalStatus,
    startedAt: typeof g.startedAt === 'number' ? g.startedAt : now,
    updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : now,
    iteration: typeof g.iteration === 'number' ? g.iteration : 0,
    tokenBudget: typeof g.tokenBudget === 'number' && g.tokenBudget > 0 ? g.tokenBudget : undefined,
    tokensUsed: typeof g.tokensUsed === 'number' ? g.tokensUsed : 0,
    timeUsedSeconds: typeof g.timeUsedSeconds === 'number' ? g.timeUsedSeconds : 0,
    baselineTokens: typeof g.baselineTokens === 'number' ? g.baselineTokens : 0,
    automaticModelTurns: typeof g.automaticModelTurns === 'number' ? g.automaticModelTurns : 0,
    toolFreeRepeatCount: typeof g.toolFreeRepeatCount === 'number' ? g.toolFreeRepeatCount : 0,
    lastToolFreeOutputFingerprint: g.lastToolFreeOutputFingerprint,
    safetyPauseCause: g.safetyPauseCause,
    goalMessageTimestamp:
      typeof g.goalMessageTimestamp === 'number' ? g.goalMessageTimestamp : undefined,
    completedMessageTimestamp:
      typeof g.completedMessageTimestamp === 'number' ? g.completedMessageTimestamp : undefined,
    completedTimeUsed: typeof g.completedTimeUsed === 'number' ? g.completedTimeUsed : undefined,
    // 恢复时 active 重新计时;停止态不计时
    activeStartedAt: g.status === 'active' ? now : undefined
  };
}

/** 从 session entries 找最后一条 goal-state canonical 条目并反序列化 */
export function loadGoalFromEntries(entries: any[]): ActiveGoal | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === 'custom' && e.customType === GOAL_STATE_ENTRY_TYPE) {
      const data = (e.data ?? e.content) as GoalStateEntry | undefined;
      const goal = data?.goal ?? null;
      // null goal = 已清除;返回 null 表示无活跃目标
      if (!goal) return null;
      const restored = deserializeGoal(goal);
      if (restored) {
        // complete 的目标也恢复(供 UI 显示完成标记),但不自动续跑
        return restored;
      }
    }
  }
  return null;
}
