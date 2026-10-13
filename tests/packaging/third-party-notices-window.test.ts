/**
 * 开源许可查看窗口（electron/third-party-notices.ts）的单元测试。
 *
 * Electron 全部用替身替换：断言路径解析（打包 / 开发模式）、清单缺失时只弹提示不建窗口、
 * 单例窗口的复用与关闭后重建、主题样式注入，以及加载失败时不留悬空单例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => {
  const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }));

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = [];
    static failLoad = false;

    options: Record<string, unknown>;
    destroyed = false;
    minimized = false;
    focusCount = 0;
    restoreCount = 0;
    showCount = 0;
    insertedCss: string[] = [];
    loadFile = vi.fn(async (_file: string) => {
      if (MockBrowserWindow.failLoad) throw new Error('boom');
    });
    webContents = {
      insertCSS: async (css: string) => {
        this.insertedCss.push(css);
        return 'css-key';
      }
    };
    private listeners = new Map<string, (event: unknown) => void>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockBrowserWindow.instances.push(this);
    }

    on(event: string, handler: (event: unknown) => void) {
      this.listeners.set(event, handler);
      return this;
    }

    /** 测试里手动触发窗口事件（'page-title-updated' / 'closed'） */
    emit(event: string, payload: unknown = { preventDefault: () => {} }) {
      this.listeners.get(event)?.(payload);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.restoreCount += 1;
      this.minimized = false;
    }

    focus() {
      this.focusCount += 1;
    }

    show() {
      this.showCount += 1;
    }

    static reset() {
      MockBrowserWindow.instances = [];
      MockBrowserWindow.failLoad = false;
    }
  }

  return { showMessageBox, MockBrowserWindow, state: { packaged: false, dark: true } };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.state.packaged;
    },
    name: 'Pi Desktop',
    getVersion: () => '1.2.3'
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return mocks.state.dark;
    }
  },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: mocks.MockBrowserWindow
}));

import {
  getThirdPartyNoticesPath,
  openThirdPartyNoticesWindow
} from '../../electron/third-party-notices';

const DEV_NOTICES_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'resources',
  'THIRD-PARTY-NOTICES.txt'
);

/** 决定清单文件「是否存在」：真机上的生成物不入版本库，测试里直接接管 existsSync */
function setNoticesExists(exists: boolean) {
  vi.spyOn(fs, 'existsSync').mockReturnValue(exists);
}

describe('开源许可查看窗口', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 上一个用例可能留下未关闭的窗口（模块内单例是模块级状态）：先派发 closed
    // 让生产代码自己清掉单例引用，避免用例之间串味
    for (const win of mocks.MockBrowserWindow.instances) win.emit('closed');
    mocks.showMessageBox.mockClear();
    mocks.MockBrowserWindow.reset();
    mocks.state.packaged = false;
    mocks.state.dark = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process, 'resourcesPath');
  });

  it('开发模式读仓库 resources 目录，打包后读安装目录根部', () => {
    expect(getThirdPartyNoticesPath()).toBe(DEV_NOTICES_FILE);

    mocks.state.packaged = true;
    Object.defineProperty(process, 'resourcesPath', {
      value: path.join('opt', 'app', 'resources'),
      configurable: true
    });
    expect(getThirdPartyNoticesPath()).toBe(
      path.join('opt', 'app', 'resources', 'THIRD-PARTY-NOTICES.txt')
    );
  });

  it('清单缺失时只弹提示、不建窗口（开发模式忘跑 npm run notices）', async () => {
    setNoticesExists(false);
    const parent = new mocks.MockBrowserWindow({}) as unknown as BrowserWindow;
    mocks.MockBrowserWindow.instances.length = 0; // 父窗口替身本身不算「新建的查看窗口」

    await expect(openThirdPartyNoticesWindow(parent)).resolves.toEqual({
      ok: false,
      error: 'notices-file-missing'
    });

    expect(mocks.MockBrowserWindow.instances).toHaveLength(0);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    const [parentArg, options] = mocks.showMessageBox.mock.calls[0] as unknown as [
      unknown,
      { message: string; detail: string; buttons: string[] }
    ];
    expect(parentArg).toBe(parent);
    expect(options.message).toBe('许可清单尚未生成');
    expect(options.detail).toContain(DEV_NOTICES_FILE);
    expect(options.detail).toContain('npm run notices');
    expect(options.buttons).toEqual(['确定']);
  });

  it('清单存在时打开窗口：载入清单、注入主题样式后再显示', async () => {
    setNoticesExists(true);

    await expect(openThirdPartyNoticesWindow(null)).resolves.toEqual({ ok: true });

    expect(mocks.MockBrowserWindow.instances).toHaveLength(1);
    const win = mocks.MockBrowserWindow.instances[0];
    expect(win.options.title).toBe('开源许可');
    expect(win.options.show).toBe(false);
    expect(win.options.width).toBe(940);
    // Windows/Linux 窗口图标须与主窗口共用同一份资源（否则显示 Electron 默认图标）
    expect(String(win.options.icon).replace(/\\/g, '/')).toMatch(/build\/icons\/icon\.png$/);
    expect(win.options.webPreferences).toEqual({ spellcheck: false });
    expect(win.loadFile).toHaveBeenCalledWith(DEV_NOTICES_FILE);
    expect(win.insertedCss).toHaveLength(1);
    expect(win.insertedCss[0]).toContain('#1e2227'); // 深色主题底色
    expect(win.showCount).toBe(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('浅色主题注入亮色样式，纯文本页不让文件名盖掉窗口标题', async () => {
    setNoticesExists(true);
    mocks.state.dark = false;

    await openThirdPartyNoticesWindow(undefined);

    const win = mocks.MockBrowserWindow.instances[0];
    expect(win.insertedCss[0]).toContain('#ffffff');
    expect(win.options.backgroundColor).toBe('#ffffff');

    const event = { preventDefault: vi.fn() };
    win.emit('page-title-updated', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('重复触发只聚焦已有窗口；最小化时先还原', async () => {
    setNoticesExists(true);

    await openThirdPartyNoticesWindow(null);
    await openThirdPartyNoticesWindow(null);
    expect(mocks.MockBrowserWindow.instances).toHaveLength(1);

    const win = mocks.MockBrowserWindow.instances[0];
    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.showCount).toBe(1);
    expect(win.focusCount).toBe(1);

    win.minimized = true;
    await openThirdPartyNoticesWindow(null);
    expect(win.restoreCount).toBe(1);
    expect(win.focusCount).toBe(2);
    expect(mocks.MockBrowserWindow.instances).toHaveLength(1);
  });

  it('窗口关闭后再次打开会新建（单例已释放）', async () => {
    setNoticesExists(true);

    await openThirdPartyNoticesWindow(null);
    mocks.MockBrowserWindow.instances[0].emit('closed');
    await openThirdPartyNoticesWindow(null);

    expect(mocks.MockBrowserWindow.instances).toHaveLength(2);
    expect(mocks.MockBrowserWindow.instances[0].destroyed).toBe(false);
  });

  it('加载失败时销毁窗口、返回错误，且下次打开不会复用悬空单例', async () => {
    setNoticesExists(true);
    mocks.MockBrowserWindow.failLoad = true;

    const failed = await openThirdPartyNoticesWindow(null);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('boom');

    const first = mocks.MockBrowserWindow.instances[0];
    expect(first.destroyed).toBe(true);
    expect(first.showCount).toBe(0);

    mocks.MockBrowserWindow.failLoad = false;
    await expect(openThirdPartyNoticesWindow(null)).resolves.toEqual({ ok: true });
    expect(mocks.MockBrowserWindow.instances).toHaveLength(2);
    expect(mocks.MockBrowserWindow.instances[1].destroyed).toBe(false);
  });
});
