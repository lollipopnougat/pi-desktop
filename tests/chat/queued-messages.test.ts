import { describe, expect, it } from 'vitest';

import { removeQueuedAt, moveQueuedAt, type QueueLists } from '../../electron/queued-messages';

/**
 * 排队消息单条删除（removeQueuedAt）：
 * SDK 没有「删除第 n 条」API，单条增删都是 clearQueue 取快照 → 裁剪 → 其余重新入队，
 * 这里覆盖索引裁剪本身：只删一条、保持其余顺序、越界不动、不修改入参。
 */
const lists = (): QueueLists => ({
  steering: ['s0', 's1', 's2'],
  followUp: ['f0', 'f1']
});

describe('removeQueuedAt（排队消息单条删除）', () => {
  it('只删除指定的一条，其余保持原顺序', () => {
    const r = removeQueuedAt(lists(), 'steering', 1);

    expect(r.removed).toBe('s1');
    expect(r.steering).toEqual(['s0', 's2']);
    expect(r.followUp).toEqual(['f0', 'f1']);
  });

  it('删中间一条时后面的消息顺序不变（不会把后面的清空或错位）', () => {
    const r = removeQueuedAt(lists(), 'followUp', 0);

    expect(r.removed).toBe('f0');
    expect(r.followUp).toEqual(['f1']);
    expect(r.steering).toEqual(['s0', 's1', 's2']);
  });

  it('删除最后一条', () => {
    const r = removeQueuedAt(lists(), 'followUp', 1);

    expect(r.removed).toBe('f1');
    expect(r.followUp).toEqual(['f0']);
  });

  it('索引越界/负数/非整数时不改动任何队列', () => {
    const src = lists();

    for (const bad of [3, -1, 99, 1.5, NaN]) {
      const r = removeQueuedAt(src, 'steering', bad);
      expect(r.removed).toBeNull();
      expect(r.steering).toEqual(['s0', 's1', 's2']);
      expect(r.followUp).toEqual(['f0', 'f1']);
    }
  });

  it('空队列安全', () => {
    const r = removeQueuedAt({ steering: [], followUp: [] }, 'steering', 0);

    expect(r.removed).toBeNull();
    expect(r.steering).toEqual([]);
  });

  it('不修改传入的队列数组（快照不可变）', () => {
    const src = lists();
    removeQueuedAt(src, 'steering', 0);

    expect(src.steering).toEqual(['s0', 's1', 's2']);
    expect(src.followUp).toEqual(['f0', 'f1']);
  });
});

/**
 * 排队消息拖拽重排（moveQueuedAt）：
 * to 是「插入到原数组第 to 个条目之前」的插入点，前端拿「左侧 / 右侧 / 队尾」直接当 to 用。
 */
describe('moveQueuedAt（排队消息拖拽重排）', () => {
  it('往后拖：插到目标条目左侧', () => {
    const r = moveQueuedAt(lists(), 'steering', 0, 2);

    expect(r.moved).toBe('s0');
    expect(r.steering).toEqual(['s1', 's0', 's2']);
    expect(r.followUp).toEqual(['f0', 'f1']);
  });

  it('往前拖：插到目标条目左侧', () => {
    const r = moveQueuedAt(lists(), 'steering', 2, 0);

    expect(r.moved).toBe('s2');
    expect(r.steering).toEqual(['s2', 's0', 's1']);
  });

  it('拖到队尾（to === length）', () => {
    const r = moveQueuedAt(lists(), 'steering', 0, 3);

    expect(r.moved).toBe('s0');
    expect(r.steering).toEqual(['s1', 's2', 's0']);
  });

  it('落到自身两侧视为原位（顺序不变，但仍算有效操作）', () => {
    for (const to of [0, 1]) {
      const r = moveQueuedAt(lists(), 'steering', 0, to);
      expect(r.moved).toBe('s0');
      expect(r.steering).toEqual(['s0', 's1', 's2']);
    }
  });

  it('只影响目标队列，另一个队列原样返回（两区不混排）', () => {
    const r = moveQueuedAt(lists(), 'followUp', 1, 0);

    expect(r.moved).toBe('f1');
    expect(r.followUp).toEqual(['f1', 'f0']);
    expect(r.steering).toEqual(['s0', 's1', 's2']);
  });

  it('单条队列自己拖到自己身上是安全的空操作', () => {
    const r = moveQueuedAt({ steering: ['only'], followUp: [] }, 'steering', 0, 1);

    expect(r.moved).toBe('only');
    expect(r.steering).toEqual(['only']);
  });

  it('索引非法时不改动任何队列', () => {
    const src = lists();

    for (const [from, to] of [
      [-1, 0],
      [3, 0],
      [0, 4],
      [0, -1],
      [1.5, 0],
      [0, 2.5],
      [NaN, 0]
    ] as const) {
      const r = moveQueuedAt(src, 'steering', from, to);
      expect(r.moved).toBeNull();
      expect(r.steering).toEqual(['s0', 's1', 's2']);
    }
  });

  it('空队列拖拽安全，且不修改传入数组', () => {
    const src = lists();
    const empty = moveQueuedAt({ steering: [], followUp: [] }, 'followUp', 0, 0);

    expect(empty.moved).toBeNull();
    expect(empty.followUp).toEqual([]);

    moveQueuedAt(src, 'steering', 0, 2);
    expect(src.steering).toEqual(['s0', 's1', 's2']);
    expect(src.followUp).toEqual(['f0', 'f1']);
  });
});
