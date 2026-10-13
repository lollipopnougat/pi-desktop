import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  disconnect: vi.fn(async () => {}),
  autoConnect: vi.fn(async () => {}),
  setCwd: vi.fn(),
  killTerminals: vi.fn(),
  exportFromFile: vi.fn(
    async (_input: string, options?: { outputPath?: string }) =>
      options?.outputPath ?? '/tmp/export.html'
  )
}));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
  session: {},
  Notification: vi.fn()
}));
vi.mock('../../electron/ipc/terminal-ipc', () => ({
  registerTerminalIpc: vi.fn(),
  killAllTerminals: mocks.killTerminals
}));
vi.mock('../../electron/mcp/manager', () => ({
  mcpManager: {
    disconnectAll: mocks.disconnect,
    onSessionCreate: mocks.autoConnect,
    setCwd: mocks.setCwd
  }
}));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  createAgentSessionRuntime: mocks.createRuntime
}));
// SDK 的导出 API 通过 vite alias 打进 bundle（见 electron/sdk-export-html.ts），测试里整体替掉
vi.mock('../../electron/sdk-export-html', () => ({
  exportFromFile: mocks.exportFromFile,
  exportSessionToHtml: vi.fn()
}));

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiBridge, type SlotControllerFactories } from '../../electron/pi-bridge';
import { ipcMain } from 'electron';
import { registerSessionIpc } from '../../electron/ipc/session-ipc';
import { registerMiscIpc } from '../../electron/ipc/misc-ipc';
import { askTool, resolveAsk } from '../../electron/tools/ask-tool';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function makeRuntime(cwd: string, id: string) {
  const unsubscribe = vi.fn();
  const rebind: { current: (() => Promise<void>) | null } = { current: null };
  const session = {
    sessionId: id,
    messages: [],
    sessionFile: undefined,
    isStreaming: false,
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn(() => unsubscribe),
    getActiveToolNames: () => [],
    setActiveToolsByName: vi.fn(),
    // PiBridge 建槽/换会话时必须调用它：SDK 只在 bindExtensions 里 emit session_start
    bindExtensions: vi.fn(async () => {})
  };
  return {
    cwd,
    session,
    rebind,
    dispose: vi.fn(async () => {}),
    setBeforeSessionInvalidate: vi.fn(),
    setRebindSession: vi.fn((callback: () => Promise<void>) => {
      rebind.current = callback;
    }),
    unsubscribe
  };
}
/** 槽控制器的替身：控制器现在按槽创建（见 PiBridge.createSlotControllers），经工厂注入 */
function makeControllerStubs() {
  const permission = {
    clearPending: vi.fn(),
    replayPending: vi.fn(),
    resolvePermission: vi.fn(() => true),
    firstPendingRequest: vi.fn(() => null),
    install: vi.fn(),
    restorePolicy: vi.fn(),
    restoreAutoSafeConfig: vi.fn(),
    restoreClassifierConfig: vi.fn()
  };
  const plan = {
    cancelPending: vi.fn(),
    onSessionSwitch: vi.fn(),
    enterPlanning: vi.fn(),
    exitToIdle: vi.fn()
  };
  const goal = { onSessionSwitch: vi.fn(), refreshGoalToolVisibility: vi.fn() };
  const memory = { onSessionSwitch: vi.fn(), dispose: vi.fn(async () => {}) };
  const subagent = { dispose: vi.fn(async () => {}), onSessionSwitch: vi.fn() };
  const factories: SlotControllerFactories = {
    goal: () => goal as any,
    plan: () => plan as any,
    memory: () => memory as any,
    subagent: () => subagent as any,
    permission: () => permission as any
  };
  return { permission, plan, goal, memory, subagent, factories };
}

/**
 * 每次调用都新建替身并记录：用来断言「控制器按槽创建」
 * （created.<kind>[0] = 第一个槽的，[1] = 第二个槽的……）。
 */
function recordingFactories() {
  const created: Record<string, any[]> = {};
  const make = (kind: string, stub: () => any) => () => {
    const value = stub();
    (created[kind] ??= []).push(value);
    return value;
  };
  const factories: SlotControllerFactories = {
    goal: make('goal', () => ({ onSessionSwitch: vi.fn(), refreshGoalToolVisibility: vi.fn() })),
    plan: make('plan', () => ({
      onSessionSwitch: vi.fn(),
      cancelPending: vi.fn(),
      enterPlanning: vi.fn(),
      exitToIdle: vi.fn()
    })),
    memory: make('memory', () => ({ onSessionSwitch: vi.fn(), dispose: vi.fn(async () => {}) })),
    subagent: make('subagent', () => ({
      onSessionSwitch: vi.fn(),
      dispose: vi.fn(async () => {})
    })),
    permission: make('permission', () => ({
      clearPending: vi.fn(),
      replayPending: vi.fn(),
      resolvePermission: vi.fn(() => true),
      firstPendingRequest: vi.fn(() => null),
      install: vi.fn(),
      restorePolicy: vi.fn(),
      restoreAutoSafeConfig: vi.fn(),
      restoreClassifierConfig: vi.fn()
    }))
  };
  return { factories, created };
}

function makeBridgeStubs(factories: SlotControllerFactories = {}) {
  const bridge = new PiBridge(factories);
  bridge.backgroundTaskController = { dispose: vi.fn(async () => {}) } as any;
  bridge.browserController = { setEnabled: vi.fn(async () => {}) } as any;
  bridge.win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  } as any;
  return bridge;
}

/**
 * 建一个带首个会话槽的 bridge：走真实 createRuntimeFor 路径（与 init 一致）。
 * 之后要改会话/运行时状态必须经 slot —— PiBridge 的 runtime/session/cwd 已是只读访问器。
 */
async function makeBridge() {
  const stubs = makeControllerStubs();
  const bridge = makeBridgeStubs(stubs.factories);
  const old = makeRuntime('/project/A', 'A');
  mocks.createRuntime.mockImplementationOnce(async () => old);
  await bridge.createRuntimeFor('/project/A');
  // 建槽过程本身会 disconnectAll/setCwd/onSessionCreate：清掉记录，让断言只统计被测操作
  mocks.createRuntime.mockClear();
  mocks.disconnect.mockClear();
  mocks.setCwd.mockClear();
  mocks.autoConnect.mockClear();
  return { bridge, old, slot: bridge.sessionFor(), ...stubs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(SessionManager, 'create').mockReturnValue({} as any);
  mocks.createRuntime.mockImplementation(async (_factory, opts) => makeRuntime(opts.cwd, 'B'));
});

describe('PiBridge runtime lifecycle', () => {
  it('awaits old runtime shutdown before constructing a replacement', async () => {
    const { bridge, old } = await makeBridge();
    const shutdown = deferred();
    const entered = deferred();
    old.dispose.mockImplementation(async () => {
      expect(bridge.sessionFor().requireSession()).toBe(old.session);
      expect(bridge.cwd).toBe('/project/A');
      entered.resolve();
      await shutdown.promise;
    });
    const replacing = bridge.runSessionOperation(() => bridge.createRuntimeFor('/project/B'));
    await entered.promise;
    expect(old.session.abort).toHaveBeenCalled();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    shutdown.resolve();
    await replacing;
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(bridge.sessionFor().requireSession().sessionId).toBe('B');
    expect(bridge.cwd).toBe('/project/B');
    expect(mocks.setCwd).toHaveBeenLastCalledWith('/project/B');
  });

  it('binds session extensions on slot creation and after the runtime replaces the session', async () => {
    const { bridge, old } = await makeBridge();
    // 建槽时必须 bindExtensions：SDK 只在它内部 emit session_start，
    // 而后台任务完成通知 / hooks 的 SessionStart 等会话级回调都注册在 session_start 上。
    expect(old.session.bindExtensions).toHaveBeenCalledOnce();
    // 传 onError：SDK 的 reload() 只在此类绑定存在时才重发 session_start
    expect(typeof old.session.bindExtensions.mock.calls[0][0].onError).toBe('function');

    // SDK 的 newSession/fork/resume 会回调 rebindSession —— 换会话后必须重新绑定，
    // 否则新 session 收不到 session_start（旧绑定绑不上新会话）。
    const replacement = makeRuntime('/project/A', 'A2');
    old.session = replacement.session;
    await old.rebind.current?.();
    expect(replacement.session.bindExtensions).toHaveBeenCalledOnce();
    expect(bridge.sessionFor().requireSession().sessionId).toBe('A2');
  });

  it('makes quit idempotent and awaits asynchronous cleanup before disconnecting MCP', async () => {
    const { bridge, old } = await makeBridge();
    const browser = deferred();
    const browserEntered = deferred();
    vi.mocked(bridge.browserController.setEnabled).mockImplementation(async () => {
      browserEntered.resolve();
      await browser.promise;
      return {} as any;
    });
    const first = bridge.dispose();
    expect(bridge.dispose()).toBe(first);
    await browserEntered.promise;
    expect(mocks.disconnect).not.toHaveBeenCalled();
    await expect(bridge.runSessionOperation(async () => {})).rejects.toThrow('closing');
    browser.resolve();
    await first;
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.killTerminals).toHaveBeenCalledOnce();
    expect(bridge.memoryController.dispose).toHaveBeenCalledOnce();
    expect(bridge.runtime).toBeNull();
  });

  it('still closes MCP and other resources if one cleanup fails', async () => {
    const { bridge, old } = await makeBridge();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    old.dispose.mockRejectedValue(new Error('shutdown failed'));
    vi.mocked(bridge.memoryController.dispose).mockRejectedValue(new Error('memory failed'));
    vi.mocked(bridge.browserController.setEnabled).mockRejectedValue(new Error('browser failed'));
    await bridge.dispose();
    expect(old.session.dispose).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.killTerminals).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('waits for memory cancellation before releasing the model runtime', async () => {
    const { bridge, old } = await makeBridge();
    const entered = deferred();
    const memory = deferred();
    vi.mocked(bridge.memoryController.dispose).mockImplementation(async () => {
      entered.resolve();
      await memory.promise;
    });
    const closing = bridge.dispose();
    await entered.promise;
    expect(old.dispose).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    memory.resolve();
    await closing;
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('gives each slot its own controller set and keeps background controllers alive', async () => {
    const { factories, created } = recordingFactories();
    const bridge = makeBridgeStubs(factories);
    const first = makeRuntime('/project/A', 'A');
    first.session.sessionFile = '/session/A.jsonl';
    mocks.createRuntime.mockImplementationOnce(async () => first);
    await bridge.createRuntimeFor('/project/A');
    const firstSlot = bridge.sessionFor();

    // 新建会话（同项目）：新槽建自己的控制器，旧槽的保持不动
    await bridge.newSessionInSlot();
    const secondSlot = bridge.sessionFor();
    expect(secondSlot).not.toBe(firstSlot);
    expect(created.goal).toHaveLength(2);
    expect(firstSlot.goalController).toBe(created.goal[0]);
    expect(secondSlot.goalController).toBe(created.goal[1]);
    // 焦点镜像指向新槽的控制器（旧取用点 = 焦点语义）
    expect(bridge.goalController).toBe(secondSlot.goalController);
    expect(bridge.permissionController).toBe(secondSlot.permissionController);

    // 切回后台槽：复用它的控制器（不新建），也不碰另一个槽的状态
    await bridge.openSessionInSlot('/session/A.jsonl');
    expect(created.goal).toHaveLength(2);
    expect(bridge.goalController).toBe(firstSlot.goalController);
    // 切回自己：重新从会话恢复状态（幂等保底）；被留在后台的那个槽不被碰
    expect(firstSlot.goalController.onSessionSwitch).toHaveBeenCalledTimes(2);
    expect(secondSlot.goalController.onSessionSwitch).toHaveBeenCalledTimes(1);
  });

  it('does not cancel the other session', async () => {
    const { factories, created } = recordingFactories();
    const bridge = makeBridgeStubs(factories);
    const first = makeRuntime('/project/A', 'A');
    mocks.createRuntime.mockImplementationOnce(async () => first);
    await bridge.createRuntimeFor('/project/A');
    created.permission[0].clearPending.mockClear();

    // 切焦点到另一个会话：只能重装/清空新焦点槽的审批，不能误清留在后台那个槽的
    await bridge.newSessionInSlot();
    expect(created.permission[0].clearPending).not.toHaveBeenCalled();
    expect(created.permission[1].clearPending).toHaveBeenCalled();
  });

  it('queues prompts beyond the concurrent-session limit and releases them when a slot frees up', async () => {
    const { bridge, old } = await makeBridge();
    // 已在跑的会话再发一条：不占新额度（交给 SDK 自己的队列）
    old.session.isStreaming = true;
    expect(await bridge.submitPrompt('again', undefined)).toEqual({ queued: false });
    expect(old.session.prompt).toHaveBeenCalledWith('again', undefined);

    // 再开两个会话并让它们也在跑 → 3 个在跑 = 上限
    await bridge.newSessionInSlot();
    bridge.sessionFor().requireSession().isStreaming = true;
    await bridge.newSessionInSlot();
    bridge.sessionFor().requireSession().isStreaming = true;

    // 第 4 个（空闲）会话发回合：没有额度 → 排队
    await bridge.newSessionInSlot();
    const idle = bridge.sessionFor();
    expect(await bridge.submitPrompt('queued turn', undefined, idle.key)).toEqual({ queued: true });
    expect(idle.requireSession().prompt).not.toHaveBeenCalled();
    expect(bridge.sessionSlots().slots.find((s) => s.key === idle.key)?.queuedPrompts).toBe(1);

    // 一个在跑的会话腾出来 → 排队的回合被放行，且不再排队
    const slotAKey = bridge.sessionSlots().slots.find((s) => s.sessionId === 'A')!.key;
    old.session.isStreaming = false;
    await bridge.abortSlot(slotAKey);
    expect(idle.requireSession().prompt).toHaveBeenCalledWith('queued turn', undefined);
    expect(bridge.sessionSlots().slots.find((s) => s.key === idle.key)?.queuedPrompts).toBe(0);
  });

  it('projects slot state for the sidebar and keeps unread per session', async () => {
    const { bridge, old } = await makeBridge();
    // 先接管 A 槽的事件订阅（稍后模拟它作为后台槽跑完一轮）
    let emit!: (event: any) => void;
    old.session.subscribe.mockImplementation((cb: any) => {
      emit = cb;
      return old.unsubscribe;
    });
    await bridge.syncSession();

    expect(bridge.sessionSlots().slots).toHaveLength(1);
    expect(bridge.sessionSlots().slots[0]).toMatchObject({
      sessionId: 'A',
      running: false,
      unread: false
    });

    // 新建会话：A 槽转后台（焦点是新槽）
    old.session.sessionFile = '/session/A.jsonl';
    await bridge.newSessionInSlot();
    const afterNew = bridge.sessionSlots();
    expect(afterNew.slots).toHaveLength(2);
    const slotA = afterNew.slots.find((s) => s.sessionId === 'A')!;
    expect(afterNew.focusedKey).not.toBe(slotA.key);

    // 后台槽跑完一轮 → 未读；切回去自动清；也能直接停后台槽
    emit({ type: 'agent_end' });
    expect(bridge.sessionSlots().slots.find((s) => s.sessionId === 'A')!.unread).toBe(true);
    await bridge.abortSlot(slotA.key);
    expect(old.session.abort).toHaveBeenCalled();
    await bridge.openSessionInSlot('/session/A.jsonl');
    const afterSwitchBack = bridge.sessionSlots();
    expect(afterSwitchBack.focusedKey).toBe(slotA.key);
    expect(afterSwitchBack.slots.find((s) => s.sessionId === 'A')!.unread).toBe(false);
  });

  it('recovers from SDK creation failure after invalidating the old session', async () => {
    const { bridge, old, slot } = await makeBridge();
    await expect(
      bridge.runSessionOperation(async () => {
        old.session.dispose();
        slot.session = null;
        throw new Error('new session failed');
      })
    ).rejects.toThrow('new session failed');
    expect(bridge.sessionFor().requireSession()).not.toBe(old.session);
    expect(old.dispose).not.toHaveBeenCalled();
    await expect(bridge.runSessionOperation(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('tags SDK events with the current session and blocks events while replacing', async () => {
    const { bridge, old } = await makeBridge();
    let emit!: (event: any) => void;
    old.session.subscribe.mockImplementation((callback?: any) => {
      emit = callback;
      return old.unsubscribe;
    });
    await bridge.syncSession();
    emit({ type: 'agent_start' });
    expect(bridge.win!.webContents.send).toHaveBeenLastCalledWith('pi:event', {
      type: 'agent_start',
      sessionId: 'A',
      sessionRevision: 0
    });
    vi.mocked(bridge.win!.webContents.send).mockClear();
    await bridge.runSessionOperation(async () => {
      emit({ type: 'agent_end', messages: [] });
    });
    expect(bridge.win!.webContents.send).not.toHaveBeenCalled();
    emit({ type: 'agent_start' });
    expect(bridge.win!.webContents.send).toHaveBeenLastCalledWith('pi:event', {
      type: 'agent_start',
      sessionId: 'A',
      sessionRevision: 1
    });
  });
});

describe('session list projection', () => {
  it('adds a session with messages to the scanned list and never duplicates it', async () => {
    const { bridge, old } = await makeBridge();
    const scanned = [{ id: 'other', path: '/sessions/other.jsonl', cwd: '/project/A' }] as any;

    // 刚新建、还没发消息的空会话不进列表
    expect(bridge.mergeSessionList(scanned, '/project/A').map((s) => s.id)).toEqual(['other']);

    // 发过消息（文件可能还没落盘/扫描还没跑）才补一行
    old.session.messages = [{ role: 'user', content: '第一条消息' }];
    const merged = bridge.mergeSessionList(scanned, '/project/A');
    expect(merged.map((s) => s.id)).toEqual(['other', old.session.sessionId]);
    const row = merged.find((s) => s.id === old.session.sessionId)!;
    // 还没落盘时没有路径（渲染端此时用 id 作为切换参数）
    expect(row.path).toBe('');
    expect(row.cwd).toBe('/project/A');
    expect(row.modified).toBeInstanceOf(Date);
    expect(row.messageCount).toBe(1);

    // 已经出现在扫描结果里的会话不再补一条
    const withFile = [
      { id: old.session.sessionId, path: '/sessions/A.jsonl', cwd: '/project/A' }
    ] as any;
    expect(bridge.mergeSessionList(withFile)).toHaveLength(1);

    // current 列表按项目过滤：别的项目的槽不混进来
    expect(bridge.mergeSessionList([], '/project/other')).toHaveLength(0);
  });

  it('drops a session from the list once its session file is deleted', async () => {
    const { bridge, old } = await makeBridge();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-file-'));
    const file = path.join(tmp, 'A.jsonl');
    fs.writeFileSync(file, '');
    old.session.sessionFile = file;
    old.session.messages = [{ role: 'user', content: '第一条消息' }];
    try {
      // 文件在盘上：正常补一行
      expect(bridge.mergeSessionList([]).map((s) => s.id)).toEqual([old.session.sessionId]);
      // 文件被删（侧栏删除会话）：槽里还留着内存副本，但列表里不该再出现
      fs.rmSync(file);
      expect(bridge.mergeSessionList([])).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('session IPC integration', () => {
  async function setup() {
    const fixture = await makeBridge();
    const handlers = new Map<string, (...args: any[]) => any>();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    registerSessionIpc(fixture.bridge);
    registerMiscIpc(fixture.bridge);
    return {
      ...fixture,
      invoke: (channel: string, ...args: any[]) => handlers.get(channel)!(undefined, ...args)
    };
  }

  it('creates a cross-project new session atomically without creating a second blank session', async () => {
    const { bridge, invoke } = await setup();
    await invoke('pi:newSession', '/project/B');
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(bridge.cwd).toBe('/project/B');
    expect((await invoke('pi:getState')).sessionRevision).toBe(1);
  });

  it('keeps the other project session running in the background when creating a session elsewhere', async () => {
    const { bridge, old, invoke } = await setup();
    old.session.sessionFile = '/session/A.jsonl';
    await bridge.syncSession();
    mocks.disconnect.mockClear();
    mocks.setCwd.mockClear();
    old.session.isStreaming = true;

    await invoke('pi:newSession', '/project/B');

    // 旧项目会话不被中止/销毁：它留在自己的槽里继续跑
    expect(old.session.abort).not.toHaveBeenCalled();
    expect(old.dispose).not.toHaveBeenCalled();
    expect(bridge.sessionSlots().slots.some((s) => s.sessionId === 'A')).toBe(true);
    expect(bridge.cwd).toBe('/project/B');
    // MCP 只有一份客户端集合：重指到焦点项目
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.setCwd).toHaveBeenCalledWith('/project/B');
  });

  it('reports the focused session pending ask and approval for the renderer pull path', async () => {
    const { bridge } = await makeBridge();
    expect(bridge.pendingInteractions()).toEqual({ ask: null, permission: null });

    const pending = askTool.execute(
      'call',
      {
        questions: [{ id: 'q1', question: '继续吗？', options: [{ label: 'A' }, { label: 'B' }] }]
      } as never,
      undefined as never,
      undefined as never,
      { sessionManager: { getSessionId: () => 'A' } } as never
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.pendingInteractions().ask?.sessionId).toBe('A');
    expect(bridge.pendingInteractions().ask?.questions[0].question).toBe('继续吗？');

    vi.mocked(bridge.sessionFor().permissionController.firstPendingRequest).mockReturnValue({
      id: 'req-1',
      toolName: 'bash',
      preview: 'rm -rf /tmp/x',
      requestedAt: 1
    } as never);
    expect(bridge.pendingInteractions().permission?.id).toBe('req-1');

    resolveAsk('A', null);
    await pending;
    expect(bridge.pendingInteractions().ask).toBeNull();
  });

  it('routes an approval decision to the slot that raised it and replays pending on switch back', async () => {
    const { factories, created } = recordingFactories();
    const bridge = makeBridgeStubs(factories);
    const a = makeRuntime('/project/A', 'A');
    a.session.sessionFile = '/session/A.jsonl';
    mocks.createRuntime.mockImplementationOnce(async () => a);
    await bridge.createRuntimeFor('/project/A');
    const slotA = bridge.sessionFor();

    // 同项目新建会话：B 成为焦点，A 进后台（每槽一份控制器）
    await bridge.newSessionInSlot();
    const slotB = bridge.sessionFor();
    expect(slotA.key).not.toBe(slotB.key);
    expect(slotA.permissionController).toBe(created.permission[0]);
    expect(slotB.permissionController).toBe(created.permission[1]);

    // 后台槽 A 的审批请求经自己的 host 推送 → 决策按请求 id 回到 A 的控制器
    bridge.sessionHost(slotA.key).sendSessionEvent('pi:permissionRequest', { id: 'req-A' });
    expect(bridge.resolvePermissionRequest('req-A', 'allow')).toBe(true);
    expect(created.permission[0].resolvePermission).toHaveBeenCalledWith('req-A', 'allow');
    expect(created.permission[1].resolvePermission).not.toHaveBeenCalled();

    // 切回 A：重推本槽挂起的审批（否则用户切过去看不到面板）
    created.permission[0].replayPending.mockClear();
    await bridge.openSessionInSlot('/session/A.jsonl');
    expect(created.permission[0].replayPending).toHaveBeenCalled();
  });

  it('surfaces a background session pending ask in the slot snapshot', async () => {
    const { bridge, old } = await makeBridge();
    old.session.sessionFile = '/session/A.jsonl';
    await bridge.newSessionInSlot();

    const pending = askTool.execute(
      'call',
      {
        questions: [
          { id: 'q1', question: '要不要继续？', options: [{ label: 'A' }, { label: 'B' }] }
        ]
      } as never,
      undefined as never,
      undefined as never,
      { sessionManager: { getSessionId: () => 'A' } } as never
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.sessionSlots().slots.find((s) => s.sessionId === 'A')!.pendingAsks).toBe(1);
    expect(resolveAsk('A', null)).toBe(true);
    await pending;
    expect(bridge.sessionSlots().slots.find((s) => s.sessionId === 'A')!.pendingAsks).toBe(0);
  });

  it('switches across projects without stopping the running session and re-points MCP back', async () => {
    const { bridge, old, invoke } = await setup();
    old.session.sessionFile = '/session/A.jsonl';
    await bridge.syncSession();
    const openSpy = vi
      .spyOn(SessionManager, 'open')
      .mockReturnValue({ getCwd: () => '/project/B' } as any);
    mocks.disconnect.mockClear();
    mocks.setCwd.mockClear();
    old.session.isStreaming = true;

    await invoke('pi:switchSession', '/session/B.jsonl');

    expect(old.session.abort).not.toHaveBeenCalled();
    expect(old.dispose).not.toHaveBeenCalled();
    expect(bridge.cwd).toBe('/project/B');
    expect(mocks.setCwd).toHaveBeenCalledWith('/project/B');

    // 切回 A：复用后台槽（不重建 runtime），MCP 重指回原项目
    mocks.createRuntime.mockClear();
    mocks.disconnect.mockClear();
    mocks.setCwd.mockClear();
    await invoke('pi:switchSession', '/session/A.jsonl');
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(bridge.sessionFor().requireSession()).toBe(old.session);
    expect(bridge.cwd).toBe('/project/A');
    expect(mocks.setCwd).toHaveBeenCalledWith('/project/A');
    openSpy.mockRestore();
  });

  it('keeps the previous session alive in the background when creating a new session', async () => {
    const { bridge, old, invoke } = await setup();
    old.session.sessionFile = '/session/A.jsonl';
    let emit!: (event: any) => void;
    old.session.subscribe.mockImplementation((callback?: any) => {
      emit = callback;
      return old.unsubscribe;
    });
    await bridge.syncSession();

    const previousSessionId = (await invoke('pi:getState')).sessionId;
    await invoke('pi:newSession');

    // 新会话成为焦点；旧会话仍在槽里，runtime 未被销毁（后台继续跑）
    expect((await invoke('pi:getState')).sessionId).not.toBe(previousSessionId);
    expect(old.dispose).not.toHaveBeenCalled();
    expect(old.session.abort).not.toHaveBeenCalled();

    // 旧会话的事件不再推给渲染进程（它已不是焦点槽）
    vi.mocked(bridge.win!.webContents.send).mockClear();
    emit({ type: 'agent_start' });
    expect(bridge.win!.webContents.send).not.toHaveBeenCalled();
  });

  it('reuses the background slot without rebuilding the runtime when switching back', async () => {
    const { bridge, old, invoke } = await setup();
    old.session.sessionFile = '/session/A.jsonl';
    let emit!: (event: any) => void;
    old.session.subscribe.mockImplementation((callback?: any) => {
      emit = callback;
      return old.unsubscribe;
    });
    await bridge.syncSession();
    await invoke('pi:newSession');
    mocks.createRuntime.mockClear();
    vi.mocked(bridge.win!.webContents.send).mockClear();

    // 切回后台会话：复用原槽（不重建 runtime、不重读会话文件），事件重新推给渲染进程
    await invoke('pi:switchSession', '/session/A.jsonl');
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(bridge.sessionFor().requireSession()).toBe(old.session);
    emit({ type: 'agent_start' });
    expect(bridge.win!.webContents.send).toHaveBeenLastCalledWith('pi:event', {
      type: 'agent_start',
      sessionId: 'A',
      sessionRevision: 0
    });
  });

  it('rejects unknown session keys instead of silently falling back to the focused one', async () => {
    const { bridge } = await setup();
    expect(() => bridge.sessionFor('no-such-session')).toThrow('UNKNOWN_SESSION: no-such-session');
  });

  it('binds message pages to state identity and invalidates the snapshot after a switch', async () => {
    const { bridge, old, invoke } = await setup();
    old.session.messages = [{ role: 'user', content: 'A', timestamp: 1 }] as never[];
    const state = await invoke('pi:getState');
    expect(state.messages).toEqual([]);
    const snapshot = invoke('pi:getMessageSnapshot', state);
    expect(invoke('pi:getMessages', snapshot.snapshotId, 0, 200)).toEqual(old.session.messages);
    await bridge.runSessionOperation(async () => {});
    expect(() => invoke('pi:getMessages', snapshot.snapshotId, 0, 200)).toThrow('SESSION_CHANGED');
    expect(() => invoke('pi:getMessageSnapshot', state)).toThrow('SESSION_CHANGED');
  });

  it('releases an idle background slot when its session file is deleted', async () => {
    const { bridge, old, invoke } = await setup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delete-'));
    const file = path.join(tmp, 'A.jsonl');
    fs.writeFileSync(file, '');
    old.session.sessionFile = file;
    old.session.messages = [{ role: 'user', content: 'hi' }];
    // A 退居后台（新建一个会话），删它的文件应该连带释放这个空闲槽
    await invoke('pi:newSession');
    expect(bridge.sessionSlots().slots.some((s) => s.sessionId === 'A')).toBe(true);
    try {
      expect(await invoke('pi:deleteSession', file)).toEqual({ ok: true });
      expect(fs.existsSync(file)).toBe(false);
      expect(bridge.sessionSlots().slots.some((s) => s.sessionId === 'A')).toBe(false);
      expect(bridge.mergeSessionList([])).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to delete the focused session or a background session that is running', async () => {
    const { bridge, old, invoke } = await setup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-delete-'));
    const file = path.join(tmp, 'A.jsonl');
    fs.writeFileSync(file, '');
    old.session.sessionFile = file;
    try {
      await expect(invoke('pi:deleteSession', file)).rejects.toThrow('无法删除当前激活的会话');

      await invoke('pi:newSession');
      old.session.isStreaming = true;
      await expect(invoke('pi:deleteSession', file)).rejects.toThrow('该会话正在后台运行');

      // 两种情况都没删掉文件、槽也还在
      expect(fs.existsSync(file)).toBe(true);
      expect(bridge.sessionSlots().slots.some((s) => s.sessionId === 'A')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('re-scans instead of serving a scan that started before a mutation', async () => {
    const { old, invoke } = await setup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-list-race-'));
    const file = path.join(tmp, 'A.jsonl');
    fs.writeFileSync(file, '');
    old.session.sessionFile = file;
    old.session.messages = [{ role: 'user', content: 'hi' }];
    // A 退居后台（删除时才会释放槽）
    await invoke('pi:newSession');

    // 扫描 mock：调用那一刻取快照；删除之前开始的扫描会卡住（模拟真实扫盘耗时）
    let mutated = false;
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const list = vi.spyOn(SessionManager, 'list');
    const listAll = vi.spyOn(SessionManager, 'listAll');
    list.mockImplementation(async () => {
      const snapshot = mutated ? [] : [{ id: 'A', path: file } as any];
      if (!mutated) await slow;
      return snapshot;
    });
    listAll.mockImplementation(async () => {
      const snapshot = mutated
        ? [{ id: 'B', path: '/tmp/B.jsonl' } as any]
        : [{ id: 'A', path: file } as any];
      if (!mutated) await slow;
      return snapshot;
    });

    try {
      const slowCall = invoke('pi:listSessions');
      await new Promise((r) => setTimeout(r, 0));
      // 扫描还在飞的时候删掉会话：那条扫描的结果已过期
      expect(await invoke('pi:deleteSession', file)).toEqual({ ok: true });
      mutated = true;
      // 删除之后的调用必须自己重扫，不能复用那条过期扫描
      const afterPromise = invoke('pi:listSessions');
      await new Promise((r) => setTimeout(r, 0));
      // 判别点：新调用已发起新扫描（旧实现会等着那条过期扫描，此时一次 listAll 都还没调）
      expect(listAll).toHaveBeenCalled();
      releaseSlow();
      expect((await afterPromise).all.map((s: any) => s.id)).toEqual(['B']);
      // 旧调用方拿到过期结果后也要重扫
      expect((await slowCall).all.map((s: any) => s.id)).toEqual(['B']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      list.mockRestore();
      listAll.mockRestore();
    }
  });

  it('exports a session file that was never loaded without switching sessions', async () => {
    const { old, invoke } = await setup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-export-'));
    const file = path.join(tmp, 'legacy.jsonl');
    fs.writeFileSync(file, '');
    const out = path.join(tmp, 'out.html');
    mocks.createRuntime.mockClear();
    mocks.exportFromFile.mockClear();
    try {
      expect(await invoke('pi:exportSessionHtml', file, out)).toEqual({ ok: true, filePath: out });
      // 免切换：直接用 SDK 的 exportFromFile 读文件导出，不重建 runtime、不中止当前会话
      expect(mocks.exportFromFile).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ outputPath: out })
      );
      expect(mocks.createRuntime).not.toHaveBeenCalled();
      expect(old.session.abort).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exports a session that is already in a slot without switching or aborting anything', async () => {
    const { bridge, old, invoke } = await setup();
    (old.session as any).sessionFile = '/session/A.jsonl';
    const exportToHtml = vi.fn(async () => '/tmp/a.html');
    (old.session as any).exportToHtml = exportToHtml;
    // A 退居后台：新建一个会话，焦点变成新槽
    await invoke('pi:newSession');
    const focused = bridge.sessionFor().requireSession();
    expect(focused).not.toBe(old.session);
    mocks.createRuntime.mockClear();
    mocks.disconnect.mockClear();

    expect(await invoke('pi:exportSessionHtml', '/session/A.jsonl', '/tmp/a.html')).toEqual({
      ok: true,
      filePath: '/tmp/a.html'
    });
    // 直接用后台槽的 session 导出：不重建 runtime、不切焦点、不中止任何一方
    expect(exportToHtml).toHaveBeenCalledWith('/tmp/a.html');
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(bridge.sessionFor().requireSession()).toBe(focused);
    expect(focused.abort).not.toHaveBeenCalled();
    expect(old.session.abort).not.toHaveBeenCalled();
  });

  it('collapses concurrent session list requests into a single scan and reuses the result briefly', async () => {
    const { invoke } = await setup();
    const listSpy = vi.spyOn(SessionManager, 'list').mockResolvedValue([] as never);
    const listAllSpy = vi.spyOn(SessionManager, 'listAll').mockResolvedValue([] as never);
    try {
      const [first, second] = await Promise.all([
        invoke('pi:listSessions'),
        invoke('pi:listSessions')
      ]);
      expect(first).toEqual({ current: [], all: [] });
      expect(second).toEqual({ current: [], all: [] });
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(listAllSpy).toHaveBeenCalledTimes(1);
      // TTL 内的后续请求继续走缓存（agent_end 时侧栏/标题/会话树会各拉一次）
      await invoke('pi:listSessions');
      expect(listSpy).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
      listAllSpy.mockRestore();
    }
  });
});
