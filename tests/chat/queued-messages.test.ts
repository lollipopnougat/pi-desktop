import { describe, expect, it } from 'vitest';

import {
  moveQueuedMessage,
  reconcileQueuedMessages,
  removeQueuedMessageAt,
  switchQueuedMessageKind,
  type QueuedImage,
  type QueuedMessage
} from '../../electron/queued-messages';

/**
 * 排队消息的镜像编辑（单条删除 / 拖拽重排 / 切换投递方式 / 与 SDK 快照对账）。
 *
 * 背景：SDK 没有「删除第 n 条」API，单条增删都是 clearQueue 取快照 → 裁剪 → 其余重新入队；
 * 而 clearQueue 只回文本（图片取不回来），所以图片由镜像携带，这里重点守「编辑后图片不丢」。
 */
const img = (mark: string): QueuedImage => ({ type: 'image', data: mark, mimeType: 'image/png' });

const list = (): QueuedMessage[] => [
  { kind: 'steering', text: 's0' },
  { kind: 'steering', text: 's1', images: [img('S1')] },
  { kind: 'steering', text: 's2' },
  { kind: 'followUp', text: 'f0' },
  { kind: 'followUp', text: 'f1', images: [img('F1')] }
];

const textsOf = (messages: QueuedMessage[], kind: 'steering' | 'followUp') =>
  messages.filter((m) => m.kind === kind).map((m) => m.text);

describe('removeQueuedMessageAt（排队消息单条删除）', () => {
  it('只删除指定的一条，其余保持原顺序且带上图片', () => {
    const r = removeQueuedMessageAt(list(), 'steering', 0);

    expect(r.removed?.text).toBe('s0');
    expect(textsOf(r.list, 'steering')).toEqual(['s1', 's2']);
    expect(textsOf(r.list, 'followUp')).toEqual(['f0', 'f1']);
    expect(r.list.find((m) => m.text === 's1')?.images).toEqual([img('S1')]);
  });

  it('删中间一条时后面的消息顺序不变（不会把后面的清空或错位）', () => {
    const r = removeQueuedMessageAt(list(), 'followUp', 0);

    expect(r.removed?.text).toBe('f0');
    expect(textsOf(r.list, 'followUp')).toEqual(['f1']);
    expect(textsOf(r.list, 'steering')).toEqual(['s0', 's1', 's2']);
    // 被摘掉的是无图那条，剩下的图片必须还在
    expect(r.list.find((m) => m.text === 'f1')?.images).toEqual([img('F1')]);
  });

  it('被删条目自带的图片随 removed 一起返回', () => {
    const r = removeQueuedMessageAt(list(), 'steering', 1);

    expect(r.removed).toEqual({ kind: 'steering', text: 's1', images: [img('S1')] });
  });

  it('索引越界/负数/非整数时不改动队列', () => {
    const src = list();

    for (const bad of [3, -1, 99, 1.5, NaN]) {
      const r = removeQueuedMessageAt(src, 'steering', bad);
      expect(r.removed).toBeNull();
      expect(r.list).toEqual(src);
    }
  });

  it('空队列安全，且不修改入参', () => {
    const src = list();
    const snapshot = structuredClone(src);

    expect(removeQueuedMessageAt([], 'steering', 0)).toEqual({ list: [], removed: null });
    removeQueuedMessageAt(src, 'steering', 1);
    expect(src).toEqual(snapshot);
  });
});

describe('moveQueuedMessage（同分区拖拽排序）', () => {
  it('往后拖：只在该分区内重排，图片跟随条目移动', () => {
    const r = moveQueuedMessage(list(), 'steering', 1, 3);

    expect(r.moved?.text).toBe('s1');
    expect(textsOf(r.list, 'steering')).toEqual(['s0', 's2', 's1']);
    expect(textsOf(r.list, 'followUp')).toEqual(['f0', 'f1']);
    expect(r.list.find((m) => m.text === 's1')?.images).toEqual([img('S1')]);
  });

  it('往前拖', () => {
    const r = moveQueuedMessage(list(), 'followUp', 1, 0);

    expect(r.moved?.text).toBe('f1');
    expect(textsOf(r.list, 'followUp')).toEqual(['f1', 'f0']);
    expect(r.list.find((m) => m.text === 'f1')?.images).toEqual([img('F1')]);
  });

  it('落在原位（自身左侧/右侧）顺序不变', () => {
    for (const to of [1, 2]) {
      const r = moveQueuedMessage(list(), 'steering', 1, to);
      expect(r.moved?.text).toBe('s1');
      expect(textsOf(r.list, 'steering')).toEqual(['s0', 's1', 's2']);
    }
  });

  it('索引非法时原样返回（不丢消息）', () => {
    const src = list();
    for (const [from, to] of [
      [0, 9],
      [9, 0],
      [-1, 0]
    ]) {
      const r = moveQueuedMessage(src, 'steering', from, to);
      expect(r.moved).toBeNull();
      expect(r.list).toEqual(src);
    }
  });
});

describe('switchQueuedMessageKind（引导 ↔ 排队）', () => {
  it('移到另一个分区末尾，图片不丢', () => {
    const r = switchQueuedMessageKind(list(), 'steering', 1);

    expect(r.moved?.text).toBe('s1');
    expect(textsOf(r.list, 'steering')).toEqual(['s0', 's2']);
    expect(textsOf(r.list, 'followUp')).toEqual(['f0', 'f1', 's1']);
    expect(r.list.find((m) => m.text === 's1')).toEqual({
      kind: 'followUp',
      text: 's1',
      images: [img('S1')]
    });
  });

  it('索引非法时不动队列', () => {
    const src = list();
    expect(switchQueuedMessageKind(src, 'followUp', 5)).toEqual({ list: src, moved: null });
  });
});

describe('reconcileQueuedMessages（用 SDK 快照对齐镜像）', () => {
  it('文本一致时逐条复用原条目（图片保留）', () => {
    const aligned = reconcileQueuedMessages(list(), {
      steering: ['s0', 's1', 's2'],
      followUp: ['f0', 'f1']
    });

    expect(aligned).toEqual(list());
  });

  it('引导消息已被投递（快照里少了它）时丢掉对应条目，不多入队', () => {
    const aligned = reconcileQueuedMessages(list(), {
      steering: ['s1', 's2'],
      followUp: ['f0', 'f1']
    });

    expect(textsOf(aligned, 'steering')).toEqual(['s1', 's2']);
    expect(aligned.find((m) => m.text === 's1')?.images).toEqual([img('S1')]);
  });

  it('镜像为空（重启 / 别处入队）时退化成无图条目，消息不丢', () => {
    const aligned = reconcileQueuedMessages([], { steering: ['x'], followUp: [] });

    expect(aligned).toEqual([{ kind: 'steering', text: 'x' }]);
  });

  it('相同文本出现多次时按出现顺序一一对应', () => {
    const messages: QueuedMessage[] = [
      { kind: 'steering', text: 'dup' },
      { kind: 'steering', text: 'dup', images: [img('second')] }
    ];

    const aligned = reconcileQueuedMessages(messages, { steering: ['dup', 'dup'], followUp: [] });

    expect(aligned[0].images).toBeUndefined();
    expect(aligned[1].images).toEqual([img('second')]);
  });
});
