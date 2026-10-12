import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, on: mocks.on },
  dialog: {},
  shell: {},
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn(), whenReady: vi.fn() },
  Notification: class {},
  BrowserWindow: class {}
}));

import { registerMiscIpc, type MiscContext } from '../../electron/ipc/misc-ipc';

/**
 * 排队消息 chip 的单条操作（回归：点某一条的 ✕ 曾经走 clearQueue，把整个队列都删了）。
 * 这里直接调用注册出来的 IPC handler，断言清理范围只覆盖目标那一条。
 */
interface FakeSession {
  steer: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  clearQueue: ReturnType<typeof vi.fn>;
}

let session: FakeSession;

function setup(steering: string[], followUp: string[]) {
  session = {
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => ({ steering: [...steering], followUp: [...followUp] }))
  };
  mocks.handle.mockClear();
  registerMiscIpc({
    sessionFor: () => ({
      requireSession: () => session,
      session,
      cwd: '/project',
      access: {},
      identity: () => ({})
    })
  } as unknown as MiscContext);
  return (channel: string) => mocks.handle.mock.calls.find(([c]) => c === channel)![1];
}

const steerArgs = () => session.steer.mock.calls.map(([t]) => t);
const followArgs = () => session.followUp.mock.calls.map(([t]) => t);

beforeEach(() => vi.clearAllMocks());

describe('排队消息 IPC：单条删除 vs 清空全部', () => {
  it('removeQueuedMessage 只删掉指定的一条，其余按原顺序重新入队', async () => {
    const handler = setup(['s0', 's1', 's2'], ['f0']);

    const r = await handler('pi:removeQueuedMessage')({} as never, 'steering', 1);

    expect(r).toEqual({ ok: true, removed: 's1' });
    expect(steerArgs()).toEqual(['s0', 's2']); // 其余保留，被删的 s1 不再入队
    expect(followArgs()).toEqual(['f0']);
  });

  it('删除常驻队列（followUp）中的一条不会动到另一个队列', async () => {
    const handler = setup(['s0', 's1'], ['f0', 'f1', 'f2']);

    const r = await handler('pi:removeQueuedMessage')({} as never, 'followUp', 0);

    expect(r).toEqual({ ok: true, removed: 'f0' });
    expect(followArgs()).toEqual(['f1', 'f2']);
    expect(steerArgs()).toEqual(['s0', 's1']);
  });

  it('索引越界时不丢消息（原样重新入队）', async () => {
    const handler = setup(['s0', 's1'], []);

    const r = await handler('pi:removeQueuedMessage')({} as never, 'steering', 9);

    expect(r).toEqual({ ok: false, removed: '' });
    expect(steerArgs()).toEqual(['s0', 's1']);
  });

  it('撤回（revokeQueuedMessage）仍返回被撤回文本并保留其余消息', async () => {
    const handler = setup(['s0', 's1'], []);

    const r = await handler('pi:revokeQueuedMessage')({} as never, 'steering', 0);

    expect(r).toEqual({ ok: true, revoked: 's0' });
    expect(steerArgs()).toEqual(['s1']);
  });

  it('明确的「清空全部」仍然清空两个队列（末尾按钮走这条）', async () => {
    const handler = setup(['s0', 's1'], ['f0']);

    const r = await handler('pi:clearQueue')({} as never);

    expect(r).toEqual({ steering: ['s0', 's1'], followUp: ['f0'] });
    expect(steerArgs()).toEqual([]); // 清空 = 不重新入队
    expect(followArgs()).toEqual([]);
  });
});

describe('排队消息 IPC：拖拽排序', () => {
  it('同队列内往后拖：按新顺序重新入队', async () => {
    const handler = setup(['s0', 's1', 's2'], ['f0']);

    const r = await handler('pi:reorderQueuedMessage')({} as never, 'steering', 0, 2);

    expect(r).toEqual({ ok: true, moved: 's0' });
    expect(steerArgs()).toEqual(['s1', 's0', 's2']);
    expect(followArgs()).toEqual(['f0']); // 另一个分区不受影响
  });

  it('拖到队尾（to === length）', async () => {
    const handler = setup(['s0', 's1', 's2'], []);

    const r = await handler('pi:reorderQueuedMessage')({} as never, 'steering', 0, 3);

    expect(r).toEqual({ ok: true, moved: 's0' });
    expect(steerArgs()).toEqual(['s1', 's2', 's0']);
  });

  it('排队消息队列（followUp）自己排序，不动引导队列', async () => {
    const handler = setup(['s0'], ['f0', 'f1', 'f2']);

    const r = await handler('pi:reorderQueuedMessage')({} as never, 'followUp', 2, 0);

    expect(r).toEqual({ ok: true, moved: 'f2' });
    expect(followArgs()).toEqual(['f2', 'f0', 'f1']);
    expect(steerArgs()).toEqual(['s0']);
  });

  it('落在原位（自身左侧/右侧）不丢消息，顺序不变', async () => {
    const handler = setup(['s0', 's1'], []);

    const r = await handler('pi:reorderQueuedMessage')({} as never, 'steering', 0, 1);

    expect(r).toEqual({ ok: true, moved: 's0' });
    expect(steerArgs()).toEqual(['s0', 's1']);
  });

  it('索引非法时不丢消息（原样重新入队）', async () => {
    const handler = setup(['s0', 's1'], []);

    const r = await handler('pi:reorderQueuedMessage')({} as never, 'steering', 0, 9);

    expect(r).toEqual({ ok: false, moved: '' });
    expect(steerArgs()).toEqual(['s0', 's1']);
  });
});
