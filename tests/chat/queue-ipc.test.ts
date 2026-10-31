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
 * 这里直接调用注册出来的 IPC handler，断言清理范围只覆盖目标那一条，
 * 以及「带图入队的消息在队列编辑后图片不丢」。
 */
interface FakeSession {
  steer: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  clearQueue: ReturnType<typeof vi.fn>;
  model?: { input: string[] };
}

interface FakeSlot {
  requireSession: () => FakeSession;
  session: FakeSession;
  cwd: string;
  access: Record<string, never>;
  identity: () => Record<string, never>;
  queuedMessages: Array<{ kind: 'steering' | 'followUp'; text: string; images?: any[] }>;
}

let session: FakeSession;
let slot: FakeSlot;

function setup(steering: string[], followUp: string[]) {
  session = {
    steer: vi.fn(async () => 'queued' as const),
    followUp: vi.fn(async () => 'queued' as const),
    clearQueue: vi.fn(() => ({ steering: [...steering], followUp: [...followUp] })),
    // 默认按视觉模型处理（真实会话的 model.input 来自 pi-ai 模型定义）
    model: { input: ['text', 'image'] }
  };
  // 与真实 SessionSlot 一致：同一个槽对象跨多次 IPC 调用复用（排队镜像存在槽上）
  slot = {
    requireSession: () => session,
    session,
    cwd: '/project',
    access: {},
    identity: () => ({}),
    queuedMessages: []
  };
  mocks.handle.mockClear();
  registerMiscIpc({
    sessionFor: () => slot
  } as unknown as MiscContext);
  return (channel: string) => mocks.handle.mock.calls.find(([c]) => c === channel)![1];
}

const steerArgs = () => session.steer.mock.calls.map(([t]) => t);
const followArgs = () => session.followUp.mock.calls.map(([t]) => t);
const img = (mark: string) => ({ type: 'image' as const, data: mark, mimeType: 'image/png' });

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

describe('排队消息 IPC：流式期间带图发送', () => {
  it('pi:steer / pi:followUp 把图片透传给 SDK 并记进镜像', async () => {
    const handler = setup([], []);

    await handler('pi:steer')({} as never, '看这张图', { images: [img('A')] });
    await handler('pi:followUp')({} as never, '再看这张', { images: [img('B')] });

    expect(session.steer.mock.calls[0]).toEqual(['看这张图', [img('A')]]);
    expect(session.followUp.mock.calls[0]).toEqual(['再看这张', [img('B')]]);
    expect(slot.queuedMessages).toEqual([
      { kind: 'steering', text: '看这张图', images: [img('A')] },
      { kind: 'followUp', text: '再看这张', images: [img('B')] }
    ]);
  });

  it('非视觉模型：图片落盘成路径提示、不再随消息发送', async () => {
    const handler = setup([], []);
    session.model = { input: ['text'] };

    await handler('pi:steer')({} as never, '看这张图', { images: [img('A')] });

    const [text, images] = session.steer.mock.calls[0];
    expect(images).toBeUndefined();
    expect(text).toContain('read_img');
    expect(text).toMatch(/piui-img-\d+-\d+\.png/);
    // 镜像记的是降级后的文本，避免下次重新入队又把路径提示再拼一遍
    expect(slot.queuedMessages[0].images).toBeUndefined();
    expect(slot.queuedMessages[0].text).toBe(text);
  });

  it('撤回带图的消息：图片原样返回，其余条目重新入队时图片不丢', async () => {
    const handler = setup([], []);
    await handler('pi:steer')({} as never, 's0', { images: [img('A')] });
    await handler('pi:steer')({} as never, 's1');
    // SDK 队列快照只回文本（模拟真实 clearQueue 的丢了图片的形态）
    session.clearQueue.mockImplementation(() => ({ steering: ['s0', 's1'], followUp: [] }));
    session.steer.mockClear();

    const r = await handler('pi:revokeQueuedMessage')({} as never, 'steering', 0);

    expect(r).toEqual({ ok: true, revoked: 's0', images: [img('A')] });
    expect(session.steer.mock.calls).toEqual([['s1', undefined]]);
  });

  it('重排 / 切换投递方式后图片仍跟着那条消息', async () => {
    const handler = setup([], []);
    await handler('pi:steer')({} as never, 's0');
    await handler('pi:steer')({} as never, 's1', { images: [img('A')] });
    await handler('pi:steer')({} as never, 's2');
    session.clearQueue.mockImplementation(() => ({ steering: ['s0', 's1', 's2'], followUp: [] }));

    session.steer.mockClear();
    await handler('pi:reorderQueuedMessage')({} as never, 'steering', 1, 3);
    expect(session.steer.mock.calls).toEqual([
      ['s0', undefined],
      ['s2', undefined],
      ['s1', [img('A')]]
    ]);

    session.clearQueue.mockImplementation(() => ({ steering: ['s0', 's2', 's1'], followUp: [] }));
    session.steer.mockClear();
    session.followUp.mockClear();
    await handler('pi:switchQueuedMessage')({} as never, 'steering', 2);
    expect(session.steer.mock.calls).toEqual([
      ['s0', undefined],
      ['s2', undefined]
    ]);
    expect(session.followUp.mock.calls).toEqual([['s1', [img('A')]]]);
  });

  it('引导消息已被 SDK 投递时，镜像对账后不会把它重新入队', async () => {
    const handler = setup([], []);
    await handler('pi:steer')({} as never, 's0');
    await handler('pi:steer')({} as never, 's1', { images: [img('A')] });
    // SDK 已经投递了 s0（队列只剩 s1）
    session.clearQueue.mockImplementation(() => ({ steering: ['s1'], followUp: [] }));
    session.steer.mockClear();

    await handler('pi:removeQueuedMessage')({} as never, 'steering', 0);

    // 只重新入队 s1（带图），s0 不会复活
    expect(session.steer.mock.calls).toEqual([]);
    expect(session.followUp.mock.calls).toEqual([]);
  });
});
