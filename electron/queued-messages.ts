/**
 * 排队消息（streaming 期间的 steer / followUp 队列）的镜像与单条增删逻辑。
 *
 * 背景：SDK 的 AgentSession 只提供 clearQueue()（整体清空）及 steer()/followUp()（重新入队），
 * 没有「删除第 n 条」的 API。因此单条操作一律是「取快照 → 增删 → 其余按原顺序重新入队」。
 *
 * **为什么要有镜像**：`steer(text, images)` 的图片只存在 SDK 的 agent 队列里，
 * `clearQueue()` 与 `queue_update` 事件都只回**文本**（见 @earendil-works/pi-coding-agent
 * 的 agent-session.js `clearQueue()`）。若不管，任何一次「clearQueue 后重新入队」都会把
 * 那条消息的图片静默丢掉。所以主进程按会话槽记一份 `SessionSlot.queuedMessages`：
 * 入队时记账（文本 + 图片），队列编辑一律「对着镜像改 → clearQueue → 按镜像重新入队（带图）」，
 * 镜像与 SDK 真实队列的偏差由 reconcileQueuedMessages 在每次编辑前对齐。
 *
 * 这些函数与 Electron 运行时无关，纯函数便于单测覆盖越界/顺序/不可变性/图片保留。
 */
export type QueueKind = 'steering' | 'followUp';

/** 随消息发送的图片（结构等同 pi-ai 的 ImageContent，不引入 SDK 依赖） */
export interface QueuedImage {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 镜像中的一条排队消息：SDK 队列里那条消息 + 我们额外记的图片 */
export interface QueuedMessage {
  kind: QueueKind;
  text: string;
  images?: QueuedImage[];
}

/** SDK 能给出的队列快照（只有文本） */
export interface QueueSnapshot {
  steering: string[];
  followUp: string[];
}

export interface RemoveQueuedResult {
  /** 摘除目标后的完整队列（原顺序） */
  list: QueuedMessage[];
  /** 被摘除的条目（含图片）；索引非法时为 null */
  removed: QueuedMessage | null;
}

/** 指定分区内每条消息在完整队列里的下标（保持顺序） */
function indexesOf(list: QueuedMessage[], kind: QueueKind): number[] {
  const indexes: number[] = [];
  list.forEach((message, index) => {
    if (message.kind === kind) indexes.push(index);
  });
  return indexes;
}

/**
 * 从指定分区摘掉一条消息，其余消息保持原相对顺序。
 * 索引非法（负数 / 越界 / 非整数）时不改动任何队列，返回 removed: null，
 * 由调用方决定是静默恢复还是报错 —— 与 switchQueuedMessageKind 的容错策略一致。
 */
export function removeQueuedMessageAt(
  list: QueuedMessage[],
  kind: QueueKind,
  index: number
): RemoveQueuedResult {
  const next = [...list];
  const indexes = indexesOf(next, kind);
  if (!Number.isInteger(index) || index < 0 || index >= indexes.length) {
    return { list: next, removed: null };
  }
  const [removed] = next.splice(indexes[index], 1);
  return { list: next, removed };
}

export interface MoveQueuedResult {
  /** 移动后的完整队列 */
  list: QueuedMessage[];
  /** 被移动的条目；索引非法时为 null（此时队列原样返回） */
  moved: QueuedMessage | null;
}

/**
 * 同分区内拖拽重排：把 from 位置的条目移到 to 位置。
 *
 * to 采用「插入到原数组第 to 个条目之前」的语义（即两条目之间的落点），
 * 这样前端拿到的「落在第 i 个 chip 左侧 / 末尾」可以直接当 to 用：
 * - to === from 或 to === from + 1：自身左/右侧均为原位，顺序不变（仍算有效操作）
 * - to 取值区间 [0, 分区长度]（长度表示落到队尾）
 * 索引非法时不改动任何队列，返回 moved: null。
 * 另一个分区始终原样返回：引导消息与排队消息分区，不支持混排。
 */
export function moveQueuedMessage(
  list: QueuedMessage[],
  kind: QueueKind,
  from: number,
  to: number
): MoveQueuedResult {
  const positions = indexesOf(list, kind);
  const items = positions.map((position) => list[position]);
  const valid =
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    from < items.length &&
    to >= 0 &&
    to <= items.length;
  if (!valid) return { list: [...list], moved: null };

  const moved = items[from];
  if (to === from || to === from + 1) return { list: [...list], moved };

  const [item] = items.splice(from, 1);
  items.splice(from < to ? to - 1 : to, 0, item);
  const next = [...list];
  positions.forEach((position, i) => {
    next[position] = items[i];
  });
  return { list: next, moved };
}

export interface SwitchQueuedResult {
  list: QueuedMessage[];
  /** 被切换的那条（kind 仍是切换前的值）；索引非法时为 null */
  moved: QueuedMessage | null;
}

/** 切换投递方式（引导 ↔ 排队）：摘出来追加到另一个分区末尾（两个分区之间没有跨区排序） */
export function switchQueuedMessageKind(
  list: QueuedMessage[],
  kind: QueueKind,
  index: number
): SwitchQueuedResult {
  const { list: without, removed } = removeQueuedMessageAt(list, kind, index);
  if (!removed) return { list: without, moved: null };
  const target: QueueKind = kind === 'steering' ? 'followUp' : 'steering';
  return { list: [...without, { ...removed, kind: target }], moved: removed };
}

/**
 * 用 SDK 的快照对齐镜像。
 *
 * 何时需要：镜像可能落后于真实队列 —— 引导消息在下一轮 LLM 调用前被 SDK 投递掉、
 * 会话里别处（扩展 / goal 续跑）入队、重启后镜像为空。策略是按分区、按顺序贪心匹配文本：
 * 匹配上的条目沿用原条目（保住图片），匹配不上的文本退化成「无图条目」（宁可少图也不丢消息）。
 */
export function reconcileQueuedMessages(
  list: QueuedMessage[],
  snapshot: QueueSnapshot
): QueuedMessage[] {
  const align = (kind: QueueKind, texts: readonly string[]): QueuedMessage[] => {
    const pool = list
      .filter((message) => message.kind === kind)
      .map((message) => ({ message, used: false }));
    return texts.map((text) => {
      const hit = pool.find((entry) => !entry.used && entry.message.text === text);
      if (!hit) return { kind, text };
      hit.used = true;
      return hit.message;
    });
  };
  return [...align('steering', snapshot.steering), ...align('followUp', snapshot.followUp)];
}
