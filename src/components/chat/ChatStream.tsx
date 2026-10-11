import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { extractText } from '../../utils/text';
import { BookmarkRail } from './BookmarkRail';
import UserMessageContent from './messages/UserMessageContent';
import AssistantMessage from './messages/AssistantMessage';
import MessageActions from './MessageActions';
import CollapsedToolGroup from './tool-calls/CollapsedToolGroup';
import { buildChatItems, groupChatItemsByTurn } from './chat-items';

export default function ChatStream() {
  const { messages, streamingMessage, isStreaming, goalSnapshot } = usePiStore();
  const sessionId = usePiStore((s) => s.sessionId);
  const showBookmarks = usePiStore((s) => s.showBookmarks);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 是否用户手动上滑（粘底滚动逻辑）
  const [stickToBottom, setStickToBottom] = useState(true);
  // 是否已滚动到底部（控制「回到最新」按钮显隐）
  const [atBottom, setAtBottom] = useState(true);
  // 用户消息 DOM 节点引用（用于书签点击滚动定位）
  const userMsgRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // 整轮对话 DOM 节点引用（用户消息及后续模型内容均可触发书签高亮）
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // 程序化滚动（书签跳转/回到最新）期间抑制粘底回拽，避免平滑滚动刚起步时
  // handleScroll 把 stickToBottom 翻回 true → 粘底 effect 又把页面拽回底部
  const suppressStickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 滚动到底部判定阈值（px）：距底部小于该值视为已到底
  const BOTTOM_THRESHOLD = 24;

  // 监听滚动：更新粘底状态与「到底」状态
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = dist <= BOTTOM_THRESHOLD;
    setAtBottom(isAtBottom);
    // 程序化滚动期间不覆盖粘底标记（由 scrollToUserMessage/scrollToLatest 显式控制）
    if (!suppressStickRef.current) {
      // 用户主动滚动时，更新粘底标记（仅当不在底部时认为用户上滑）
      setStickToBottom(isAtBottom);
    }
  }, []);

  // 自动滚动到底部：仅在新内容到达且当前粘底时执行
  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingMessage, stickToBottom]);

  // 切换会话/清空消息时重置粘底
  useEffect(() => {
    setStickToBottom(true);
    setAtBottom(true);
    // 消息 ref 在挂载/卸载时维护映射；此时清空会丢掉新会话已挂载的节点。
    // 重置程序化滚动抑制标记
    suppressStickRef.current = false;
    if (suppressTimerRef.current) {
      clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, [sessionId]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    };
  }, []);

  // 滚动到指定用户消息
  const scrollToUserMessage = useCallback((timestamp: number) => {
    const el = userMsgRefs.current.get(timestamp);
    const container = scrollRef.current;
    if (!el || !container) return;
    // 用 getBoundingClientRect 相对计算，避免 offsetParent 嵌套定位导致偏移不准
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offsetTop = elRect.top - containerRect.top + container.scrollTop;
    // 点击书签 = 明确离开底部：先关掉粘底，并在平滑滚动期间抑制 handleScroll 回拽
    suppressStickRef.current = true;
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = setTimeout(() => {
      suppressStickRef.current = false;
    }, 600);
    setStickToBottom(false);
    // 贴近顶部留少量边距
    container.scrollTo({ top: Math.max(0, offsetTop - 8), behavior: 'smooth' });
  }, []);

  // 滚动到底部（回到最新）
  const scrollToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      setStickToBottom(true);
      setAtBottom(true);
    }
  }, []);

  const renderItems = buildChatItems(messages, streamingMessage);
  const turns = groupChatItemsByTurn(renderItems);
  const goalHistory = goalSnapshot?.goalHistory ?? [];
  const userMessages = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .filter(
          (message) => !/<!-- goal-continuation: [\w:-]+ -->/.test(extractText(message.content))
        )
        .map((message) => ({
          timestamp: message.timestamp,
          content: extractText(message.content)
        })),
    [messages]
  );

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* 聊天滚动区 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-6 py-4"
        data-chat-scroll
      >
        {renderItems.length === 0 && !isStreaming && (
          <div className="flex h-full items-center justify-center text-od-text-dim">
            <div className="text-center">
              <p className="text-lg text-od-text-bright">{t.welcomeTitle}</p>
              <p className="mt-1 text-sm">{t.welcomeHint}</p>
            </div>
          </div>
        )}
        {turns.map((turn, turnIndex) => (
          <div
            key={`${sessionId}:${turn.key}`}
            ref={(el) => {
              if (turn.userTimestamp === undefined) return;
              if (el) turnRefs.current.set(turn.userTimestamp, el);
              else turnRefs.current.delete(turn.userTimestamp);
            }}
            className="flow-root"
            data-chat-turn={turn.userTimestamp}
          >
            {turn.items.map((item) => {
              if (item.type === 'user') {
                const timestamp = item.message.timestamp ?? 0;
                const goalEvt = goalHistory.find(
                  (e) => Math.abs(timestamp - e.goalMessageTimestamp) < 5000
                );
                return (
                  <div
                    key={`${sessionId}:${item.key}`}
                    ref={(el) => {
                      if (el) userMsgRefs.current.set(timestamp, el);
                      else userMsgRefs.current.delete(timestamp);
                    }}
                    className="mb-3 flex flex-col items-end"
                  >
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
              }
              if (item.type === 'assistant') {
                const goalEvt = goalHistory.find(
                  (e) =>
                    e.completedMessageTimestamp != null &&
                    item.message.timestamp === e.completedMessageTimestamp
                );
                return (
                  <AssistantMessage
                    key={`${sessionId}:${item.key}`}
                    message={item.message}
                    isStreaming={item.isStreaming}
                    timestamp={item.message.timestamp}
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
              }
              if (item.type === 'toolGroup') {
                return (
                  <CollapsedToolGroup
                    key={`${sessionId}:${item.key}`}
                    activities={item.activities}
                  />
                );
              }
              return null;
            })}
            {isStreaming && turnIndex === turns.length - 1 && (
              <AssistantMessage
                key={`${sessionId}:streaming-status`}
                message={{ content: [] }}
                isStreaming
              />
            )}
          </div>
        ))}
        {isStreaming && turns.length === 0 && (
          <AssistantMessage
            key={`${sessionId}:streaming-status`}
            message={{ content: [] }}
            isStreaming
          />
        )}
      </div>

      {/* 左侧书签栏：按用户消息顺序/比例排列窄矩形 */}
      {showBookmarks && userMessages.length > 0 && (
        <BookmarkRail
          key={sessionId}
          userMessages={userMessages}
          scrollRoot={scrollRef}
          turnRefs={turnRefs}
          onJump={scrollToUserMessage}
        />
      )}

      {/* 右侧悬浮「回到最新」按钮：未到底时显示 */}
      {!atBottom && (
        <button
          onClick={scrollToLatest}
          className="absolute bottom-4 right-4 z-20 flex items-center gap-1.5 rounded-full border border-od-border bg-od-bg-alt px-3 py-1.5 text-xs text-od-text shadow-lg transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          title={t.scrollToLatest}
        >
          <Icon name="chevronDown" className="w-3" />
          {t.scrollToLatest}
        </button>
      )}
    </div>
  );
}
