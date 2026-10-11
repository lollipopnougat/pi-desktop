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

// ─── Safety guardrails ───

describe('GoalRuntime — safety guardrails', () => {
  it('pauses on continuation_limit when automaticTurns reached', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: 3 });
    rt.createGoal('test');

    for (let i = 0; i < 3; i++) {
      rt.beginAgentRun('automatic');
      rt.markToolAttempted();
      const result = rt.finishAgentRun();
      if (i < 2) {
        expect(result.shouldContinue).toBe(true);
        expect(rt.goal!.status).toBe('active');
      } else {
        expect(result.shouldContinue).toBe(false);
        expect(rt.goal!.status).toBe('paused');
        expect(rt.goal!.safetyPauseCause).toBe('continuation_limit');
      }
    }
  });

  it('does not count manual turns toward automaticTurns limit', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: 2 });
    rt.createGoal('test');

    for (let i = 0; i < 5; i++) {
      rt.beginAgentRun('manual');
      rt.markToolAttempted();
      const result = rt.finishAgentRun();
      expect(result.shouldContinue).toBe(true);
      expect(rt.goal!.status).toBe('active');
    }
  });

  it('pauses on no_progress when toolFreeRepeatCount reached', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: null, noProgressTurns: 2 });
    rt.createGoal('test');

    for (let i = 0; i < 3; i++) {
      rt.beginAgentRun('automatic');
      rt.setLastAssistantText('same output');
      const result = rt.finishAgentRun();
      if (i < 2) {
        expect(rt.goal!.status).toBe('active');
      } else {
        expect(rt.goal!.status).toBe('paused');
        expect(rt.goal!.safetyPauseCause).toBe('no_progress');
        expect(result.shouldContinue).toBe(false);
      }
    }
  });

  it('no_progress counter resets when tool is attempted', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: null, noProgressTurns: 2 });
    rt.createGoal('test');

    rt.beginAgentRun('automatic');
    rt.setLastAssistantText('same output');
    rt.finishAgentRun();
    expect(rt.goal!.toolFreeRepeatCount).toBe(0);

    rt.beginAgentRun('automatic');
    rt.setLastAssistantText('same output');
    rt.finishAgentRun();
    expect(rt.goal!.toolFreeRepeatCount).toBe(1);

    rt.beginAgentRun('automatic');
    rt.markToolAttempted();
    rt.finishAgentRun();
    expect(rt.goal!.toolFreeRepeatCount).toBe(0);
  });

  it('resetSafetyEpoch clears automatic turn count', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: 3 });
    rt.createGoal('test');

    rt.beginAgentRun('automatic');
    rt.markToolAttempted();
    rt.finishAgentRun();
    rt.beginAgentRun('automatic');
    rt.markToolAttempted();
    rt.finishAgentRun();
    expect(rt.goal!.automaticModelTurns).toBe(2);

    rt.beginAgentRun('automatic');
    rt.resetSafetyEpoch();
    expect(rt.goal!.automaticModelTurns).toBe(0);
    expect(rt.goal!.toolFreeRepeatCount).toBe(0);
  });

  it('null automaticTurns disables the limit', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: null, noProgressTurns: null });
    rt.createGoal('test');

    for (let i = 0; i < 50; i++) {
      rt.beginAgentRun('automatic');
      rt.markToolAttempted();
      const result = rt.finishAgentRun();
      expect(result.shouldContinue).toBe(true);
    }
    expect(rt.goal!.status).toBe('active');
  });
});

// ─── Continuation tickets ───

describe('GoalRuntime — continuation tickets', () => {
  it('requestContinuation increments iteration', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    const initialIteration = rt.goal!.iteration;
    rt.requestContinuation(() => 'prompt');
    expect(rt.goal!.iteration).toBe(initialIteration + 1);
  });

  it('requestContinuation is a no-op without active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.requestContinuation(() => 'prompt');
    expect(rt.hasActiveGoal).toBe(false);
  });

  it('requestContinuation is a no-op for non-active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.pauseGoal();
    const iter = rt.goal!.iteration;
    rt.requestContinuation(() => 'prompt');
    expect(rt.goal!.iteration).toBe(iter);
  });

  it('dispatchContinuation returns prompt when idle and no pending messages', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up prompt');
    expect(rt.dispatchContinuation(true, false)).toBe('follow-up prompt');
  });

  it('dispatchContinuation returns null when not idle', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up');
    expect(rt.dispatchContinuation(false, false)).toBeNull();
  });

  it('dispatchContinuation returns null when pending messages exist', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up');
    expect(rt.dispatchContinuation(true, true)).toBeNull();
  });

  it('dispatchContinuation does not double-dispatch', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up');
    expect(rt.dispatchContinuation(true, false)).toBe('follow-up');
    expect(rt.dispatchContinuation(true, false)).toBeNull();
  });

  it('claimContinuation returns false without delivery', () => {
    const rt = new GoalRuntime(createMockHost());
    expect(rt.claimContinuation('some prompt')).toBe(false);
  });

  it('claimContinuation returns false for prompt without marker', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up');
    rt.dispatchContinuation(true, false);
    expect(rt.claimContinuation('no marker here')).toBe(false);
  });

  it('cancelContinuation clears both intent and delivery', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.requestContinuation(() => 'follow-up');
    rt.cancelContinuation();
    expect(rt.dispatchContinuation(true, false)).toBeNull();
  });

  it('isOwnContinuation detects continuation markers', () => {
    const rt = new GoalRuntime(createMockHost());
    expect(rt.isOwnContinuation('<!-- goal-continuation: abc-123 -->')).toBe(true);
    expect(rt.isOwnContinuation('regular message')).toBe(false);
  });

  it('clearDeferral allows continuation after fork/resume', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.clearDeferral();
    rt.requestContinuation(() => 'follow-up');
    expect(rt.dispatchContinuation(true, false)).toBe('follow-up');
  });
});

// ─── Tool call blocking ───

describe('GoalRuntime — shouldBlockToolCall', () => {
  it('returns false when no active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    expect(rt.shouldBlockToolCall('any_tool')).toBe(false);
  });

  it('returns false for active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    expect(rt.shouldBlockToolCall('edit_file')).toBe(false);
  });

  it('returns true for paused goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.pauseGoal();
    expect(rt.shouldBlockToolCall('edit_file')).toBe(true);
  });

  it('returns true for blocked goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.transitionGoal('blocked');
    expect(rt.shouldBlockToolCall('edit_file')).toBe(true);
  });

  it('returns false for complete goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.transitionGoal('complete');
    expect(rt.shouldBlockToolCall('edit_file')).toBe(false);
  });

  it('budget wrap-up blocks all tools except goal_complete', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('test', 100);
    rt.beginAgentRun('automatic');
    host._setUsage({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    rt.flushUsage();
    expect(rt.isBudgetWrapUpActive()).toBe(true);
    expect(rt.shouldBlockToolCall('edit_file')).toBe(true);
    expect(rt.shouldBlockToolCall('write_file')).toBe(true);
    expect(rt.shouldBlockToolCall('goal_complete')).toBe(false);
  });
});

// ─── Agent run attribution ───

describe('GoalRuntime — agent run attribution', () => {
  it('canRecordGoalUsage returns true when run goalId matches active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    rt.beginAgentRun('automatic');
    expect(rt.canRecordGoalUsage()).toBe(true);
  });

  it('canRecordGoalUsage returns false without active run', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.createGoal('test');
    expect(rt.canRecordGoalUsage()).toBe(false);
  });

  it('canRecordGoalUsage returns false without active goal', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.beginAgentRun('automatic');
    expect(rt.canRecordGoalUsage()).toBe(false);
  });

  it('markToolAttempted prevents no-progress increment', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host, { automaticTurns: null, noProgressTurns: 2 });
    rt.createGoal('test');
    rt.beginAgentRun('automatic');
    rt.setLastAssistantText('same output');
    rt.markToolAttempted();
    rt.finishAgentRun();
    expect(rt.goal!.toolFreeRepeatCount).toBe(0);
  });

  it('finishAgentRun without run returns shouldContinue false', () => {
    const rt = new GoalRuntime(createMockHost());
    expect(rt.finishAgentRun()).toEqual({ shouldContinue: false });
  });

  it('finishAgentRun without active goal returns shouldContinue false', () => {
    const rt = new GoalRuntime(createMockHost());
    rt.beginAgentRun('automatic');
    expect(rt.finishAgentRun()).toEqual({ shouldContinue: false });
  });
});

// ─── Session recovery ───

describe('GoalRuntime — loadFromSession', () => {
  it('restores goal from session entries when no active goal in memory', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('session goal');
    const serialized = rt.snapshot().goal;
    rt.clearGoal();

    host._setBranchEntries([
      { type: 'custom', customType: 'goal-state', data: { goal: serialized } },
    ]);
    rt.loadFromSession();
    expect(rt.hasActiveGoal).toBe(true);
    expect(rt.goal!.text).toBe('session goal');
  });

  it('does not overwrite in-memory active goal with session data', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('memory goal');
    const oldId = rt.goal!.id;

    host._setBranchEntries([
      { type: 'custom', customType: 'goal-state', data: { goal: null } },
    ]);
    rt.loadFromSession();
    expect(rt.goal!.id).toBe(oldId);
    expect(rt.goal!.text).toBe('memory goal');
  });

  it('sets continuationDeferred for restored active goal', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    rt.createGoal('deferred goal');
    const serialized = rt.snapshot().goal;
    rt.clearGoal();

    host._setBranchEntries([
      { type: 'custom', customType: 'goal-state', data: { goal: serialized } },
    ]);
    rt.loadFromSession();
    expect(rt.goal!.status).toBe('active');
    // Deferred means requestContinuation should be a no-op
    rt.requestContinuation(() => 'should not happen');
    expect(rt.dispatchContinuation(true, false)).toBeNull();
  });

  it('clears goal when session has null goal entry and no memory goal', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    host._setBranchEntries([
      { type: 'custom', customType: 'goal-state', data: { goal: null } },
    ]);
    rt.loadFromSession();
    expect(rt.hasActiveGoal).toBe(false);
  });

  it('emits update on loadFromSession', () => {
    const host = createMockHost();
    const rt = new GoalRuntime(host);
    const emitSpy = host._getEmitUpdate();
    emitSpy.mockClear();
    rt.loadFromSession();
    expect(emitSpy).toHaveBeenCalled();
  });
});
