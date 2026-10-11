/**
 * 排队消息（streaming 期间的 steer / followUp 队列）的单条增删逻辑。
 *
 * 背景：SDK 的 AgentSession 只提供 clearQueue()（整体清空）及 steer()/followUp()（重新入队），
 * 没有「删除第 n 条」的 API。因此单条操作一律是「clearQueue 取出快照 → 在快照上增删 → 其余按原顺序重新入队」。
 * 这段索引裁剪逻辑与 Electron 运行时无关，抽成纯函数放这里，便于单元测试覆盖越界/顺序/不可变性。
 * 持久化语义由调用方负责：重新入队失败时队列已由 queue_update 事件同步，UI 会反映真实状态。
 */
export interface QueueLists {
  steering: string[];
  followUp: string[];
}

export interface RemoveQueuedResult {
  /** 摘除目标后的引导消息队列（原顺序） */
  steering: string[];
  /** 摘除目标后的排队消息队列（原顺序） */
  followUp: string[];
  /** 被摘除的文本；索引非法时为 null（此时两个队列原样返回） */
  removed: string | null;
}

/**
 * 从指定队列摘掉一条消息，其余消息保持原相对顺序。
 * 索引非法（负数 / 越界 / 非整数）时不改动任何队列，返回 removed: null，
 * 由调用方决定是静默恢复还是报错 —— 与 switchQueuedMessage 的容错策略一致。
 */
export function removeQueuedAt(
  lists: QueueLists,
  kind: 'steering' | 'followUp',
  index: number
): RemoveQueuedResult {
  const steering = [...lists.steering];
  const followUp = [...lists.followUp];
  const from = kind === 'steering' ? steering : followUp;
  if (!Number.isInteger(index) || index < 0 || index >= from.length) {
    return { steering, followUp, removed: null };
  }
  const [removed] = from.splice(index, 1);
  return { steering, followUp, removed };
}

export interface MoveQueuedResult {
  /** 移动后的引导消息队列 */
  steering: string[];
  /** 移动后的排队消息队列 */
  followUp: string[];
  /** 被移动的文本；索引非法时为 null（此时两个队列原样返回） */
  moved: string | null;
}

/**
 * 同队列内拖拽重排：把 from 位置的条目移到 to 位置。
 *
 * to 采用「插入到原数组第 to 个条目之前」的语义（即两条目之间的落点），
 * 这样前端拿到的「落在第 i 个 chip 左侧 / 末尾」可以直接当 to 用：
 * - to === from 或 to === from + 1：自身左/右侧均为原位，顺序不变（仍算有效操作）
 * - to 取值区间 [0, length]（length 表示落到队尾）
 * 索引非法时不改动任何队列，返回 moved: null。
 * 另一个队列始终原样返回：引导消息与排队消息分区，不支持混排。
 */
export function moveQueuedAt(
  lists: QueueLists,
  kind: 'steering' | 'followUp',
  from: number,
  to: number
): MoveQueuedResult {
  const steering = [...lists.steering];
  const followUp = [...lists.followUp];
  const arr = kind === 'steering' ? steering : followUp;
  const valid =
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    from < arr.length &&
    to >= 0 &&
    to <= arr.length;
  if (!valid) {
    return { steering, followUp, moved: null };
  }
  if (to === from || to === from + 1) {
    return { steering, followUp, moved: arr[from] };
  }
  const [moved] = arr.splice(from, 1);
  arr.splice(from < to ? to - 1 : to, 0, moved);
  return { steering, followUp, moved };
}
