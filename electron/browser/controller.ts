import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  shell,
  type Rectangle
} from 'electron';
import { randomUUID } from 'crypto';
import { mcpManager } from '../mcp/manager';
import { createBrowserMcpConnection } from './mcp-server';
import {
  MAX_EVALUATE_CODE_CHARS,
  buildEvaluateScript,
  clampEvaluateTimeout,
  detectEvaluateMode,
  formatEvaluateResult
} from './evaluate';
import {
  TrafficRecorder,
  formatConsoleList,
  formatNetworkDetail,
  formatNetworkList
} from './traffic';
import { BROWSER_BLANK_URL, isAllowedBrowserUrl, normalizeBrowserInput } from './url';
import type { BrowserSnapshot, BrowserState, BrowserTabState, BrowserViewport } from './types';
import type { DebuggerHost, NetworkListOptions, TrafficState } from './traffic';

const BROWSER_PARTITION = 'persist:pi-browser';
const MAX_SNAPSHOT_TEXT = 30_000;
const MAX_SNAPSHOT_ELEMENTS = 200;

export function normalizeBrowserTabId(tabId: string): string {
  return tabId.startsWith('browser:') ? tabId.slice('browser:'.length) : tabId;
}

interface BrowserTab {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
  loading: boolean;
  error?: string;
  snapshotRefs: Set<string>;
}

export class BrowserController {
  private win: BrowserWindow | null = null;
  private enabled = false;
  /** 调试能力（CDP 抓包 + 执行任意 JS）开关，由设置页的独立开关控制，默认关 */
  private devtoolsEnabled = false;
  private traffic = new TrafficRecorder();
  private tabs = new Map<string, BrowserTab>();
  private activeTabId: string | null = null;
  private viewport: Rectangle = { x: 0, y: 0, width: 1, height: 1 };
  private visible = false;
  private partitionConfigured = false;

  attachWindow(win: BrowserWindow): void {
    this.win = win;
    this.updateViewVisibility();
  }

  detachWindow(): void {
    this.destroyTabs();
    this.win = null;
  }

  async setEnabled(enabled: boolean): Promise<BrowserState> {
    if (this.enabled === enabled) return this.getState();
    this.enabled = enabled;
    if (enabled) {
      this.configurePartition();
      mcpManager.registerBuiltin('pi-browser', () => createBrowserMcpConnection(this));
    } else {
      await mcpManager.unregisterBuiltin('pi-browser');
      this.destroyTabs();
    }
    this.emitState();
    return this.getState();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 开关调试能力：开启时给所有已存在标签挂 CDP，关闭时全部断开并丢弃缓冲。
   * 与浏览器总开关解耦：只想让 Agent 看网页而不想让它跑 JS/看接口时，单独关这个即可。
   */
  async setDevtoolsEnabled(enabled: boolean): Promise<BrowserState> {
    if (this.devtoolsEnabled === enabled) return this.getState();
    this.devtoolsEnabled = enabled;
    if (enabled) {
      for (const tab of this.tabs.values()) await this.attachTraffic(tab);
    } else {
      this.traffic.detachAll();
    }
    return this.getState();
  }

  isDevtoolsEnabled(): boolean {
    return this.devtoolsEnabled;
  }

  getState(): BrowserState {
    return {
      enabled: this.enabled,
      tabs: [...this.tabs.values()].map((tab) => this.toState(tab)),
      activeTabId: this.activeTabId
    };
  }

  async open(input?: string, focus = true): Promise<BrowserTabState> {
    this.assertEnabled();
    const url = normalizeBrowserInput(input);
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });
    view.setBackgroundColor('#1e1e1e');
    const tab: BrowserTab = {
      id,
      view,
      title: '新标签页',
      url: url === BROWSER_BLANK_URL ? '' : url,
      loading: false,
      snapshotRefs: new Set()
    };
    this.tabs.set(id, tab);
    this.installWebContentsHandlers(tab);
    this.win?.contentView.addChildView(view);
    this.activeTabId = id;
    this.updateViewVisibility();
    this.emitState();
    if (focus) this.emitFocusRequested(id);
    // CDP 必须在视图加入窗口之后再挂（对未挂载的 WebContentsView 调 attach 会失败或挂死），
    // 但要赶在 loadURL 前面，否则首个文档请求抓不到
    await this.attachTraffic(tab);

    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      tab.error = error instanceof Error ? error.message : String(error);
      tab.loading = false;
      this.emitState();
    }
    return this.toState(tab);
  }

  close(tabId?: string): BrowserState {
    const id = tabId ? normalizeBrowserTabId(tabId) : this.activeTabId;
    if (!id) return this.getState();
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    const tab = this.tabs.get(id);
    if (!tab) return this.getState();
    this.destroyTab(tab);
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      const nextIds = [...this.tabs.keys()];
      this.activeTabId = nextIds[Math.min(Math.max(index, 0), nextIds.length - 1)] || null;
    }
    this.updateViewVisibility();
    this.emitState();
    return this.getState();
  }

  activate(tabId: string, focus = false): BrowserTabState {
    this.assertEnabled();
    const id = normalizeBrowserTabId(tabId);
    const tab = this.requireTab(id);
    this.activeTabId = id;
    this.updateViewVisibility();
    this.emitState();
    if (focus) this.emitFocusRequested(id);
    return this.toState(tab);
  }

  async navigate(tabId: string | undefined, input: string): Promise<BrowserTabState> {
    this.assertEnabled();
    const tab = tabId ? this.requireTab(normalizeBrowserTabId(tabId)) : this.getActiveTab();
    if (!tab) return this.open(input);
    const url = normalizeBrowserInput(input);
    this.invalidateSnapshot(tab);
    tab.error = undefined;
    await tab.view.webContents.loadURL(url);
    return this.toState(tab);
  }

  back(tabId?: string): BrowserTabState {
    const tab = this.resolveTab(tabId);
    if (tab.view.webContents.canGoBack()) tab.view.webContents.goBack();
    return this.toState(tab);
  }

  forward(tabId?: string): BrowserTabState {
    const tab = this.resolveTab(tabId);
    if (tab.view.webContents.canGoForward()) tab.view.webContents.goForward();
    return this.toState(tab);
  }

  reload(tabId?: string): BrowserTabState {
    const tab = this.resolveTab(tabId);
    tab.view.webContents.reload();
    return this.toState(tab);
  }

  stop(tabId?: string): BrowserTabState {
    const tab = this.resolveTab(tabId);
    tab.view.webContents.stop();
    return this.toState(tab);
  }

  setViewport(viewport: BrowserViewport): void {
    this.viewport = {
      x: Math.max(0, Math.round(viewport.x)),
      y: Math.max(0, Math.round(viewport.y)),
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height))
    };
    this.updateViewVisibility();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateViewVisibility();
  }

  async clearData(): Promise<void> {
    const ses = electronSession.fromPartition(BROWSER_PARTITION);
    await Promise.all([ses.clearStorageData(), ses.clearCache()]);
  }

  async snapshot(tabId?: string): Promise<BrowserSnapshot> {
    const tab = this.resolveTab(tabId);
    const result = (await tab.view.webContents.executeJavaScript(`(() => {
      const maxText = ${MAX_SNAPSHOT_TEXT};
      const maxElements = ${MAX_SNAPSHOT_ELEMENTS};
      document.querySelectorAll('[data-pi-browser-ref]').forEach((el) => el.removeAttribute('data-pi-browser-ref'));
      const selectors = 'a[href],button,input,textarea,select,summary,[role="button"],[contenteditable="true"],[tabindex]';
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const elements = Array.from(document.querySelectorAll(selectors)).filter(visible).slice(0, maxElements).map((el, i) => {
        const ref = 'e' + (i + 1);
        el.setAttribute('data-pi-browser-ref', ref);
        const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'input', TEXTAREA: 'textbox', SELECT: 'select' }[el.tagName] || '');
        const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 300);
        const value = 'value' in el ? String(el.value || '').slice(0, 500) : undefined;
        return { ref, tag: el.tagName.toLowerCase(), role, name, ...(value ? { value } : {}) };
      });
      return {
        title: document.title || '',
        url: location.href,
        text: (document.body?.innerText || '').trim().slice(0, maxText),
        elements
      };
    })()`)) as BrowserSnapshot;
    tab.snapshotRefs = new Set(result.elements.map((element) => element.ref));
    return result;
  }

  async screenshot(tabId?: string): Promise<{ data: string; mimeType: string }> {
    const tab = this.resolveTab(tabId);
    let image = await tab.view.webContents.capturePage();
    const size = image.getSize();
    if (size.width > 1600) image = image.resize({ width: 1600, quality: 'good' });
    return { data: image.toPNG().toString('base64'), mimeType: 'image/png' };
  }

  async click(tabId: string | undefined, ref: string): Promise<void> {
    const tab = this.resolveRef(tabId, ref);
    await tab.view.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-pi-browser-ref=${JSON.stringify(ref)}]');
      if (!el) throw new Error('页面元素已失效，请重新获取 snapshot');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      el.click();
    })()`);
  }

  async type(tabId: string | undefined, ref: string, text: string, clear = true): Promise<void> {
    const tab = this.resolveRef(tabId, ref);
    await tab.view.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-pi-browser-ref=${JSON.stringify(ref)}]');
      if (!el) throw new Error('页面元素已失效，请重新获取 snapshot');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const text = ${JSON.stringify(text)};
      const clear = ${JSON.stringify(clear)};
      if (el.isContentEditable) {
        el.textContent = clear ? text : (el.textContent || '') + text;
      } else if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = clear ? text : String(el.value || '') + text;
        if (setter) setter.call(el, next); else el.value = next;
      } else {
        throw new Error('目标元素不可输入');
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  press(tabId: string | undefined, key: string): void {
    const tab = this.resolveTab(tabId);
    tab.view.webContents.focus();
    tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1) tab.view.webContents.sendInputEvent({ type: 'char', keyCode: key });
    tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }

  async wait(
    tabId: string | undefined,
    options: { text?: string; milliseconds?: number; timeoutMs?: number }
  ): Promise<void> {
    const tab = this.resolveTab(tabId);
    if (options.milliseconds !== undefined) {
      const delay = Math.min(10_000, Math.max(0, options.milliseconds));
      await new Promise((resolve) => setTimeout(resolve, delay));
      return;
    }
    if (!options.text) throw new Error('wait 需要 text 或 milliseconds');
    const timeout = Math.min(10_000, Math.max(100, options.timeoutMs ?? 5_000));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await tab.view.webContents.executeJavaScript(
        `Boolean(document.body?.innerText?.includes(${JSON.stringify(options.text)}))`
      );
      if (found) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`等待文本超时: ${options.text}`);
  }

  /**
   * 在页面里执行任意 JS。
   * 先在主进程里判断代码是表达式（`document.title`）还是语句体（`const a = 1; return a;`），
   * 用对应模板包一层后在页面主世界执行；返回值在页面内安全序列化后转成文本。
   */
  async evaluate(tabId: string | undefined, code: string, timeoutMs?: number): Promise<string> {
    this.assertDevtoolsEnabled();
    const tab = this.resolveTab(tabId);
    if (typeof code !== 'string' || !code.trim()) throw new Error('要执行的代码不能为空');
    if (code.length > MAX_EVALUATE_CODE_CHARS) {
      throw new Error(`代码过长（上限 ${MAX_EVALUATE_CODE_CHARS} 字符）`);
    }
    const timeout = clampEvaluateTimeout(timeoutMs);
    // 先解析出包装模式再执行一次，避免「执行失败再换模式重试」造成副作用翻倍
    const script = buildEvaluateScript(code, detectEvaluateMode(code));
    const raw = await this.runEvaluate(tab, script, timeout);
    return formatEvaluateResult(raw);
  }

  networkList(tabId: string | undefined, options: NetworkListOptions = {}): string {
    const { state } = this.requireTraffic(tabId);
    return formatNetworkList(state.entries, options);
  }

  networkDetail(tabId: string | undefined, requestId: string): string {
    const { tabId: id, state } = this.requireTraffic(tabId);
    if (!requestId) throw new Error('缺少 requestId，请先用 network_list 获取');
    const entry =
      this.traffic.find(id, requestId) ??
      state.entries.find((item) => item.requestId === requestId);
    if (!entry) {
      throw new Error(
        `未找到请求 ${requestId}（可能已被缓冲淘汰，请用 network_list 查看现有记录）`
      );
    }
    return formatNetworkDetail(entry);
  }

  consoleList(tabId: string | undefined, limit?: number): string {
    const { state } = this.requireTraffic(tabId);
    return formatConsoleList(state.consoleEntries, limit);
  }

  devtoolsClear(tabId: string | undefined, what: 'network' | 'console' | 'all' = 'all'): string {
    this.assertDevtoolsEnabled();
    if (what !== 'network' && what !== 'console' && what !== 'all') {
      throw new Error(`未知清空目标: ${what}（可选 network/console/all）`);
    }
    const label = { network: '网络记录', console: '控制台记录', all: '网络与控制台记录' }[what];
    if (tabId) {
      const tab = this.resolveTab(tabId);
      this.traffic.clear(tab.id, what);
      return `已清空标签 ${tab.id} 的${label}`;
    }
    this.traffic.clear(undefined, what);
    return `已清空全部标签的${label}`;
  }

  private async attachTraffic(tab: BrowserTab): Promise<void> {
    if (!this.devtoolsEnabled) return;
    // WebContents.debugger 结构上满足 DebuggerHost；显式转换以免被 Electron 的重载签名挡住
    await this.traffic.attach(tab.id, tab.view.webContents as unknown as DebuggerHost);
  }

  private async runEvaluate(tab: BrowserTab, script: string, timeoutMs: number): Promise<unknown> {
    const execution = tab.view.webContents.executeJavaScript(script);
    // 超时后引擎可能稍后才 reject，先挂一个空 catch 避免 unhandled rejection
    execution.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void this.traffic.terminateExecution(tab.id);
        reject(new Error(`执行超时（超过 ${timeoutMs}ms），已尝试中止脚本`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([execution, watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private requireTraffic(tabId?: string): { tabId: string; state: TrafficState } {
    this.assertDevtoolsEnabled();
    const tab = this.resolveTab(tabId);
    const state = this.traffic.getState(tab.id);
    if (!state) throw new Error('该标签没有调试通道，请重新打开标签页后再试');
    if (!state.attached) {
      throw new Error(
        `调试通道不可用：${state.attachError ?? '未建立'}（若已为该标签打开 DevTools，请先关闭后重试）`
      );
    }
    return { tabId: tab.id, state };
  }

  private assertDevtoolsEnabled(): void {
    if (!this.devtoolsEnabled) {
      throw new Error('浏览器调试未启用，请先在设置页「浏览器」中开启「调试抓包与执行 JS」');
    }
  }

  private configurePartition(): void {
    if (this.partitionConfigured) return;
    this.partitionConfigured = true;
    const ses = electronSession.fromPartition(BROWSER_PARTITION);
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.on('will-download', (event, item) => {
      event.preventDefault();
      const url = item.getURL();
      if (isAllowedBrowserUrl(url)) void shell.openExternal(url);
    });
  }

  private installWebContentsHandlers(tab: BrowserTab): void {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url) && url !== BROWSER_BLANK_URL) void this.open(url, true);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!isAllowedBrowserUrl(url)) event.preventDefault();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.error = undefined;
      this.invalidateSnapshot(tab);
      this.refreshTabState(tab);
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.refreshTabState(tab);
    });
    wc.on('did-navigate', () => this.refreshTabState(tab));
    wc.on('did-navigate-in-page', () => this.refreshTabState(tab));
    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      tab.title = title || '新标签页';
      this.emitState();
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      tab.loading = false;
      tab.error = `${errorDescription} (${errorCode})`;
      tab.url = validatedURL;
      this.emitState();
    });
  }

  private refreshTabState(tab: BrowserTab): void {
    const url = tab.view.webContents.getURL();
    tab.url = url === BROWSER_BLANK_URL ? '' : url;
    tab.title = tab.view.webContents.getTitle() || (tab.url ? tab.url : '新标签页');
    this.emitState();
  }

  private toState(tab: BrowserTab): BrowserTabState {
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      canGoBack: tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward(),
      ...(tab.error ? { error: tab.error } : {})
    };
  }

  private updateViewVisibility(): void {
    for (const tab of this.tabs.values()) {
      const show = !!this.win && this.visible && tab.id === this.activeTabId;
      tab.view.setVisible(show);
      if (show) tab.view.setBounds(this.viewport);
    }
  }

  private emitState(): void {
    const win = this.win;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      const wc = win.webContents;
      if (!wc.isDestroyed()) wc.send('pi:browserStateChanged', this.getState());
    } catch {}
  }

  private emitFocusRequested(tabId: string): void {
    const win = this.win;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      const wc = win.webContents;
      if (!wc.isDestroyed()) wc.send('pi:browserFocusRequested', tabId);
    } catch {}
  }

  private invalidateSnapshot(tab: BrowserTab): void {
    tab.snapshotRefs.clear();
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error('内置浏览器未启用，请先在设置页开启');
  }

  private requireTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`浏览器标签不存在: ${tabId}`);
    return tab;
  }

  private getActiveTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }

  private resolveTab(tabId?: string): BrowserTab {
    this.assertEnabled();
    const tab = tabId ? this.tabs.get(normalizeBrowserTabId(tabId)) : this.getActiveTab();
    if (!tab) throw new Error('没有可用的浏览器标签');
    return tab;
  }

  private resolveRef(tabId: string | undefined, ref: string): BrowserTab {
    const tab = this.resolveTab(tabId);
    if (!tab.snapshotRefs.has(ref)) throw new Error('页面元素引用已失效，请重新获取 snapshot');
    return tab;
  }

  private destroyTab(tab: BrowserTab): void {
    this.traffic.detach(tab.id);
    try {
      this.win?.contentView.removeChildView(tab.view);
    } catch {}
    try {
      tab.view.webContents.close();
    } catch {}
  }

  private destroyTabs(): void {
    for (const tab of this.tabs.values()) this.destroyTab(tab);
    this.traffic.detachAll();
    this.tabs.clear();
    this.activeTabId = null;
    this.emitState();
  }
}
