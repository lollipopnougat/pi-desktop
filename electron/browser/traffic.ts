/**
 * 浏览器调试采集器：通过 CDP（webContents.debugger）抓网络请求与控制台输出。
 *
 * 为什么走 CDP 而不是 session.webRequest：Electron 的 webRequest 只能拿到 URL/方法/
 * 头部/状态码，**拿不到请求体和响应体**；CDP 的 Network 域可以用
 * `Network.getResponseBody` 取回完整响应体，顺带用 Runtime 域拿到 console 输出与
 * 未捕获异常（webRequest 完全没有这些）。
 *
 * 约束与取舍：
 * - 同一个 webContents 只能挂一个 debugger：用户若对该标签打开了 DevTools，attach 会
 *   失败。此时记录 attachError 交给上层提示，不影响 evaluate（它不依赖 CDP）
 * - CDP 事件量极大，必须限流：网络条目与 console 各自环形缓冲，body 单独计账并在超限
 *   时优先淘汰最旧条目的 body（保留元数据）
 * - 本模块不 import electron，方便单测（只需传入结构等价的 debugger 宿主对象）
 */

/** CDP debugger 的结构子集（真实对象是 Electron 的 webContents.debugger） */
export interface DebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): void;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
}

export interface DebuggerHost {
  debugger: DebuggerLike;
}

export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  postDataTruncated?: boolean;
  startedAt: number;
  startedAtMonotonic?: number;
  durationMs?: number;
  encodedDataLength?: number;
  fromCache?: boolean;
  failed?: string;
  finished: boolean;
  redirectedFrom?: string;
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  bodyEvicted?: boolean;
  bodyError?: string;
  /** 内部记账：本条 body 计入 bodyChars 的字符数（淘汰时要用它回退） */
  countedBodyChars?: number;
}

export interface ConsoleEntry {
  id: number;
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
  truncated?: boolean;
}

export interface AttachResult {
  ok: boolean;
  attached: boolean;
  error?: string;
}

export interface TrafficState {
  attached: boolean;
  attachError?: string;
  entries: NetworkEntry[];
  consoleEntries: ConsoleEntry[];
}

/** 每个标签最多保留的网络条目数 */
const MAX_NETWORK_ENTRIES = 300;
/** 单条响应体/请求体的最大字符数（超出截断并打标记） */
const MAX_BODY_CHARS = 200_000;
const MAX_POST_DATA_CHARS = 20_000;
/** 单个标签所有响应体的总字符预算，超限时淘汰最旧条目的 body */
const MAX_TOTAL_BODY_CHARS = 4_000_000;
/** console 缓冲条目数与单条文本上限 */
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_TEXT_CHARS = 4_000;
/** 单条 CDP 命令的超时（调试通道偶发挂死时不能把打开标签/执行流程一起拖死） */
const DEBUGGER_COMMAND_TIMEOUT_MS = 3_000;
/** attach 后要开启的 CDP 域：Network 抓请求/响应，Runtime 拿 console 与异常 */
const ENABLE_COMMANDS: Array<[string, unknown]> = [
  [
    'Network.enable',
    { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 65_536 }
  ],
  ['Runtime.enable', undefined]
];

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface TabTraffic {
  host: DebuggerHost;
  attached: boolean;
  attachError?: string;
  entries: NetworkEntry[];
  index: Map<string, NetworkEntry>;
  consoleEntries: ConsoleEntry[];
  bodyChars: number;
  consoleSeq: number;
  listener?: (event: unknown, method: string, params: any) => void;
  detachListener?: (event: unknown, reason: string) => void;
}

function truncate(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

function toHeaderRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return Object.keys(result).length ? result : undefined;
}

/** 把 CDP 的 RemoteObject 转成可读文本（console 参数） */
export function formatRemoteObject(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg !== 'object') return String(arg);
  const remote = arg as Record<string, any>;
  if (remote.unserializableValue !== undefined) return String(remote.unserializableValue);
  if (remote.value !== undefined) {
    return typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value);
  }
  if (typeof remote.description === 'string') return remote.description;
  if (remote.preview && typeof remote.preview === 'object') {
    const preview = remote.preview as Record<string, any>;
    const properties = Array.isArray(preview.properties)
      ? preview.properties
          .slice(0, 20)
          .map((item: any) => `${item?.name}: ${item?.value ?? item?.type ?? ''}`)
          .join(', ')
      : '';
    return `${preview.description ?? remote.type ?? 'object'}${properties ? ` { ${properties} }` : ''}`;
  }
  return typeof remote.type === 'string' ? remote.type : 'object';
}

function formatUrlForLine(url: string, max = 300): string {
  return url.length <= max ? url : `${url.slice(0, max)}…`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

export interface NetworkListOptions {
  limit?: number;
  urlFilter?: string;
  onlyFailed?: boolean;
}

/** 网络请求列表（紧凑文本，供 Agent 阅读；body 需用 network_detail 取） */
export function formatNetworkList(
  entries: NetworkEntry[],
  options: NetworkListOptions = {}
): string {
  let rows = entries;
  if (options.onlyFailed) {
    rows = rows.filter(
      (entry) => !!entry.failed || (entry.status !== undefined && entry.status >= 400)
    );
  }
  if (options.urlFilter) {
    const needle = options.urlFilter.toLowerCase();
    rows = rows.filter((entry) => entry.url.toLowerCase().includes(needle));
  }
  const limit = Math.min(Math.max(1, options.limit ?? 50), MAX_NETWORK_ENTRIES);
  const total = rows.length;
  const shown = rows.slice(-limit);
  if (!total) {
    return options.urlFilter || options.onlyFailed
      ? '没有匹配的请求；去掉过滤条件可用 network_list 查看全部记录'
      : '还没有记录到网络请求（调试开关需在请求发生前打开）';
  }
  const lines = shown.map((entry) => {
    const status = entry.failed ? '---' : (entry.status ?? '···');
    const type = entry.resourceType ? `[${entry.resourceType}]` : '';
    const duration =
      entry.finished && entry.durationMs !== undefined
        ? `${Math.round(entry.durationMs)}ms`
        : '进行中';
    const size = formatBytes(entry.encodedDataLength);
    const bodyMark = entry.body ? 'body:yes' : entry.finished ? 'body:no' : '';
    const failed = entry.failed ? ` 失败:${entry.failed}` : '';
    return `${entry.requestId}  ${status} ${entry.method} ${formatUrlForLine(entry.url)} ${type} ${duration} ${size} ${bodyMark}${failed}`.trimEnd();
  });
  const head = `共 ${total} 条（旧→新${total > shown.length ? `，仅显示最近 ${shown.length} 条` : ''}）`;
  return [head, ...lines].join('\n');
}

/** 单条请求详情（含请求体/响应体的截断内容） */
export function formatNetworkDetail(entry: NetworkEntry): string {
  const parts: string[] = [];
  parts.push(`请求: ${entry.method} ${entry.url}`);
  if (entry.resourceType) parts.push(`类型: ${entry.resourceType}`);
  if (entry.failed) {
    parts.push('状态: 请求失败');
    parts.push(`失败原因: ${entry.failed}`);
  } else {
    const status =
      entry.status !== undefined
        ? `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}`
        : '未完成';
    const meta = [
      entry.mimeType,
      entry.durationMs !== undefined ? `${Math.round(entry.durationMs)}ms` : null,
      formatBytes(entry.encodedDataLength),
      entry.fromCache ? '来自缓存' : null
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(`状态: ${status}${meta ? ` (${meta})` : ''}`);
  }
  if (entry.redirectedFrom) parts.push(`重定向自: ${entry.redirectedFrom}`);
  const requestHeaders = entry.requestHeaders
    ? Object.entries(entry.requestHeaders).map(([key, value]) => `  ${key}: ${value}`)
    : [];
  if (requestHeaders.length) parts.push(`请求头:\n${requestHeaders.join('\n')}`);
  if (entry.postData) {
    parts.push(`请求体:\n${entry.postData}${entry.postDataTruncated ? '\n…（请求体已截断）' : ''}`);
  }
  const responseHeaders = entry.responseHeaders
    ? Object.entries(entry.responseHeaders).map(([key, value]) => `  ${key}: ${value}`)
    : [];
  if (responseHeaders.length) parts.push(`响应头:\n${responseHeaders.join('\n')}`);
  if (entry.body) {
    const prefix = entry.bodyBase64 ? '响应体(base64):' : '响应体:';
    parts.push(`${prefix}\n${entry.body}${entry.bodyTruncated ? '\n…（响应体已截断）' : ''}`);
  } else if (entry.bodyError) {
    parts.push(`响应体: 不可用（${entry.bodyError}）`);
  } else if (entry.bodyEvicted) {
    parts.push('响应体: 已被淘汰（缓冲超限，请重新发起请求）');
  } else if (!entry.finished) {
    parts.push('响应体: 请求尚未结束');
  } else {
    parts.push('响应体: 无');
  }
  return parts.join('\n');
}

/** console 列表（含未捕获异常） */
export function formatConsoleList(entries: ConsoleEntry[], limit = 50): string {
  const capped = Math.min(Math.max(1, limit), MAX_CONSOLE_ENTRIES);
  const shown = entries.slice(-capped);
  if (!shown.length) return '还没有控制台输出（调试开关需在页面产生日志前打开）';
  const head = `共 ${entries.length} 条（旧→新${entries.length > shown.length ? `，仅显示最近 ${shown.length} 条` : ''}）`;
  const lines = shown.map((entry) => {
    const location = entry.url
      ? ` (${entry.url}${entry.line !== undefined ? `:${entry.line}` : ''})`
      : '';
    return `[${entry.level}] ${entry.text}${entry.truncated ? ' …（已截断）' : ''}${location}`;
  });
  return [head, ...lines].join('\n');
}

/** CDP 采集器：每个标签一份状态，未启用时完全不 attach */
export class TrafficRecorder {
  private tabs = new Map<string, TabTraffic>();

  isAttached(tabId: string): boolean {
    return this.tabs.get(tabId)?.attached === true;
  }

  getState(tabId: string): TrafficState | null {
    const state = this.tabs.get(tabId);
    if (!state) return null;
    return {
      attached: state.attached,
      ...(state.attachError ? { attachError: state.attachError } : {}),
      entries: state.entries,
      consoleEntries: state.consoleEntries
    };
  }

  listEntries(tabId: string): NetworkEntry[] {
    return this.tabs.get(tabId)?.entries ?? [];
  }

  listConsole(tabId: string): ConsoleEntry[] {
    return this.tabs.get(tabId)?.consoleEntries ?? [];
  }

  find(tabId: string, requestId: string): NetworkEntry | undefined {
    return this.tabs.get(tabId)?.index.get(requestId);
  }

  /** 附着 CDP；失败（例如该标签已打开 DevTools）不抛错，记录原因后返回 */
  async attach(tabId: string, host: DebuggerHost): Promise<AttachResult> {
    const existing = this.tabs.get(tabId);
    if (existing) {
      if (existing.attached) return { ok: true, attached: true };
      this.dispose(tabId);
    }
    const state: TabTraffic = {
      host,
      attached: false,
      entries: [],
      index: new Map(),
      consoleEntries: [],
      bodyChars: 0,
      consoleSeq: 0
    };
    this.tabs.set(tabId, state);
    const dbg = host.debugger;
    try {
      if (!dbg || typeof dbg.attach !== 'function') throw new Error('当前标签不支持调试协议');
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.attached = false;
      state.attachError = message;
      return { ok: false, attached: false, error: message };
    }
    const listener = (_event: unknown, method: string, params: any) => {
      try {
        this.handleMessage(tabId, method, params);
      } catch {
        // 单个事件解析失败不影响后续采集
      }
    };
    const detachListener = (_event: unknown, reason: string) => {
      state.attached = false;
      state.attachError = `调试通道已断开（${reason}）`;
    };
    dbg.on('message', listener);
    dbg.on('detach', detachListener);
    state.listener = listener;
    state.detachListener = detachListener;
    // 不等待开启命令的返回：实测部分 Electron 环境下域已生效、事件也在推送，但 sendCommand 的
    // promise 一直不 resolve（等它会把 attached 永远卡在 false，抓包全面失效）。这里直接标记可用，
    // 只有命令真的 reject 时才回退成不可用并记下原因。
    state.attached = true;
    state.attachError = undefined;
    for (const [method, params] of ENABLE_COMMANDS) {
      const fail = (error: unknown) => {
        state.attached = false;
        state.attachError = `${method} 失败：${error instanceof Error ? error.message : String(error)}`;
      };
      try {
        void Promise.resolve(dbg.sendCommand(method, params)).catch(fail);
      } catch (error) {
        fail(error);
      }
    }
    return { ok: true, attached: true };
  }

  detach(tabId: string): void {
    this.dispose(tabId);
  }

  detachAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.dispose(tabId);
  }

  clear(tabId?: string, what: 'network' | 'console' | 'all' = 'all'): void {
    const targets = tabId ? [this.tabs.get(tabId)].filter(Boolean) : [...this.tabs.values()];
    for (const state of targets) {
      if (!state) continue;
      if (what === 'network' || what === 'all') {
        state.entries = [];
        state.index.clear();
        state.bodyChars = 0;
      }
      if (what === 'console' || what === 'all') state.consoleEntries = [];
    }
  }

  /** 中止页面里正在执行的脚本（evaluate 超时时调用，尽力而为） */
  async terminateExecution(tabId: string): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state?.attached) return;
    try {
      await withTimeout(
        state.host.debugger.sendCommand('Runtime.terminateExecution'),
        DEBUGGER_COMMAND_TIMEOUT_MS,
        'Runtime.terminateExecution'
      );
    } catch {
      // 忽略：目标可能已结束或通道已断开
    }
  }

  private dispose(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    const dbg = state.host.debugger;
    const drop = (event: string, listener: (...args: any[]) => void) => {
      try {
        if (typeof dbg.removeListener === 'function') dbg.removeListener(event, listener);
        else if (typeof dbg.off === 'function') dbg.off(event, listener);
      } catch {
        // 忽略监听器移除失败
      }
    };
    if (state.listener) drop('message', state.listener);
    if (state.detachListener) drop('detach', state.detachListener);
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // 忽略
    }
    this.tabs.delete(tabId);
  }

  private handleMessage(tabId: string, method: string, params: any): void {
    const state = this.tabs.get(tabId);
    if (!state || !params) return;
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(state, params);
        break;
      case 'Network.responseReceived':
        this.onResponseReceived(state, params);
        break;
      case 'Network.loadingFinished':
        this.onLoadingFinished(state, params);
        break;
      case 'Network.loadingFailed':
        this.onLoadingFailed(state, params);
        break;
      case 'Runtime.consoleAPICalled':
        this.onConsole(state, params);
        break;
      case 'Runtime.exceptionThrown':
        this.onException(state, params);
        break;
      default:
        break;
    }
  }

  private onRequestWillBeSent(state: TabTraffic, params: any): void {
    const requestId = String(params.requestId ?? '');
    if (!requestId) return;
    const request = params.request ?? {};
    const headers = toHeaderRecord(request.headers);
    const postData =
      typeof request.postData === 'string'
        ? truncate(request.postData, MAX_POST_DATA_CHARS)
        : undefined;
    const existing = state.index.get(requestId);
    // 重定向会复用同一个 requestId 再次触发 requestWillBeSent，此时保留原始起点
    if (existing) {
      existing.method = String(request.method ?? existing.method);
      existing.url = String(request.url ?? existing.url);
      existing.requestHeaders = headers ?? existing.requestHeaders;
      if (postData) {
        existing.postData = postData.text;
        existing.postDataTruncated = postData.truncated;
      }
      existing.status = undefined;
      existing.statusText = undefined;
      existing.responseHeaders = undefined;
      existing.mimeType = undefined;
      existing.durationMs = undefined;
      existing.encodedDataLength = undefined;
      existing.countedBodyChars = undefined;
      existing.body = undefined;
      existing.bodyBase64 = undefined;
      existing.bodyTruncated = undefined;
      existing.bodyEvicted = undefined;
      existing.bodyError = undefined;
      existing.failed = undefined;
      existing.finished = false;
      if (params.redirectResponse?.url)
        existing.redirectedFrom = String(params.redirectResponse.url);
      return;
    }
    const entry: NetworkEntry = {
      requestId,
      method: String(request.method ?? 'GET'),
      url: String(request.url ?? ''),
      resourceType: typeof params.type === 'string' ? params.type : undefined,
      requestHeaders: headers,
      postData: postData?.text,
      postDataTruncated: postData?.truncated,
      startedAt: Date.now(),
      startedAtMonotonic: typeof params.timestamp === 'number' ? params.timestamp : undefined,
      finished: false
    };
    state.entries.push(entry);
    state.index.set(requestId, entry);
    this.evictEntries(state);
  }

  private onResponseReceived(state: TabTraffic, params: any): void {
    const entry = state.index.get(String(params.requestId ?? ''));
    if (!entry) return;
    const response = params.response ?? {};
    if (typeof response.status === 'number') entry.status = response.status;
    if (typeof response.statusText === 'string') entry.statusText = response.statusText;
    if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType;
    entry.responseHeaders = toHeaderRecord(response.headers);
    entry.fromCache = response.fromDiskCache === true || response.fromServiceWorker === true;
    if (typeof params.type === 'string') entry.resourceType = params.type;
  }

  private onLoadingFinished(state: TabTraffic, params: any): void {
    const entry = state.index.get(String(params.requestId ?? ''));
    if (!entry) return;
    entry.finished = true;
    if (typeof params.encodedDataLength === 'number')
      entry.encodedDataLength = params.encodedDataLength;
    if (typeof params.timestamp === 'number' && typeof entry.startedAtMonotonic === 'number') {
      entry.durationMs = Math.max(0, (params.timestamp - entry.startedAtMonotonic) * 1000);
    }
    void this.captureBody(state, entry);
  }

  private onLoadingFailed(state: TabTraffic, params: any): void {
    const entry = state.index.get(String(params.requestId ?? ''));
    if (!entry) return;
    entry.finished = true;
    const errorText = typeof params.errorText === 'string' ? params.errorText : '未知错误';
    const blocked =
      typeof params.blockedReason === 'string' ? `，被拦截(${params.blockedReason})` : '';
    const canceled = params.canceled === true ? '，已取消' : '';
    entry.failed = `${errorText}${blocked}${canceled}`;
  }

  private async captureBody(state: TabTraffic, entry: NetworkEntry): Promise<void> {
    if (!state.attached) return;
    try {
      const result = (await withTimeout(
        state.host.debugger.sendCommand('Network.getResponseBody', { requestId: entry.requestId }),
        DEBUGGER_COMMAND_TIMEOUT_MS,
        'Network.getResponseBody'
      )) as { body?: string; base64Encoded?: boolean } | undefined;
      if (!result || typeof result.body !== 'string') return;
      const current = state.index.get(entry.requestId);
      if (!current) return;
      const { text, truncated } = truncate(result.body, MAX_BODY_CHARS);
      current.body = text;
      current.bodyBase64 = result.base64Encoded === true;
      current.bodyTruncated = truncated;
      current.countedBodyChars = text.length;
      state.bodyChars += text.length;
      this.evictBodies(state);
    } catch (error) {
      const current = state.index.get(entry.requestId);
      if (!current) return;
      current.bodyError = error instanceof Error ? error.message : String(error);
    }
  }

  private onConsole(state: TabTraffic, params: any): void {
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args.map((arg: unknown) => formatRemoteObject(arg)).join(' ');
    const { text: capped, truncated } = truncate(text, MAX_CONSOLE_TEXT_CHARS);
    const stack = Array.isArray(params.stackTrace?.callFrames)
      ? params.stackTrace.callFrames[0]
      : undefined;
    state.consoleEntries.push({
      id: ++state.consoleSeq,
      level: typeof params.type === 'string' ? params.type : 'log',
      text: capped,
      timestamp: Date.now(),
      ...(stack?.url ? { url: String(stack.url) } : {}),
      ...(typeof stack?.lineNumber === 'number' ? { line: stack.lineNumber + 1 } : {}),
      ...(truncated ? { truncated: true } : {})
    });
    this.evictConsole(state);
  }

  private onException(state: TabTraffic, params: any): void {
    const details = params.exceptionDetails ?? {};
    const description =
      details.exception?.description ?? details.exception?.value ?? details.text ?? '未捕获异常';
    const { text, truncated } = truncate(String(description), MAX_CONSOLE_TEXT_CHARS);
    state.consoleEntries.push({
      id: ++state.consoleSeq,
      level: 'exception',
      text,
      timestamp: Date.now(),
      ...(details.url ? { url: String(details.url) } : {}),
      ...(typeof details.lineNumber === 'number' ? { line: details.lineNumber + 1 } : {}),
      ...(truncated ? { truncated: true } : {})
    });
    this.evictConsole(state);
  }

  private evictEntries(state: TabTraffic): void {
    while (state.entries.length > MAX_NETWORK_ENTRIES) {
      const dropped = state.entries.shift();
      if (!dropped) break;
      state.index.delete(dropped.requestId);
      if (dropped.countedBodyChars) state.bodyChars -= dropped.countedBodyChars;
    }
  }

  private evictBodies(state: TabTraffic): void {
    for (const entry of state.entries) {
      if (state.bodyChars <= MAX_TOTAL_BODY_CHARS) break;
      if (!entry.countedBodyChars) continue;
      state.bodyChars -= entry.countedBodyChars;
      entry.countedBodyChars = undefined;
      entry.body = undefined;
      entry.bodyBase64 = undefined;
      entry.bodyTruncated = undefined;
      entry.bodyEvicted = true;
    }
  }

  private evictConsole(state: TabTraffic): void {
    if (state.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
      state.consoleEntries.splice(0, state.consoleEntries.length - MAX_CONSOLE_ENTRIES);
    }
  }
}
