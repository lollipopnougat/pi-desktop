import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  disconnect: vi.fn(async () => {}),
  autoConnect: vi.fn(async () => {}),
  setCwd: vi.fn(),
  killTerminals: vi.fn()
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

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiBridge } from '../../electron/pi-bridge';
import { ipcMain } from 'electron';
import { registerSessionIpc } from '../../electron/ipc/session-ipc';
import { registerMiscIpc } from '../../electron/ipc/misc-ipc';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function makeRuntime(cwd: string, id: string) {
  const unsubscribe = vi.fn();
  const session = {
    sessionId: id,
    messages: [],
    sessionFile: undefined,
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: vi.fn(() => unsubscribe),
    getActiveToolNames: () => [],
    setActiveToolsByName: vi.fn()
  };
  return {
    cwd,
    session,
    dispose: vi.fn(async () => {}),
    setBeforeSessionInvalidate: vi.fn(),
    setRebindSession: vi.fn(),
    unsubscribe
  };
}
function makeBridge() {
  const bridge = new PiBridge();
  bridge.cwd = '/project/A';
  bridge.permissionController = { clearPending: vi.fn(), install: vi.fn() } as any;
  bridge.planController = { cancelPending: vi.fn(), onSessionSwitch: vi.fn() } as any;
  bridge.goalController = { onSessionSwitch: vi.fn() } as any;
  bridge.memoryController = { onSessionSwitch: vi.fn(), dispose: vi.fn(async () => {}) } as any;
  bridge.subagentController = { dispose: vi.fn(async () => {}), onSessionSwitch: vi.fn() } as any;
  bridge.backgroundTaskController = { dispose: vi.fn(async () => {}) } as any;
  bridge.browserController = { setEnabled: vi.fn(async () => {}) } as any;
  bridge.win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  } as any;
  const old = makeRuntime(bridge.cwd, 'A');
  bridge.runtime = old;
  bridge.session = old.session;
  return { bridge, old };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(SessionManager, 'create').mockReturnValue({} as any);
  mocks.createRuntime.mockImplementation(async (_factory, opts) => makeRuntime(opts.cwd, 'B'));
});

describe('PiBridge runtime lifecycle', () => {
  it('awaits old runtime shutdown before constructing a replacement', async () => {
    const { bridge, old } = makeBridge();
    const shutdown = deferred();
    const entered = deferred();
    old.dispose.mockImplementation(async () => {
      expect(bridge.getSession()).toBe(old.session);
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
    expect(bridge.getSession().sessionId).toBe('B');
    expect(bridge.cwd).toBe('/project/B');
    expect(mocks.setCwd).toHaveBeenLastCalledWith('/project/B');
  });

  it('makes quit idempotent and awaits asynchronous cleanup before disconnecting MCP', async () => {
    const { bridge, old } = makeBridge();
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
    const { bridge, old } = makeBridge();
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
    const { bridge, old } = makeBridge();
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

  it('recovers from SDK creation failure after invalidating the old session', async () => {
    const { bridge, old } = makeBridge();
    await expect(
      bridge.runSessionOperation(async () => {
        old.session.dispose();
        bridge.session = null;
        throw new Error('new session failed');
      })
    ).rejects.toThrow('new session failed');
    expect(bridge.getSession()).not.toBe(old.session);
    expect(old.dispose).not.toHaveBeenCalled();
    await expect(bridge.runSessionOperation(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('tags SDK events with the current session and blocks events while replacing', async () => {
    const { bridge, old } = makeBridge();
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

describe('session IPC integration', () => {
  function setup() {
    const fixture = makeBridge();
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
    const { bridge, invoke } = setup();
    await invoke('pi:newSession', '/project/B');
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(bridge.cwd).toBe('/project/B');
    expect((await invoke('pi:getState')).sessionRevision).toBe(1);
  });

  it('binds message pages to state identity and invalidates the snapshot after a switch', async () => {
    const { bridge, old, invoke } = setup();
    old.session.messages = [{ role: 'user', content: 'A', timestamp: 1 }] as never[];
    const state = await invoke('pi:getState');
    expect(state.messages).toEqual([]);
    const snapshot = invoke('pi:getMessageSnapshot', state);
    expect(invoke('pi:getMessages', snapshot.snapshotId, 0, 200)).toEqual(old.session.messages);
    await bridge.runSessionOperation(async () => {});
    expect(() => invoke('pi:getMessages', snapshot.snapshotId, 0, 200)).toThrow('SESSION_CHANGED');
    expect(() => invoke('pi:getMessageSnapshot', state)).toThrow('SESSION_CHANGED');
  });

  it('restores an unsaved session manager after HTML export and excludes concurrent switches', async () => {
    const { bridge, old, invoke } = setup();
    const manager = { unsavedHistory: ['draft'] };
    (old.session as any).sessionManager = manager;
    const exported = makeRuntime('/project/export', 'export');
    const exporting = deferred();
    const release = deferred();
    (exported.session as any).exportToHtml = async () => {
      exporting.resolve();
      await release.promise;
      return '/tmp/export.html';
    };
    (old as any).switchSession = vi.fn(async () => {
      bridge.runtime = exported;
      bridge.session = exported.session;
      return { cancelled: false };
    });
    const result = invoke('pi:exportSessionHtml', '/session/export.jsonl', '/tmp/export.html');
    await exporting.promise;
    let nextStarted = false;
    const next = bridge.runSessionOperation(async () => {
      nextStarted = true;
      expect(bridge.cwd).toBe('/project/A');
    });
    expect(nextStarted).toBe(false);
    release.resolve();
    await result;
    await next;
    expect(mocks.createRuntime.mock.calls[0][1].sessionManager).toBe(manager);
    expect(nextStarted).toBe(true);
  });
});
