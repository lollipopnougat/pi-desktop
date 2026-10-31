import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) || []), handler]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const handler of this.handlers.get(event) || []) handler(...args);
    }
  }

  class WebContents extends Emitter {
    url = 'about:blank';
    title = '';
    closed = false;
    /** capturePage 是否返回空图（true/固定，或按第几次调用返回） */
    captureEmpty: boolean | ((call: number) => boolean) = false;
    /** 非空时 capturePage 抛一个 message 等于它的 Error（模拟 Chromium CopyFromSurfaceError） */
    captureError: string | ((call: number) => string | null) | null = null;
    captureCalls = 0;
    windowOpenHandler?: (details: { url: string }) => { action: string };
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler;
    }
    async loadURL(url: string) {
      this.emit('did-start-loading');
      this.url = url;
      this.title = url === 'about:blank' ? '' : 'Loaded';
      this.emit('did-navigate');
      this.emit('did-stop-loading');
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    canGoBack() {
      return false;
    }
    canGoForward() {
      return false;
    }
    goBack() {}
    goForward() {}
    reload() {}
    stop() {}
    close() {
      this.closed = true;
    }
    focus() {}
    sendInputEvent() {}
    async executeJavaScript() {
      return {};
    }
    async capturePage() {
      this.captureCalls += 1;
      const thrown =
        typeof this.captureError === 'function'
          ? this.captureError(this.captureCalls)
          : this.captureError;
      if (thrown) throw new Error(thrown);
      const empty =
        typeof this.captureEmpty === 'function'
          ? this.captureEmpty(this.captureCalls)
          : this.captureEmpty;
      return {
        isEmpty: () => empty,
        getSize: () => ({ width: 100, height: 100 }),
        resize: () => this,
        toDataURL: () =>
          `data:image/png;base64,${Buffer.from(empty ? '' : 'png').toString('base64')}`,
        toPNG: () => Buffer.from(empty ? '' : 'png')
      };
    }
  }

  class WebContentsView {
    webContents = new WebContents();
    visible = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    options: any;
    constructor(options: any) {
      this.options = options;
      views.push(this);
    }
    setBackgroundColor() {}
    setVisible(value: boolean) {
      this.visible = value;
    }
    setBounds(value: any) {
      this.bounds = value;
    }
  }

  const views: WebContentsView[] = [];
  const sent: any[][] = [];
  const registered = new Map<string, unknown>();
  return { WebContentsView, views, sent, registered };
});

vi.mock('electron', () => ({
  WebContentsView: mocks.WebContentsView,
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      clearStorageData: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {})
    })
  },
  shell: { openExternal: vi.fn(async () => {}) }
}));

vi.mock('../../electron/mcp/manager', () => ({
  mcpManager: {
    registerBuiltin: vi.fn((name: string, connector: unknown) =>
      mocks.registered.set(name, connector)
    ),
    unregisterBuiltin: vi.fn(async (name: string) => mocks.registered.delete(name))
  }
}));

vi.mock('../../electron/browser/mcp-server', () => ({
  createBrowserMcpConnection: vi.fn()
}));

import { BrowserController, normalizeBrowserTabId } from '../../electron/browser/controller';

function createWindow() {
  const children: any[] = [];
  return {
    children,
    contentView: {
      addChildView: (view: any) => children.push(view),
      removeChildView: (view: any) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }
    },
    webContents: {
      isDestroyed: () => false,
      send: (...args: any[]) => mocks.sent.push(args)
    }
  };
}

describe('BrowserController', () => {
  beforeEach(() => {
    mocks.views.length = 0;
    mocks.sent.length = 0;
    mocks.registered.clear();
  });

  it('creates isolated views, updates bounds, and destroys tabs when disabled', async () => {
    const controller = new BrowserController();
    const win = createWindow();
    controller.attachWindow(win as any);
    await controller.setEnabled(true);
    expect(mocks.registered.has('pi-browser')).toBe(true);

    const tab = await controller.open('example.com');
    const view = mocks.views[0];
    expect(tab.url).toBe('https://example.com/');
    expect(view.options.webPreferences).toMatchObject({
      partition: 'persist:pi-browser',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    });

    controller.setViewport({ x: 10.4, y: 20.6, width: 500.2, height: 399.8 });
    controller.setVisible(true);
    expect(view.bounds).toEqual({ x: 10, y: 21, width: 500, height: 400 });
    expect(view.visible).toBe(true);

    await controller.setEnabled(false);
    expect(view.webContents.closed).toBe(true);
    expect(win.children).toHaveLength(0);
    expect(controller.getState()).toEqual({ enabled: false, tabs: [], activeTabId: null });
  });

  it('routes HTTP popups to a new tab and rejects the native window', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('https://example.com');

    const result = mocks.views[0].webContents.windowOpenHandler?.({
      url: 'https://example.org'
    });
    expect(result).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(controller.getState().tabs).toHaveLength(2));
  });

  it('accepts renderer workspace ids with the browser prefix', async () => {
    expect(normalizeBrowserTabId('browser:tab-1')).toBe('tab-1');
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    const tab = await controller.open();
    expect(controller.activate(`browser:${tab.id}`).id).toBe(tab.id);
    expect((await controller.navigate(`browser:${tab.id}`, 'example.com')).url).toBe(
      'https://example.com/'
    );
  });

  it('returns a png base64 screenshot for a painted view', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');

    const image = await controller.screenshot();
    expect(image.mimeType).toBe('image/png');
    expect(image.data).toBe(Buffer.from('png').toString('base64'));
  });

  it('retries once when the first capture comes back empty', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    const webContents = mocks.views[0].webContents;
    webContents.captureEmpty = (call) => call === 1;

    const image = await controller.screenshot();
    expect(webContents.captureCalls).toBe(2);
    expect(image.data.length).toBeGreaterThan(0);
  });

  it('throws instead of returning an empty image (which would poison the session)', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    mocks.views[0].webContents.captureEmpty = true;

    await expect(controller.screenshot()).rejects.toThrow(/画面为空/);
  });

  it('retries a thrown capture error (e.g. UnknownVizError) and then succeeds', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    const webContents = mocks.views[0].webContents;
    webContents.captureError = (call) => (call === 1 ? 'UnknownVizError' : null);

    const image = await controller.screenshot();
    expect(webContents.captureCalls).toBe(2);
    expect(image.data).toBe(Buffer.from('png').toString('base64'));
  });

  it('explains UnknownVizError in Chinese and points at snapshot', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    const webContents = mocks.views[0].webContents;
    webContents.captureError = 'UnknownVizError';

    // 重试仍是同一个错误 → 报错，但不泄英文枚举名而不带建议
    await expect(controller.screenshot()).rejects.toThrow(/合成器回读画面失败[\s\S]*snapshot/);
    expect(webContents.captureCalls).toBe(2);
  });

  it('maps the other CopyFromSurfaceError codes to actionable hints', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    const webContents = mocks.views[0].webContents;

    webContents.captureError = 'Current display surface not available for capture';
    await expect(controller.screenshot()).rejects.toThrow(/还没合成过画面/);

    webContents.captureError = 'Timeout';
    await expect(controller.screenshot()).rejects.toThrow(/截图超时/);

    webContents.captureError = 'Frame Gone';
    await expect(controller.screenshot()).rejects.toThrow(/换掉了渲染表面/);
  });

  it('keeps the frozen-panel capture best-effort but retries it', async () => {
    const controller = new BrowserController();
    controller.attachWindow(createWindow() as any);
    await controller.setEnabled(true);
    await controller.open('example.com');
    const webContents = mocks.views[0].webContents;

    webContents.captureError = (call) => (call === 1 ? 'UnknownVizError' : null);
    await expect(controller.captureActiveTab()).resolves.toMatch(/^data:image\/png/);

    // 两次都失败：静态底图是尽力而为，返回 null 而不是抛错
    webContents.captureError = 'UnknownVizError';
    await expect(controller.captureActiveTab()).resolves.toBeNull();
  });
});
