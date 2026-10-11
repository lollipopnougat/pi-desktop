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

/** 正文、用户消息和错误是边界；工具结果及思考不打断连续工具活动。 */
export function buildChatItems(
  messages: ChatMessage[],
  streamingMessage: ChatMessage | null
): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let activities: ToolActivity[] = [];
  const seenTools = new Set<string>();
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

  const sources = messages.map((message, index) => ({ message, index, isStreaming: false }));
  if (streamingMessage) {
    sources.push({ message: streamingMessage, index: messages.length, isStreaming: true });
  }
  for (const { message, index, isStreaming } of sources) {
    if (message.role === 'toolResult') continue;
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content ?? []);
    const messageKey = `${message.timestamp ?? 'live'}:${index}`;
    if (message.role === 'user') {
      if (content.some((block) => /<!-- goal-continuation: [\w:-]+ -->/.test(block.text ?? ''))) {
        continue;
      }
      flushActivities();
      items.push({ type: 'user', key: `user:${messageKey}`, message });
      continue;
    }
    if (message.role !== 'assistant' && !isStreaming) {
      flushActivities();
      continue;
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
  }
  flushActivities();
  return items;
}
