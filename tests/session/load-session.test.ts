import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAccess } from '../../electron/session-access';
import { usePiStore } from '../../src/store/pi-store';
import {
  captureSessionGuard,
  isCurrentSession,
  loadAndApplySessionMessages,
  loadSessionMessages,
  transitionSession
} from '../../src/hooks/loadSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const message = (timestamp: number, content = String(timestamp)) => ({
  role: 'user',
  timestamp,
  content
});
let access: SessionAccess;
let sessionId: string;
let history: ReturnType<typeof message>[];
const identity = () => ({ sessionId, sessionRevision: access.revision });
const state = () => ({
  ...identity(),
  cwd: `/project/${sessionId}`,
  messages: [],
  model: undefined,
  thinkingLevel: 'off',
  isStreaming: false
});
let pi: ReturnType<typeof makePi>;
function makePi() {
  return {
    getState: vi.fn(async () => state()),
    getMessageSnapshot: vi.fn(async () => access.capture(identity(), history)),
    getMessages: vi.fn(async (id: string, offset: number, limit: number) =>
      access.page(identity(), id, offset, limit)
    ),
    releaseMessageSnapshot: vi.fn(async (id: string) => access.release(id)),
    getAvailableModels: vi.fn(async (): Promise<any[]> => []),
    getCommands: vi.fn(async (): Promise<any[]> => []),
    getTodoPhases: vi.fn(async () => ({ phases: [] as any[] })),
    getPendingInteractions: vi.fn(async () => ({ ask: null, permission: null })),
    getSessionStats: vi.fn(async (): Promise<any> => ({ cost: 2 })),
    setPlanMode: vi.fn(async () => {}),
    setUiSettings: vi.fn(async () => {}),
    goal: {
      get: vi.fn(async (): Promise<any> => ({
        goal: null,
        goalHistory: [],
        mode: 'none',
        remainingTokens: null
      }))
    },
    plan: {
      get: vi.fn(async (): Promise<any> => ({
        phase: 'idle',
        pendingProposal: null,
        lastApprovedPlan: null
      }))
    },
    subagents: { getSnapshot: vi.fn(async () => ({ runs: [] })) }
  };
}

beforeEach(() => {
  access = new SessionAccess();
  sessionId = 'A';
  history = Array.from({ length: 401 }, (_, i) => message(i, `A:${i}`));
  pi = makePi();
  vi.stubGlobal('window', { pi });
  usePiStore.setState(usePiStore.getInitialState(), true);
  usePiStore.setState({ showToast: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('session history loading', () => {
  it('loads all pages from one snapshot and releases it', async () => {
    expect(await loadSessionMessages(identity())).toEqual(history);
    expect(pi.getMessages.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 200],
      [200, 200],
      [400, 200]
    ]);
    expect(pi.releaseMessageSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects A/B mixed pagination rather than applying a partial history', async () => {
    pi.getMessages.mockImplementationOnce(async (id, offset, limit) => {
      const first = access.page(identity(), id, offset, limit);
      await access.run(async () => {
        sessionId = 'B';
        history = [message(99, 'B')];
      });
      return first;
    });
    usePiStore.getState().setSessionInfo(state());
    usePiStore.getState().setMessages([message(-1, 'untouched')]);
    await expect(loadAndApplySessionMessages(identity())).rejects.toThrow('SESSION_CHANGED');
    expect(usePiStore.getState().messages).toEqual([message(-1, 'untouched')]);
    expect(pi.releaseMessageSnapshot).toHaveBeenCalledOnce();
  });

  it('preserves new messages and live tool updates arriving during history loading', async () => {
    usePiStore.getState().setSessionInfo(state());
    const pageReady = deferred<void>();
    const gate = deferred<void>();
    pi.getMessages.mockImplementationOnce(async (id, offset, limit) => {
      const page = access.page(identity(), id, offset, limit);
      pageReady.resolve();
      await gate.promise;
      return page;
    });
    const loading = loadAndApplySessionMessages(identity());
    await pageReady.promise;
    usePiStore.getState().addMessage(message(402, 'live'));
    usePiStore
      .getState()
      .updateToolExecution('running-tool', { toolCallId: 'running-tool', status: 'running' });
    gate.resolve();
    await loading;
    expect(usePiStore.getState().messages).toEqual([...history, message(402, 'live')]);
    expect(usePiStore.getState().toolExecutions['running-tool'].status).toBe('running');
  });

  it('discards an old completed load after the renderer has moved to another session', async () => {
    usePiStore.getState().setSessionInfo(state());
    const release = deferred<void>();
    const ready = deferred<void>();
    pi.releaseMessageSnapshot.mockImplementationOnce(async (id) => {
      access.release(id);
      ready.resolve();
      await release.promise;
    });
    const loading = loadAndApplySessionMessages(identity());
    await ready.promise;
    usePiStore.getState().setSessionInfo({ ...state(), sessionId: 'B', sessionRevision: 2 });
    usePiStore.getState().setMessages([message(1, 'B')]);
    release.resolve();
    await loading;
    expect(usePiStore.getState().messages).toEqual([message(1, 'B')]);
  });
});

describe('renderer session transitions', () => {
  it('serializes active transitions and applies only the newest request', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    const first = transitionSession(async () => {
      order.push('A:start');
      entered.resolve();
      await release.promise;
      order.push('A:end');
    });
    await entered.promise;
    const second = transitionSession(async () => {
      order.push('B');
      await access.run(async () => {
        sessionId = 'B';
        history = [message(1, 'B')];
      });
    });
    expect(usePiStore.getState().isSessionLoading).toBe(true);
    release.resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(order).toEqual(['A:start', 'A:end', 'B']);
    expect(usePiStore.getState()).toMatchObject({
      sessionId: 'B',
      messages: history,
      isSessionLoading: false
    });
    expect(pi.getState).toHaveBeenCalledOnce();
  });

  it('recovers the active session after a failed switch and permits the next switch', async () => {
    expect(
      await transitionSession(async () => {
        throw new Error('cannot open B');
      })
    ).toBe(false);
    expect(usePiStore.getState()).toMatchObject({
      sessionId: 'A',
      messages: history,
      isSessionLoading: false
    });
    expect(usePiStore.getState().showToast).toHaveBeenCalledOnce();
    expect(
      await transitionSession(async () => {
        await access.run(async () => {
          sessionId = 'C';
          history = [message(5, 'C')];
        });
      })
    ).toBe(true);
    expect(usePiStore.getState().sessionId).toBe('C');
  });

  it('does not apply late models, commands, goal, plan or todo responses from an old request', async () => {
    const oldResponse = deferred<any>();
    const ready = deferred<void>();
    pi.getAvailableModels.mockReturnValueOnce(oldResponse.promise);
    pi.getCommands.mockReturnValueOnce(oldResponse.promise);
    pi.goal.get.mockReturnValueOnce(oldResponse.promise);
    pi.plan.get.mockReturnValueOnce(oldResponse.promise);
    pi.getTodoPhases.mockImplementationOnce(() => {
      ready.resolve();
      return oldResponse.promise;
    });
    const first = transitionSession(async () => {});
    await ready.promise;
    const second = transitionSession(async () => {
      await access.run(async () => {
        sessionId = 'B';
        history = [];
      });
    });
    // 故意返回不兼容结构；若过期保护失效，会污染 store 或触发 setAvailableModels。
    oldResponse.resolve({ stale: true, phases: ['old'] });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(usePiStore.getState()).toMatchObject({
      sessionId: 'B',
      availableModels: [],
      commands: [],
      todoPhases: [],
      planPhase: 'idle'
    });
    expect(usePiStore.getState().goalSnapshot?.goal).toBeNull();
  });

  it('ignores old stats and event identities when the same session is reopened', async () => {
    usePiStore.getState().setSessionInfo(state());
    const oldIdentity = identity();
    const oldGuard = captureSessionGuard();
    const oldStats = deferred<any>();
    pi.getSessionStats.mockReturnValueOnce(oldStats.promise);
    usePiStore.getState().refreshStats();
    await transitionSession(() => access.run(async () => {}));
    oldStats.resolve({ cost: 999 });
    await Promise.resolve();
    expect(oldGuard()).toBe(false);
    expect(isCurrentSession(oldIdentity)).toBe(false);
    expect(isCurrentSession(identity())).toBe(true);
    expect(usePiStore.getState().stats?.cost).toBe(2);
  });
});
