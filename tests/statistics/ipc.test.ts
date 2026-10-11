import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>,
  worker: vi.fn()
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(...args: unknown[]) {
      super();
      mocks.worker(...args);
      mocks.workers.push(this);
    }
  }
}));
import { registerStatisticsIpc } from '../../electron/ipc/statistics-ipc';

const query = { startDate: '2026-10-03', endDate: '2026-10-04' };
const sender = (id = 1) => Object.assign(new EventEmitter(), { id });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workers.length = 0;
  registerStatisticsIpc();
});
const handler = () =>
  mocks.handle.mock.calls.find(([channel]) => channel === 'pi:getUsageStatistics')![1];
const cancel = () =>
  mocks.on.mock.calls.find(([channel]) => channel === 'pi:cancelUsageStatistics')![1];

describe('统计 IPC 线程生命周期', () => {
  it('将日期和分钟边界一并传递给扫描线程', async () => {
    const contents = sender();
    const range = { ...query, startTime: '09:30', endTime: '18:45' };
    const result = handler()({ sender: contents }, range, 'minutes');
    expect(mocks.worker.mock.calls[0][1].workerData.query).toEqual(range);
    mocks.workers[0].emit('message', { ok: true, report: { query: range } });
    expect(await result).toEqual({ query: range });
  });
  it('只传固定本机会话目录，结束后清理线程和窗口监听器', async () => {
    const contents = sender();
    const result = handler()({ sender: contents }, { ...query, root: '/arbitrary' }, 'one');
    expect(mocks.worker.mock.calls[0][1].workerData.root).toMatch(
      /[\\/]\.pi-desktop[\\/]sessions$/
    );
    expect(mocks.worker.mock.calls[0][1].workerData.query).toEqual(query);
    const report = { totals: { totalTokens: 42 } };
    mocks.workers[0].emit('message', { ok: true, report });
    expect(await result).toEqual(report);
    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce();
    expect(contents.listenerCount('destroyed')).toBe(0);
  });
  it('切换日期取消旧请求，旧 requestId 的取消不会中止新请求', async () => {
    const contents = sender();
    const old = handler()({ sender: contents }, query, 'old');
    const next = handler()({ sender: contents }, query, 'next');
    expect(await old).toBeNull();
    cancel()({ sender: contents }, 'old');
    expect(mocks.workers[1].terminate).not.toHaveBeenCalled();
    cancel()({ sender: contents }, 'next');
    expect(await next).toBeNull();
    expect(mocks.workers[1].terminate).toHaveBeenCalledOnce();
  });
  it('窗口互相隔离，关闭窗口自动取消计算', async () => {
    const a = sender(1);
    const b = sender(2);
    const first = handler()({ sender: a }, query, 'same');
    const second = handler()({ sender: b }, query, 'same');
    a.emit('destroyed');
    expect(await first).toBeNull();
    expect(mocks.workers[1].terminate).not.toHaveBeenCalled();
    cancel()({ sender: b }, 'same');
    expect(await second).toBeNull();
  });
  it('工作线程失败和意外退出均结束等待并允许重试', async () => {
    const contents = sender();
    const failed = handler()({ sender: contents }, query, 'one');
    mocks.workers[0].emit('error', new Error('failed'));
    await expect(failed).rejects.toThrow('failed');
    const exited = handler()({ sender: contents }, query, 'two');
    mocks.workers[1].emit('exit', 1);
    await expect(exited).rejects.toThrow();
    expect(contents.listenerCount('destroyed')).toBe(0);
  });
  it('非法输入不启动线程', () => {
    expect(() => handler()({ sender: sender() }, { startDate: 'bad' }, 'id')).toThrow();
    expect(mocks.worker).not.toHaveBeenCalled();
  });
});
