import { describe, it, expect } from 'vitest';
import {
  loadPlanStateFromEntries,
  PLAN_STATE_ENTRY_TYPE,
  type PlanPhase,
} from '../../electron/plan/persistence';

function makePlanEntry(phase: PlanPhase) {
  return {
    type: 'custom',
    customType: PLAN_STATE_ENTRY_TYPE,
    data: { phase },
  };
}

describe('loadPlanStateFromEntries', () => {
  it('returns "idle" for empty entries', () => {
    expect(loadPlanStateFromEntries([])).toBe('idle');
  });

  it('returns "idle" for entries with no plan-state entry', () => {
    expect(loadPlanStateFromEntries([{ type: 'text', content: 'hello' }])).toBe('idle');
  });

  it('restores "planning" phase from plan-state entry', () => {
    expect(loadPlanStateFromEntries([makePlanEntry('planning')])).toBe('planning');
  });

  it('restores "executing" phase from plan-state entry', () => {
    expect(loadPlanStateFromEntries([makePlanEntry('executing')])).toBe('executing');
  });

  it('restores "idle" phase from plan-state entry', () => {
    expect(loadPlanStateFromEntries([makePlanEntry('idle')])).toBe('idle');
  });

  it('uses the last plan-state entry when multiple exist', () => {
    const entries = [makePlanEntry('planning'), makePlanEntry('executing')];
    expect(loadPlanStateFromEntries(entries)).toBe('executing');
  });

  it('handles entries with content instead of data field', () => {
    const entries = [
      {
        type: 'custom',
        customType: PLAN_STATE_ENTRY_TYPE,
        content: { phase: 'planning' },
      },
    ];
    expect(loadPlanStateFromEntries(entries)).toBe('planning');
  });

  it('ignores invalid phase values and continues searching', () => {
    const entries = [
      makePlanEntry('planning'),
      {
        type: 'custom',
        customType: PLAN_STATE_ENTRY_TYPE,
        data: { phase: 'invalid_phase' },
      },
    ];
    // 最后一条 phase 无效 → 应回退到前一条有效的
    expect(loadPlanStateFromEntries(entries)).toBe('planning');
  });

  it('returns "idle" when all entries have invalid phases', () => {
    const entries = [
      {
        type: 'custom',
        customType: PLAN_STATE_ENTRY_TYPE,
        data: { phase: 'unknown' },
      },
    ];
    expect(loadPlanStateFromEntries(entries)).toBe('idle');
  });

  it('handles entry with missing data field', () => {
    const entries = [
      { type: 'custom', customType: PLAN_STATE_ENTRY_TYPE },
    ];
    expect(loadPlanStateFromEntries(entries)).toBe('idle');
  });

  it('handles entry with null data', () => {
    const entries = [
      { type: 'custom', customType: PLAN_STATE_ENTRY_TYPE, data: null },
    ];
    expect(loadPlanStateFromEntries(entries)).toBe('idle');
  });
});
