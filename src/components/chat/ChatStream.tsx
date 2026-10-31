import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { ReactNode } from 'react';
import { usePiStore, type GoalEvent } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { extractText } from '../../utils/text';
import { BookmarkRail } from './BookmarkRail';
import { CAPSULE_RESERVED_TOP } from './TodoProgressCapsule';
import { getTodoProgress } from '../../utils/todo-progress';
import ChatItemView from './ChatItemView';
import StreamingTail from './StreamingTail';
import PiWelcome from './PiWelcome';
import TurnChangesCard from './TurnChangesCard';
import { collectToolCallChanges } from '../../lib/turn-changes';
import {
  buildChatItems,
  buildMessageItems,
  groupChatItemsByTurn,
  type ChatItemBuildState,
  type ChatTurn
} from './chat-items';

// 滚动到底部判定阈值（px）：距底部小于该值视为已到底
const BOTTOM_THRESHOLD = 24;
// 模块级空数组：goal 历史为空时保持引用稳定，避免拖垮下游 memo
const EMPTY_GOAL_HISTORY: GoalEvent[] = [];

/** 单轮对话容器：只在自己那轮变化时重渲染，历史各轮在流式期间完全不参与。 */
const ChatTurnView = memo(function ChatTurnView({
  turn,
  sessionId,
  goalHistory,
  onUserNode,
  onTurnNode,
  tail
}: {
  turn: ChatTurn;
  sessionId: string | null;
  goalHistory: GoalEvent[];
  onUserNode: (timestamp: number, el: HTMLDivElement | null) => void;
  onTurnNode: (timestamp: number | undefined, el: HTMLDivElement | null) => void;
  /** 流式增量（仅最后一轮非 null），由父级算好传入以免把 state 传给所有轮次 */
  tail: ReactNode;
}) {
  const userTimestamp = turn.userTimestamp;
  const setTurnRef = useCallback(
    (el: HTMLDivElement | null) => onTurnNode(userTimestamp, el),
    [userTimestamp, onTurnNode]
  );
  return (
    <div ref={setTurnRef} className="flow-root" data-chat-turn={userTimestamp}>
      {turn.items.map((item) => (
        <ChatItemView
          key={`${sessionId}:${item.key}`}
          item={item}
          goalHistory={goalHistory}
          onUserNode={onUserNode}
        />
      ))}
      {tail}
      {/* 本轮改动卡片：流式期间（本轮到 tail）不显示，轮次结束后一次性出现 */}
      {!tail && turn.changes && <TurnChangesCard changes={turn.changes} />}
    </div>
  );
});

/**
 * 消息列表。只订阅「确认过的历史 + 目标历史」（流式内容由 StreamingTail 自己订阅），
 * 因此流式期间这里不重渲染；历史条目一次构建、跨帧复用。
 */
const MessageList = memo(function MessageList({
  messages,
  isStreaming,
  sessionId,
  onUserNode,
  onTurnNode,
  onStreamGrow
}: {
  messages: any[];
  isStreaming: boolean;
  sessionId: string | null;
  onUserNode: (timestamp: number, el: HTMLDivElement | null) => void;
  onTurnNode: (timestamp: number | undefined, el: HTMLDivElement | null) => void;
  onStreamGrow: () => void;
}) {
  const goalHistory = usePiStore((s) => s.goalSnapshot?.goalHistory) ?? EMPTY_GOAL_HISTORY;
  // 历史前缀按 messages 引用记忆化：流式期间引用不变，增量部分只处理还在长的那条消息
  const state = useMemo<ChatItemBuildState>(() => buildMessageItems(messages), [messages]);
  // 工具调用 → 该次调用产生的文件改动（edit/write），按轮聚合成「本次改动」卡片内容
  const changeByToolCall = useMemo(() => collectToolCallChanges(messages), [messages]);
  const turns = useMemo(
    () =>
      groupChatItemsByTurn(
        // 非流式时一次性构建（含末尾收尾条目），与流式期间的「前缀 + 增量」等价
        isStreaming ? state.items : buildChatItems(messages, null),
        changeByToolCall
      ),
    [state, messages, isStreaming, changeByToolCall]
  );
  const tail = isStreaming ? (
    <StreamingTail state={state} sessionId={sessionId} onGrow={onStreamGrow} />
  ) : null;

  return (
    <>
      {/* 阅读宽度：窗口拉宽/收起右侧面板后，正文不要横跨整屏（约 90 字符/行）。
          注意只能包住对话内容——PiWelcome 的 h-full 依赖滚动区这一层确定高度，
          包进这个 const 高度为 auto 的 div 里会让欢迎页 logo 掉到顶部。 */}
      <div className="mx-auto w-full max-w-[56rem]">
        {turns.map((turn, index) => (
          <ChatTurnView
            key={`${sessionId}:${turn.key}`}
            turn={turn}
            sessionId={sessionId}
            goalHistory={goalHistory}
            onUserNode={onUserNode}
            onTurnNode={onTurnNode}
            tail={index === turns.length - 1 ? tail : null}
          />
        ))}
        {isStreaming && turns.length === 0 && tail}
      </div>
      {turns.length === 0 && !isStreaming && <PiWelcome key={sessionId} />}
    </>
  );
});

export default function ChatStream() {
  const messages = usePiStore((s) => s.messages);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const sessionId = usePiStore((s) => s.sessionId);
  const showBookmarks = usePiStore((s) => s.showBookmarks);
  // 任务胶囊是浮在聊天区顶部的浮层（不占流），有胶囊时滚动区要自己让出顶部空间
  const hasTodoCapsule = usePiStore((s) => getTodoProgress(s.todoPhases) !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 是否用户手动上滑（粘底滚动逻辑）
  const [stickToBottom, setStickToBottom] = useState(true);
  // 同一标记的 ref 版本：流式增量回调在渲染提交后读取，不能等 state 传播
  const stickToBottomRef = useRef(true);
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

  // 粘底标记改动的唯一入口：state 与 ref 必须同步更新
  const setStick = useCallback((value: boolean) => {
    stickToBottomRef.current = value;
    setStickToBottom(value);
  }, []);

  // 节点注册回调：引用稳定，否则每轮/每条条目的 memo 全部失效
  const setUserNode = useCallback((timestamp: number, el: HTMLDivElement | null) => {
    if (el) userMsgRefs.current.set(timestamp, el);
    else userMsgRefs.current.delete(timestamp);
  }, []);
  const setTurnNode = useCallback((timestamp: number | undefined, el: HTMLDivElement | null) => {
    if (timestamp === undefined) return;
    if (el) turnRefs.current.set(timestamp, el);
    else turnRefs.current.delete(timestamp);
  }, []);

  // 监听滚动：更新粘底状态与「到底」状态
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = dist <= BOTTOM_THRESHOLD;
    setAtBottom(isAtBottom);
    // 程序化滚动期间不覆盖粘底标记（由 scrollToUserMessage/scrollToLatest 显式控制）
    if (!suppressStickRef.current) setStick(isAtBottom);
  }, [setStick]);

  // 自动滚动到底部：仅在新消息入列且当前粘底时执行
  // （胶囊显隐会改变顶部内边距、内容整体下移，同样需要重新贴底）
  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, stickToBottom, hasTodoCapsule]);

  // 流式内容增长：由 StreamingTail 在 DOM 提交后回调。
  // 这里不订阅流式内容本身，否则整段历史会跟着逐帧重渲染。
  const handleStreamGrow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // 切换会话/清空消息时重置粘底
  useEffect(() => {
    setStick(true);
    setAtBottom(true);
    // 消息 ref 在挂载/卸载时维护映射；此时清空会丢掉新会话已挂载的节点。
    // 重置程序化滚动抑制标记
    suppressStickRef.current = false;
    if (suppressTimerRef.current) {
      clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, [sessionId, setStick]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    };
  }, []);

  // 滚动到指定用户消息
  const scrollToUserMessage = useCallback(
    (timestamp: number) => {
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
      setStick(false);
      // 顶部留边距：直接用滚动区自己的 padding-top，这样有任务胶囊时
      // 目标消息会落在胶囊下方而不是被盖住
      const topInset = parseFloat(getComputedStyle(container).paddingTop) || 8;
      container.scrollTo({ top: Math.max(0, offsetTop - topInset), behavior: 'smooth' });
    },
    [setStick]
  );

  // 滚动到底部（回到最新）
  const scrollToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      setStick(true);
      setAtBottom(true);
    }
  }, [setStick]);

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
        className={`h-full overflow-y-auto px-6 py-4 ${hasTodoCapsule ? CAPSULE_RESERVED_TOP : ''}`}
        data-chat-scroll
      >
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          sessionId={sessionId}
          onUserNode={setUserNode}
          onTurnNode={setTurnNode}
          onStreamGrow={handleStreamGrow}
        />
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
