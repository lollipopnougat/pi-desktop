/**
 * Plan 模式数据模型与持久化。
 *
 * 与 goal-state 一致,用 plan-state custom entry 序列化到 session 分支,
 * 跟随重载/分叉/压缩(custom entry 不参与 LLM 上下文、压缩保留)。
 */
export type PlanPhase = 'idle' | 'planning' | 'executing';

export interface PlanStateData {
  phase: PlanPhase;
}

export const PLAN_STATE_ENTRY_TYPE = 'plan-state';

/** 从 session entries 找最后一条 plan-state entry,恢复 phase */
export function loadPlanStateFromEntries(entries: any[]): PlanPhase {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === 'custom' && e.customType === PLAN_STATE_ENTRY_TYPE) {
      const data = (e.data ?? e.content) as PlanStateData | undefined;
      if (data && typeof data === 'object' && typeof data.phase === 'string') {
        if (data.phase === 'planning' || data.phase === 'executing' || data.phase === 'idle') {
          return data.phase;
        }
      }
    }
  }
  return 'idle';
}
