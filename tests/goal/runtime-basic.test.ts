import { describe, it, expect, vi } from 'vitest';
import {
  GoalRuntime,
  type GoalRuntimeHost,
} from '../../electron/goal/runtime';
import { type ActiveGoal } from '../../electron/goal/persistence';

// ─── Mock host factory ───

function createMockHost(overrides: Partial<GoalRuntimeHost> = {}): GoalRuntimeHost & {
  _setUsage(u: any): void;
  _setBranchEntries(e: any[]): void;
  _getPersistedGoals(): (ActiveGoal | null)[];
  _getEmitUpdate(): ReturnType<typeof vi.fn>;
} {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let branchEntries: any[] = [];
  const persistedGoals: (ActiveGoal | null)[] = [];
  const emitUpdate = vi.fn();

  return {
    getCurrentUsage: overrides.getCurrentUsage ?? (() => usage),
    getBranchEntries: overrides.getBranchEntries ?? (() => branchEntries),
    persistGoal: overrides.persistGoal ?? ((g) => persistedGoals.push(g)),
    emitUpdate: overrides.emitUpdate ?? emitUpdate,
    _setUsage(u: any) { usage = u; },
    _setBranchEntries(e: any[]) { branchEntries = e; },
    _getPersistedGoals() { return persistedGoals; },
    _getEmitUpdate() { return emitUpdate; },
  } as any;
}

// ─── Basic lifecycle ───

describe('GoalRuntime — basic lifecycle', () => {
  it('starts with no active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    expect(rt.hasActiveGoal).toBe(false);
    expect(rt.isGoalModeActive()).toBe(false);
    expect(rt.goal).toBeNull();
  });

  it('creates a goal and emits update', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    const goal = rt.createGoal('test goal');
    expect(goal).not.toBeNull();
    expect(goal!.text).toBe('test goal');
    expect(goal!.status).toBe('active');
    expect(rt.hasActiveGoal).toBe(true);
    expect(host._getEmitUpdate()).toHaveBeenCalled();
  });

  it('refuses to create a second goal while one is active', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('first');
    expect(rt.createGoal('second')).toBeNull();
    expect(rt.goal!.text).toBe('first');
  });

  it('allows creating a new goal after previous completes', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('first');
    rt.transitionGoal('complete');
    const second = rt.createGoal('second');
    expect(second).not.toBeNull();
    expect(second!.text).toBe('second');
  });

  it('clearGoal removes the goal and emits', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test');
    rt.clearGoal();
    expect(rt.hasActiveGoal).toBe(false);
    expect(host._getEmitUpdate()).toHaveBeenCalled();
  });

  it('editGoal updates text and budget', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('original', 1000);
    rt.editGoal('updated', 5000);
    expect(rt.goal!.text).toBe('updated');
    expect(rt.goal!.tokenBudget).toBe(5000);
  });

  it('editGoal with null budget clears it', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test', 1000);
    rt.editGoal(undefined, null);
    expect(rt.goal!.tokenBudget).toBeUndefined();
  });
});

// ─── State transitions ───

describe('GoalRuntime — state transitions', () => {
  it('pauseGoal sets status to paused and clears activeStartedAt', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.pauseGoal();
    expect(rt.goal!.status).toBe('paused');
    expect(rt.goal!.activeStartedAt).toBeUndefined();
  });

  it('resumeGoal sets status back to active', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.pauseGoal();
    rt.resumeGoal();
    expect(rt.goal!.status).toBe('active');
    expect(rt.goal!.activeStartedAt).toBeDefined();
  });

  it('resumeGoal on complete goal is a no-op', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.transitionGoal('complete');
    rt.resumeGoal();
    expect(rt.goal!.status).toBe('complete');
  });

  it('transitionGoal to active with exhausted budget auto-downgrades to budget_limited', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test', 1000);
    rt.goal!.tokensUsed = 1000;
    rt.pauseGoal();
    rt.resumeGoal();
    expect(rt.goal!.status).toBe('budget_limited');
  });

  it('transitionGoal to complete records completedTimeUsed', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.goal!.timeUsedSeconds = 42;
    rt.transitionGoal('complete');
    expect(rt.goal!.status).toBe('complete');
    expect(rt.goal!.completedTimeUsed).toBe(42);
  });

  it('transitionGoal clears continuation tickets when entering terminal status', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up prompt');
    rt.pauseGoal();
    expect(rt.dispatchContinuation(true, false)).toBeNull();
  });
});

// ─── Token accounting ───

describe('GoalRuntime — token accounting', () => {
  it('flushUsage adds delta to tokensUsed', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test');
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 500, output: 200, cacheRead: 100, cacheWrite: 50 });
    rt.flushUsage();
    expect(rt.goal!.tokensUsed).toBeGreaterThan(0);
  });

  it('flushUsage does not count cacheRead', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test');
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 0, output: 0, cacheRead: 500, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.goal!.tokensUsed).toBe(0);
  });

  it('flushUsage does not go negative (clamped to 0)', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test');
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.goal!.tokensUsed).toBe(0);
  });

  it('budget flip: active → budget_limited when tokensUsed >= tokenBudget', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test', 1000);
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 600, output: 500, cacheRead: 0, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.goal!.status).toBe('budget_limited');
    expect(rt.isBudgetWrapUpActive()).toBe(true);
  });

  it('flushUsage is a no-op without active goal', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 500, output: 200, cacheRead: 0, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.hasActiveGoal).toBe(false);
  });

  it('flushUsage is a no-op without current run', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test');
    host._setUsage({ input: 500, output: 200, cacheRead: 0, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.goal!.tokensUsed).toBe(0);
  });
});

// ─── Snapshot ───

describe('GoalRuntime — snapshot', () => {
  it('returns null goal snapshot when no active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    const snap = rt.snapshot();
    expect(snap.goal).toBeNull();
    expect(snap.remainingTokens).toBeNull();
    expect(snap.mode).toBe('none');
  });

  it('returns serialized goal with remaining tokens', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test', 5000);
    rt.goal!.tokensUsed = 1500;
    const snap = rt.snapshot();
    expect(snap.goal).not.toBeNull();
    expect(snap.goal!.text).toBe('test');
    expect(snap.remainingTokens).toBe(3500);
    expect(snap.mode).toBe('active');
  });

  it('returns mode "exiting" for complete goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.transitionGoal('complete');
    const snap = rt.snapshot();
    expect(snap.mode).toBe('exiting');
  });

  it('remainingTokens clamps to 0 when over budget', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test', 1000);
    rt.goal!.tokensUsed = 1500;
    const snap = rt.snapshot();
    expect(snap.remainingTokens).toBe(0);
  });

  it('returns null remainingTokens when no budget set', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    const snap = rt.snapshot();
    expect(snap.remainingTokens).toBeNull();
  });
});
