import { describe, expect, it, vi } from 'vitest';
import {
  TrafficRecorder,
  formatConsoleList,
  formatNetworkDetail,
  formatNetworkList,
  formatRemoteObject
} from '../../electron/browser/traffic';
import type { DebuggerLike } from '../../electron/browser/traffic';

/** 结构等价的假 debugger：只实现 TrafficRecorder 用到的那部分 */
class FakeDebugger implements DebuggerLike {
  attached = false;
  attachShouldFail: string | null = null;
  neverResolve = false;
  rejectCommands = false;
  commands: Array<{ method: string; params?: unknown }> = [];
  bodies = new Map<string, { body: string; base64Encoded?: boolean } | Error>();
  messageListeners: Array<(event: unknown, method: string, params: any) => void> = [];
  detachListeners: Array<(event: unknown, reason: string) => void> = [];

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    if (this.attachShouldFail) throw new Error(this.attachShouldFail);
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    if (this.rejectCommands) throw new Error(`${method} rejected by fake debugger`);
    if (this.neverResolve) return new Promise<never>(() => {});
    this.commands.push({ method, params });
    if (method === 'Network.getResponseBody') {
      const requestId = (params as { requestId: string }).requestId;
      const stored = this.bodies.get(requestId);
      if (stored instanceof Error) throw stored;
      if (!stored) throw new Error('No resource with given identifier found');
      return stored;
    }
    return {};
  }

  on(event: 'message' | 'detach', listener: (...args: any[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as never);
    else this.detachListeners.push(listener as never);
  }

  removeListener(event: string, listener: (...args: any[]) => void): void {
    if (event === 'message') {
      this.messageListeners = this.messageListeners.filter((item) => item !== listener);
    } else {
      this.detachListeners = this.detachListeners.filter((item) => item !== listener);
    }
  }

  emit(method: string, params: unknown): void {
    for (const listener of [...this.messageListeners]) listener({}, method, params);
  }

  emitDetach(reason = 'target closed'): void {
    for (const listener of [...this.detachListeners]) listener({}, reason);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function requestSent(
  requestId: string,
  url: string,
  extra: { method?: string; type?: string; postData?: string } = {}
) {
  return {
    requestId,
    type: extra.type ?? 'XHR',
    timestamp: 100,
    request: {
      url,
      method: extra.method ?? 'GET',
      headers: { Accept: 'application/json' },
      ...(extra.postData ? { postData: extra.postData } : {})
    }
  };
}

function responseReceived(requestId: string, status = 200) {
  return {
    requestId,
    timestamp: 100.2,
    response: {
      status,
      statusText: status === 200 ? 'OK' : 'Internal Server Error',
      mimeType: 'application/json',
      headers: { 'content-type': 'application/json' }
    }
  };
}

describe('TrafficRecorder attach', () => {
  it('enables the Network/Runtime domains and reports attached', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    const result = await recorder.attach('tab-1', { debugger: dbg });

    expect(result).toEqual({ ok: true, attached: true });
    expect(dbg.isAttached()).toBe(true);
    expect(dbg.commands.map((item) => item.method)).toEqual(['Network.enable', 'Runtime.enable']);
    expect(recorder.isAttached('tab-1')).toBe(true);
  });

  it('keeps the failure instead of throwing when the target is already debugged', async () => {
    const dbg = new FakeDebugger();
    dbg.attachShouldFail = 'Another debugger is already attached to the tab';
    const recorder = new TrafficRecorder();

    const result = await recorder.attach('tab-1', { debugger: dbg });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Another debugger');
    const state = recorder.getState('tab-1');
    expect(state?.attached).toBe(false);
    expect(state?.attachError).toContain('Another debugger');
    // 未 attach 时不应把事件交给采集器
    dbg.emit('Network.requestWillBeSent', requestSent('r1', 'https://api.example.com/a'));
    expect(recorder.listEntries('tab-1')).toHaveLength(0);
  });

  it('stays usable even when the enable commands never resolve', async () => {
    const dbg = new FakeDebugger();
    dbg.neverResolve = true;
    const recorder = new TrafficRecorder();

    const result = await recorder.attach('tab-1', { debugger: dbg });

    expect(result).toEqual({ ok: true, attached: true });
    // 域已开启（真实环境下事件照常推送），只是 sendCommand 的 promise 不返回
    dbg.emit('Network.requestWillBeSent', requestSent('r1', 'https://api.example.com/a'));
    expect(recorder.listEntries('tab-1')).toHaveLength(1);
  });

  it('falls back to unusable when an enable command rejects', async () => {
    const dbg = new FakeDebugger();
    dbg.rejectCommands = true;
    const recorder = new TrafficRecorder();

    const result = await recorder.attach('tab-1', { debugger: dbg });
    await flush();

    expect(result.ok).toBe(true);
    const state = recorder.getState('tab-1');
    expect(state?.attached).toBe(false);
    expect(state?.attachError).toContain('enable 失败');
  });

  it('detaches, drops listeners and forgets the tab', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    expect(dbg.messageListeners).toHaveLength(1);

    recorder.detach('tab-1');

    expect(dbg.isAttached()).toBe(false);
    expect(dbg.messageListeners).toHaveLength(0);
    expect(dbg.detachListeners).toHaveLength(0);
    expect(recorder.getState('tab-1')).toBeNull();
  });

  it('marks the channel broken when the debugger reports detach', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });

    dbg.emitDetach('DevTools opened');

    const state = recorder.getState('tab-1');
    expect(state?.attached).toBe(false);
    expect(state?.attachError).toContain('DevTools opened');
  });
});

describe('TrafficRecorder capture', () => {
  it('records request/response lifecycle and formats list + detail', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    dbg.bodies.set('r1', { body: '{"ok":true}' });

    dbg.emit(
      'Network.requestWillBeSent',
      requestSent('r1', 'https://api.example.com/list.json', { postData: 'a=1' })
    );
    dbg.emit('Network.responseReceived', responseReceived('r1', 201));
    dbg.emit('Network.loadingFinished', {
      requestId: 'r1',
      timestamp: 100.25,
      encodedDataLength: 2048
    });
    await flush();

    const list = formatNetworkList(recorder.listEntries('tab-1'));
    expect(list).toContain('r1');
    expect(list).toContain('201');
    expect(list).toContain('https://api.example.com/list.json');
    expect(list).toContain('body:yes');

    const detail = formatNetworkDetail(recorder.find('tab-1', 'r1')!);
    expect(detail).toContain('请求: GET https://api.example.com/list.json');
    expect(detail).toContain('状态: 201');
    expect(detail).toContain('请求体:\na=1');
    expect(detail).toContain('响应体:\n{"ok":true}');
  });

  it('records failures, redirects and body errors', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    dbg.bodies.set('bad', new Error('No resource with given identifier found'));

    dbg.emit('Network.requestWillBeSent', requestSent('r2', 'https://api.example.com/redirect'));
    dbg.emit('Network.requestWillBeSent', {
      ...requestSent('r2', 'https://api.example.com/final'),
      redirectResponse: { url: 'https://api.example.com/redirect' }
    });
    dbg.emit('Network.responseReceived', responseReceived('r2'));
    dbg.emit('Network.loadingFinished', {
      requestId: 'r2',
      timestamp: 100.1,
      encodedDataLength: 10
    });
    await flush();

    dbg.emit('Network.requestWillBeSent', requestSent('r3', 'https://api.example.com/fail'));
    dbg.emit('Network.loadingFailed', {
      requestId: 'r3',
      timestamp: 100.3,
      errorText: 'net::ERR_FAILED',
      blockedReason: 'inspector'
    });

    const final = recorder.find('tab-1', 'r2')!;
    expect(recorder.listEntries('tab-1')).toHaveLength(2);
    expect(final.url).toBe('https://api.example.com/final');
    expect(final.redirectedFrom).toBe('https://api.example.com/redirect');
    expect(final.bodyError).toContain('No resource');
    expect(formatNetworkList(recorder.listEntries('tab-1'), { onlyFailed: true })).toContain('r3');
    const failedDetail = formatNetworkDetail(recorder.find('tab-1', 'r3')!);
    expect(failedDetail).toContain('net::ERR_FAILED');
    expect(failedDetail).toContain('被拦截(inspector)');
  });

  it('truncates oversized bodies and post data', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    dbg.bodies.set('big', { body: 'x'.repeat(300_000) });

    dbg.emit('Network.requestWillBeSent', requestSent('big', 'https://api.example.com/big'));
    dbg.emit('Network.loadingFinished', {
      requestId: 'big',
      timestamp: 100.5,
      encodedDataLength: 300_000
    });
    await flush();

    const entry = recorder.find('tab-1', 'big')!;
    expect(entry.bodyTruncated).toBe(true);
    expect(entry.body?.length).toBe(200_000);
    expect(formatNetworkDetail(entry)).toContain('响应体已截断');
  });

  it('evicts oldest bodies when the total budget is exceeded', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });

    const size = 190_000;
    for (let i = 0; i < 23; i += 1) {
      const id = `b${i}`;
      dbg.bodies.set(id, { body: 'y'.repeat(size) });
      dbg.emit('Network.requestWillBeSent', requestSent(id, `https://api.example.com/${id}`));
      dbg.emit('Network.loadingFinished', {
        requestId: id,
        timestamp: 101 + i,
        encodedDataLength: size
      });
      await flush();
    }

    const entries = recorder.listEntries('tab-1');
    expect(entries).toHaveLength(23);
    expect(entries[0].bodyEvicted).toBe(true);
    expect(entries[entries.length - 1].body).toBeTruthy();
    expect(formatNetworkDetail(entries[0])).toContain('已被淘汰');
  });

  it('keeps the newest entries when the ring buffer overflows', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });

    for (let i = 0; i < 305; i += 1) {
      dbg.emit('Network.requestWillBeSent', requestSent(`n${i}`, `https://api.example.com/${i}`));
    }

    const entries = recorder.listEntries('tab-1');
    expect(entries).toHaveLength(300);
    expect(entries[0].requestId).toBe('n5');
    expect(recorder.find('tab-1', 'n0')).toBeUndefined();
  });

  it('captures console output and uncaught exceptions', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });

    dbg.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [
        { type: 'string', value: 'hello' },
        { type: 'number', value: 42 }
      ],
      stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 9 }] }
    });
    dbg.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: boom\n    at <anonymous>:1:1' },
        url: 'https://example.com/app.js',
        lineNumber: 20
      }
    });

    const text = formatConsoleList(recorder.listConsole('tab-1'));
    expect(text).toContain('[log] hello 42 (https://example.com/app.js:10)');
    expect(text).toContain('[exception] TypeError: boom');
    expect(text).toContain('https://example.com/app.js:21');
  });

  it('clears selected buffers and everything at once', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    dbg.emit('Network.requestWillBeSent', requestSent('r1', 'https://api.example.com/a'));
    dbg.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }] });

    recorder.clear('tab-1', 'network');
    expect(recorder.listEntries('tab-1')).toHaveLength(0);
    expect(recorder.listConsole('tab-1')).toHaveLength(1);

    recorder.clear('tab-1', 'all');
    expect(recorder.listConsole('tab-1')).toHaveLength(0);
  });

  it('asks the page to stop running scripts when evaluating times out', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });

    await recorder.terminateExecution('tab-1');

    expect(dbg.commands.map((item) => item.method)).toContain('Runtime.terminateExecution');
  });

  it('swallows single-event parsing errors', async () => {
    const dbg = new FakeDebugger();
    const recorder = new TrafficRecorder();
    await recorder.attach('tab-1', { debugger: dbg });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      dbg.emit('Network.responseReceived', { requestId: undefined, response: null })
    ).not.toThrow();

    spy.mockRestore();
  });
});

describe('traffic formatting helpers', () => {
  it('describes remote objects from the CDP wire format', () => {
    expect(formatRemoteObject({ type: 'string', value: 'a' })).toBe('a');
    expect(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN');
    expect(formatRemoteObject({ type: 'undefined' })).toBe('undefined');
    expect(formatRemoteObject({ type: 'object', description: 'Object' })).toBe('Object');
    expect(formatRemoteObject(null)).toBe('null');
  });

  it('prints friendly empty states', () => {
    expect(formatNetworkList([])).toContain('还没有记录到网络请求');
    expect(formatNetworkList([], { urlFilter: 'api' })).toContain('没有匹配的请求');
    expect(formatConsoleList([])).toContain('还没有控制台输出');
  });
});
