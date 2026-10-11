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
      return {
        getSize: () => ({ width: 100, height: 100 }),
        resize: () => this,
        toPNG: () => Buffer.from('png')
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
});
