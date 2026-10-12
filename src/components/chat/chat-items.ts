/** SDK 消息内容可混合正文、思考与多个工具；分组必须按内容块而非消息数量进行。 */
export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface ChatMessage {
  role?: string;
  timestamp?: number;
  content?: string | ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
}

export type ToolActivity =
  | { key: string; type: 'tool'; toolCall: ToolCallBlock }
  | { key: string; type: 'thinking'; text: string; showPreview: boolean };

export type ChatRenderItem =
  | { type: 'user'; key: string; message: ChatMessage }
  | { type: 'toolGroup'; key: string; activities: ToolActivity[] }
  | {
      type: 'assistant';
      key: string;
      message: ChatMessage;
      isStreaming: boolean;
      showActions: boolean;
      copyText?: string;
    };

export interface ChatTurn {
  key: string;
  userTimestamp?: number;
  items: ChatRenderItem[];
}

/**
 * 构建到一半的状态：`items` 是已经定稿的渲染条目，`activities`/`seenTools` 是跨消息携带的
 * 未闭合工具活动与已见的工具 ID。流式部分靠它接续历史（否则流式条会另起一个工具组，
 * 与「一次性构建整表」的结果不一致）。
 */
export interface ChatItemBuildState {
  items: ChatRenderItem[];
  activities: ToolActivity[];
  seenTools: Set<string>;
}

/** 每条可见用户消息开始一轮，后续回复、思考和工具活动归属该轮。 */
export function groupChatItemsByTurn(items: ChatRenderItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const item of items) {
    let turn = turns[turns.length - 1];
    if (!turn || item.type === 'user') {
      turn = {
        key: item.type === 'user' ? item.key : 'preamble',
        userTimestamp: item.type === 'user' ? (item.message.timestamp ?? 0) : undefined,
        items: []
      };
      turns.push(turn);
    }
    turn.items.push(item);
  }
  return turns;
}

/**
 * 条目构建器。允许从已有状态续建（流式增量），并按消息粒度复用同一套分组/去重逻辑。
 * `seed` 的数组会被复制：调用方的状态不能被追加污染（历史前缀要跨帧复用）。
 */
function createBuilder(seed?: ChatItemBuildState) {
  const items: ChatRenderItem[] = seed ? seed.items.slice() : [];
  // seed 已有的条目属于历史，只有其后的条目才是本次新增（流式增量只渲染这部分）
  const start = items.length;
  let activities: ToolActivity[] = seed ? seed.activities.slice() : [];
  const seenTools: Set<string> = seed ? new Set(seed.seenTools) : new Set<string>();

  /** 未闭合活动定稿成条目：有工具时成一个工具组，否则逐个渲染思考块。 */
  const flushActivities = () => {
    const firstTool = activities.find((item) => item.type === 'tool');
    if (firstTool?.type === 'tool') {
      // 首个工具 ID 在流式转历史、新工具追加时保持不变，保留用户的展开选择。
      items.push({ type: 'toolGroup', key: `tools:${firstTool.toolCall.id}`, activities });
    } else {
      for (const item of activities) {
        if (item.type !== 'thinking') continue;
        items.push({
          type: 'assistant',
          key: item.key,
          message: { content: [{ type: 'thinking', thinking: item.text }] },
          isStreaming: item.showPreview,
          showActions: false
        });
      }
    }
    activities = [];
  };

  /** 正文、用户消息和错误是边界；工具结果及思考不打断连续工具活动。 */
  const addSource = (message: ChatMessage, index: number, isStreaming: boolean) => {
    if (message.role === 'toolResult') return;
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content ?? []);
    const messageKey = `${message.timestamp ?? 'live'}:${index}`;
    if (message.role === 'user') {
      if (content.some((block) => /<!-- goal-continuation: [\w:-]+ -->/.test(block.text ?? ''))) {
        return;
      }
      flushActivities();
      items.push({ type: 'user', key: `user:${messageKey}`, message });
      return;
    }
    if (message.role !== 'assistant' && !isStreaming) {
      flushActivities();
      return;
    }
    if (message.stopReason === 'error' && message.errorMessage) {
      flushActivities();
      items.push({
        type: 'assistant',
        key: `error:${messageKey}`,
        message: { ...message, content: [] },
        isStreaming: false,
        showActions: false
      });
    }
    const lastTextIndex = content.reduce(
      (last, block, i) => (block.type === 'text' && block.text?.trim() ? i : last),
      -1
    );
    const copyText = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    content.forEach((block, blockIndex) => {
      const key = `${messageKey}:${blockIndex}`;
      if (block.type === 'toolCall') {
        const id = block.id ?? `tool:${key}`;
        if (seenTools.has(id)) return;
        seenTools.add(id);
        activities.push({
          type: 'tool',
          key: id,
          toolCall: {
            type: 'toolCall',
            id,
            name: block.name ?? '',
            arguments: block.arguments ?? {}
          }
        });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        activities.push({
          type: 'thinking',
          key: `thinking:${key}`,
          text: block.thinking,
          showPreview: isStreaming && blockIndex === content.length - 1
        });
      } else if (block.type === 'text' && block.text?.trim()) {
        flushActivities();
        items.push({
          type: 'assistant',
          key: `text:${key}`,
          message: { ...message, content: [block], errorMessage: undefined },
          isStreaming,
          showActions: blockIndex === lastTextIndex,
          copyText
        });
      }
    });
    // 报错之后的新调用属于新的执行片段。
    if (message.stopReason === 'error') flushActivities();
  };

  return {
    addSource,
    flushActivities,
    /** 本次续建新增的条目（不含 seed 里的历史条目） */
    freshItems: () => items.slice(start),
    state: (): ChatItemBuildState => ({ items, activities, seenTools })
  };
}

/**
 * 构建历史消息（不含流式消息）。**刻意不做收尾 flush**：末尾未闭合的工具/思考活动
 * 由 buildStreamingItems 接续，保证与「历史+流式一次性构建」完全一致。
 */
export function buildMessageItems(messages: ChatMessage[]): ChatItemBuildState {
  const builder = createBuilder();
  messages.forEach((message, index) => builder.addSource(message, index, false));
  return builder.state();
}

/**
 * 构建流式消息的条目：接续历史未闭合活动并收尾 flush，返回**只有新增**的条目。
 * 每帧只处理还在增长的那条消息，历史条目由 buildMessageItems 的结果复用。
 */
export function buildStreamingItems(
  state: ChatItemBuildState,
  streamingMessage: ChatMessage | null
): ChatRenderItem[] {
  const builder = createBuilder(state);
  if (streamingMessage) builder.addSource(streamingMessage, state.items.length, true);
  builder.flushActivities();
  return builder.freshItems();
}

/** 历史 + 流式的完整条目；等价于 buildMessageItems 的结果拼接 buildStreamingItems。 */
export function buildChatItems(
  messages: ChatMessage[],
  streamingMessage: ChatMessage | null
): ChatRenderItem[] {
  const state = buildMessageItems(messages);
  return [...state.items, ...buildStreamingItems(state, streamingMessage)];
}
