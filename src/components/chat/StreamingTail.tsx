import { memo, useLayoutEffect, useMemo } from 'react';
import { buildStreamingItems, type ChatItemBuildState } from './chat-items';
import type { GoalEvent } from '../../store/pi-store';
import { useStreamingMessage } from '../../hooks/useStreamingMessage';
import AssistantMessage from './messages/AssistantMessage';
import ChatItemView from './ChatItemView';

/**
 * 流式增量渲染。整段历史由父级 MessageList 记忆化，这里只负责「还在长的那条消息」：
 * 订阅流式消息（rAF 合帧 + transition），每帧只重建增量条目。
 * 只在流式期间挂载；结束后的收尾条目由父级的完整构建负责（见 MessageList 的 turns）。
 */
function StreamingTail({
  state,
  sessionId,
  onGrow
}: {
  /** 历史构建结果：用于接续未闭合的工具活动 */
  state: ChatItemBuildState;
  sessionId: string | null;
  /** 内容提交后回调（滚动只能发生在 DOM 长高之后） */
  onGrow: () => void;
}) {
  const streamingMessage = useStreamingMessage();
  const items = useMemo(
    () => buildStreamingItems(state, streamingMessage),
    [state, streamingMessage]
  );

  // 无依赖：本组件每次提交都意味着流式内容变长了，粘底时跟随滚动
  useLayoutEffect(() => {
    onGrow();
  });

  return (
    <>
      {items.map((item) => (
        <ChatItemView
          key={`${sessionId}:${item.key}`}
          item={item}
          goalHistory={NO_GOAL_HISTORY}
          onUserNode={NO_USER_NODE}
        />
      ))}
      <AssistantMessage
        key={`${sessionId}:streaming-status`}
        message={EMPTY_STREAMING_MESSAGE}
        isStreaming
      />
    </>
  );
}

export default memo(StreamingTail);

// 模块级常量：内联对象/函数每次渲染都是新引用，会让 memo 失效并拖回逐帧全量重渲染
const NO_GOAL_HISTORY: GoalEvent[] = [];
const NO_USER_NODE = () => {};
const EMPTY_STREAMING_MESSAGE = { content: [] };
