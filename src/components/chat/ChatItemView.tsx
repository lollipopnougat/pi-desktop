import { memo, useCallback } from 'react';
import type { ChatRenderItem } from './chat-items';
import type { GoalEvent } from '../../store/pi-store';
import UserMessageContent from './messages/UserMessageContent';
import AssistantMessage from './messages/AssistantMessage';
import MessageActions from './MessageActions';
import CollapsedToolGroup from './tool-calls/CollapsedToolGroup';
import { extractText } from '../../utils/text';
import { t } from '../../i18n/zh';

/**
 * 单条聊天条目的渲染。三类条目各自 export-ready 地 memo 化：一次构建里没变的条目
 * （拖入新消息、流式转历史时）直接跳过重渲染，长会话不再每次全量走一遍 Markdown。
 * 父级只需保证传入的 props 引用稳定（item / goalHistory / onUserNode）。
 */

const UserItem = memo(function UserItem({
  item,
  goalHistory,
  onUserNode
}: {
  item: Extract<ChatRenderItem, { type: 'user' }>;
  goalHistory: GoalEvent[];
  onUserNode: (timestamp: number, el: HTMLDivElement | null) => void;
}) {
  const timestamp = item.message.timestamp ?? 0;
  // ref 回调用 useCallback 固定：行内箭头每次渲染都是新函数，会触发额外的 ref 解绑/绑定
  const setRef = useCallback(
    (el: HTMLDivElement | null) => onUserNode(timestamp, el),
    [timestamp, onUserNode]
  );
  const goalEvt = goalHistory.find((e) => Math.abs(timestamp - e.goalMessageTimestamp) < 5000);
  return (
    <div ref={setRef} className="mb-3 flex flex-col items-end">
      <div className="max-w-[80%] break-words rounded-2xl rounded-br-sm bg-od-accent/50 px-4 py-2.5 text-sm text-od-text-bright">
        <UserMessageContent content={item.message.content} />
      </div>
      <MessageActions
        timestamp={timestamp}
        copyText={extractText(item.message.content)}
        align="right"
        badge={goalEvt ? t.goal.badgeSetGoal : undefined}
      />
    </div>
  );
});

const AssistantItem = memo(function AssistantItem({
  item,
  goalHistory
}: {
  item: Extract<ChatRenderItem, { type: 'assistant' }>;
  goalHistory: GoalEvent[];
}) {
  const message = item.message;
  const goalEvt = goalHistory.find(
    (e) => e.completedMessageTimestamp != null && message.timestamp === e.completedMessageTimestamp
  );
  return (
    <AssistantMessage
      message={message}
      isStreaming={item.isStreaming}
      timestamp={message.timestamp}
      showActions={item.showActions}
      copyText={item.copyText}
      showStreamingStatus={false}
      badge={
        goalEvt
          ? goalEvt.status === 'blocked'
            ? t.goal.badgeBlocked
            : t.goal.badgeCompleted(goalEvt.completedTimeUsed ?? 0)
          : undefined
      }
    />
  );
});

const ToolGroupItem = memo(function ToolGroupItem({
  item
}: {
  item: Extract<ChatRenderItem, { type: 'toolGroup' }>;
}) {
  return <CollapsedToolGroup activities={item.activities} />;
});

/** 分发到三类条目；memo 让复用同一 item 引用时的重渲染到此为止。 */
function ChatItemView(props: {
  item: ChatRenderItem;
  goalHistory: GoalEvent[];
  onUserNode: (timestamp: number, el: HTMLDivElement | null) => void;
}) {
  const { item, goalHistory, onUserNode } = props;
  if (item.type === 'user') {
    return <UserItem item={item} goalHistory={goalHistory} onUserNode={onUserNode} />;
  }
  if (item.type === 'assistant') {
    return <AssistantItem item={item} goalHistory={goalHistory} />;
  }
  return <ToolGroupItem item={item} />;
}

export default memo(ChatItemView);
