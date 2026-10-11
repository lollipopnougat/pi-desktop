import { describe, it, expect } from 'vitest';
import {
  type GoalStatus,
  type SerializedGoal,
  createGoal,
  serializeGoal,
  deserializeGoal,
  loadGoalFromEntries,
  isTerminalGoalStatus,
  blocksToolCalls,
  GOAL_STATE_ENTRY_TYPE,
} from '../../electron/goal/persistence';

// ─── createGoal ───

describe('createGoal', () => {
  it('creates an active goal with trimmed text', () => {
    const goal = createGoal('  hello world  ');
    expect(goal.text).toBe('hello world');
    expect(goal.status).toBe('active');
    expect(goal.id).toBeTruthy();
    expect(goal.iteration).toBe(0);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.timeUsedSeconds).toBe(0);
    expect(goal.baselineTokens).toBe(0);
    expect(goal.automaticModelTurns).toBe(0);
    expect(goal.toolFreeRepeatCount).toBe(0);
    expect(goal.activeStartedAt).toBeDefined();
  });

  it('sets tokenBudget when positive', () => {
    const goal = createGoal('test', 5000);
    expect(goal.tokenBudget).toBe(5000);
  });

  it('ignores zero or negative tokenBudget', () => {
    expect(createGoal('test', 0).tokenBudget).toBeUndefined();
    expect(createGoal('test', -1).tokenBudget).toBeUndefined();
  });

  it('generates unique ids', () => {
    const a = createGoal('a');
    const b = createGoal('b');
    expect(a.id).not.toBe(b.id);
  });
});

// ─── serializeGoal / deserializeGoal round-trip ───

describe('serializeGoal → deserializeGoal round-trip', () => {
  it('preserves all fields except activeStartedAt', () => {
    const goal = createGoal('test goal', 10000);
    goal.tokensUsed = 3000;
    goal.timeUsedSeconds = 120;
    goal.iteration = 5;
    goal.automaticModelTurns = 10;
    goal.toolFreeRepeatCount = 2;
    goal.lastToolFreeOutputFingerprint = 'abc123';
    goal.safetyPauseCause = 'continuation_limit';
    goal.goalMessageTimestamp = 1700000000000;
    goal.completedMessageTimestamp = 1700000001000;
    goal.completedTimeUsed = 60;

    const serialized = serializeGoal(goal);
    expect(serialized.activeStartedAt).toBeUndefined();

    const restored = deserializeGoal(serialized);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(goal.id);
    expect(restored!.text).toBe(goal.text);
    expect(restored!.status).toBe(goal.status);
    expect(restored!.tokensUsed).toBe(goal.tokensUsed);
    expect(restored!.timeUsedSeconds).toBe(goal.timeUsedSeconds);
    expect(restored!.iteration).toBe(goal.iteration);
    expect(restored!.tokenBudget).toBe(goal.tokenBudget);
    expect(restored!.automaticModelTurns).toBe(goal.automaticModelTurns);
    expect(restored!.toolFreeRepeatCount).toBe(goal.toolFreeRepeatCount);
    expect(restored!.lastToolFreeOutputFingerprint).toBe(goal.lastToolFreeOutputFingerprint);
    expect(restored!.safetyPauseCause).toBe(goal.safetyPauseCause);
    expect(restored!.goalMessageTimestamp).toBe(goal.goalMessageTimestamp);
    expect(restored!.completedMessageTimestamp).toBe(goal.completedMessageTimestamp);
    expect(restored!.completedTimeUsed).toBe(goal.completedTimeUsed);
    // active goal 恢复时 activeStartedAt 应被重置为当前时间
    expect(restored!.activeStartedAt).toBeDefined();
  });

  it('deserializeGoal restores activeStartedAt for active goals', () => {
    const goal = createGoal('active goal');
    const restored = deserializeGoal(serializeGoal(goal));
    expect(restored!.activeStartedAt).toBeDefined();
  });

  it('deserializeGoal does not set activeStartedAt for paused goals', () => {
    const goal = createGoal('paused goal');
    goal.status = 'paused';
    goal.activeStartedAt = undefined;
    const restored = deserializeGoal(serializeGoal(goal));
    expect(restored!.activeStartedAt).toBeUndefined();
  });

  it('deserializeGoal does not set activeStartedAt for complete goals', () => {
    const goal = createGoal('done goal');
    goal.status = 'complete';
    goal.activeStartedAt = undefined;
    const restored = deserializeGoal(serializeGoal(goal));
    expect(restored!.activeStartedAt).toBeUndefined();
  });
});

// ─── deserializeGoal validation ───

describe('deserializeGoal validation', () => {
  it('returns null for null/undefined', () => {
    expect(deserializeGoal(null)).toBeNull();
    expect(deserializeGoal(undefined)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(deserializeGoal('string')).toBeNull();
    expect(deserializeGoal(42)).toBeNull();
    expect(deserializeGoal(true)).toBeNull();
  });

  it('returns null for missing id', () => {
    expect(deserializeGoal({ text: 'x', status: 'active' })).toBeNull();
  });

  it('returns null for missing text', () => {
    expect(deserializeGoal({ id: 'x', status: 'active' })).toBeNull();
  });

  it('returns null for missing status', () => {
    expect(deserializeGoal({ id: 'x', text: 'y' })).toBeNull();
  });

  it('returns null for invalid status', () => {
    expect(
      deserializeGoal({ id: 'x', text: 'y', status: 'invalid' })
    ).toBeNull();
  });

  it('accepts all valid statuses', () => {
    const statuses: GoalStatus[] = ['active', 'paused', 'blocked', 'budget_limited', 'complete'];
    for (const s of statuses) {
      const restored = deserializeGoal({ id: 'x', text: 'y', status: s });
      expect(restored).not.toBeNull();
      expect(restored!.status).toBe(s);
    }
  });

  it('fills defaults for missing numeric fields', () => {
    const restored = deserializeGoal({ id: 'x', text: 'y', status: 'active' });
    expect(restored!.iteration).toBe(0);
    expect(restored!.tokensUsed).toBe(0);
    expect(restored!.timeUsedSeconds).toBe(0);
    expect(restored!.baselineTokens).toBe(0);
    expect(restored!.automaticModelTurns).toBe(0);
    expect(restored!.toolFreeRepeatCount).toBe(0);
  });

  it('ignores non-positive tokenBudget', () => {
    const restored = deserializeGoal({
      id: 'x',
      text: 'y',
      status: 'active',
      tokenBudget: 0,
    });
    expect(restored!.tokenBudget).toBeUndefined();

    const restored2 = deserializeGoal({
      id: 'x',
      text: 'y',
      status: 'active',
      tokenBudget: -5,
    });
    expect(restored2!.tokenBudget).toBeUndefined();
  });
});

// ─── isTerminalGoalStatus ───

describe('isTerminalGoalStatus', () => {
  it('returns false for active', () => {
    expect(isTerminalGoalStatus('active')).toBe(false);
  });

  it('returns true for all non-active statuses', () => {
    expect(isTerminalGoalStatus('paused')).toBe(true);
    expect(isTerminalGoalStatus('blocked')).toBe(true);
    expect(isTerminalGoalStatus('budget_limited')).toBe(true);
    expect(isTerminalGoalStatus('complete')).toBe(true);
  });
});

// ─── blocksToolCalls ───

describe('blocksToolCalls', () => {
  it('returns true for paused and blocked', () => {
    expect(blocksToolCalls('paused')).toBe(true);
    expect(blocksToolCalls('blocked')).toBe(true);
  });

  it('returns false for active, budget_limited, complete', () => {
    expect(blocksToolCalls('active')).toBe(false);
    expect(blocksToolCalls('budget_limited')).toBe(false);
    expect(blocksToolCalls('complete')).toBe(false);
  });
});

// ─── loadGoalFromEntries ───

describe('loadGoalFromEntries', () => {
  function makeGoalEntry(goal: SerializedGoal | null) {
    return {
      type: 'custom',
      customType: GOAL_STATE_ENTRY_TYPE,
      data: { goal },
    };
  }

  it('returns null for empty entries', () => {
    expect(loadGoalFromEntries([])).toBeNull();
  });

  it('returns null for entries with no goal-state entry', () => {
    expect(loadGoalFromEntries([{ type: 'text', content: 'hello' }])).toBeNull();
  });

  it('restores a goal from a goal-state entry', () => {
    const goal = serializeGoal(createGoal('test'));
    const entries = [makeGoalEntry(goal)];
    const restored = loadGoalFromEntries(entries);
    expect(restored).not.toBeNull();
    expect(restored!.text).toBe('test');
    expect(restored!.status).toBe('active');
  });

  it('uses the last goal-state entry when multiple exist', () => {
    const goal1 = serializeGoal(createGoal('first'));
    const goal2 = serializeGoal(createGoal('second'));
    const entries = [makeGoalEntry(goal1), makeGoalEntry(goal2)];
    const restored = loadGoalFromEntries(entries);
    expect(restored!.text).toBe('second');
  });

  it('returns null for goal-state entry with null goal (cleared)', () => {
    const entries = [makeGoalEntry(null)];
    expect(loadGoalFromEntries(entries)).toBeNull();
  });

  it('skips invalid goal-state entries and continues searching', () => {
    const validGoal = serializeGoal(createGoal('valid'));
    const entries = [
      makeGoalEntry(validGoal),
      {
        type: 'custom',
        customType: GOAL_STATE_ENTRY_TYPE,
        data: { goal: { id: 'x', status: 'invalid_status' } },
      },
    ];
    // 最后一条无效 → 应回退到前一条有效的
    const restored = loadGoalFromEntries(entries);
    expect(restored).not.toBeNull();
    expect(restored!.text).toBe('valid');
  });

  it('handles entries with content instead of data field', () => {
    const goal = serializeGoal(createGoal('via content'));
    const entries = [
      {
        type: 'custom',
        customType: GOAL_STATE_ENTRY_TYPE,
        content: { goal },
      },
    ];
    const restored = loadGoalFromEntries(entries);
    expect(restored).not.toBeNull();
    expect(restored!.text).toBe('via content');
  });

  it('null goal entry after valid goal entry means cleared', () => {
    const goal = serializeGoal(createGoal('first'));
    const entries = [makeGoalEntry(goal), makeGoalEntry(null)];
    // 最后一条是 null goal → 表示已清除
    expect(loadGoalFromEntries(entries)).toBeNull();
  });
});
