import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n/zh';
import { truncate } from '../../utils/text';
import { normalizeWhitespace } from './chat-utils';

type BookmarkData = { timestamp: number; content: string };

/** 预览浮层与聊天区上下边界的留白（≈ 半个浮层高，避开 ChatStream 的 overflow-hidden） */
const CARD_EDGE = 16;
/** 浮层左边缘：书签栏宽 20px + 与竖条之间 6px 空隙（不贴住竖条） */
const CARD_LEFT = 26;

/**
 * 左侧书签栏：根据用户消息在会话中的位置（按时间顺序），
 * 在垂直方向按比例放置窄矩形书签。
 * - 默认：窄竖条（6px 高、12px 宽），hover 时只拉宽 + 发光（**不改高度**）。
 *   高度一变整栏（justify-center）就会重新居中，书签与预览浮层会错位。
 * - 点击：滚动到对应用户消息。
 * - 用户消息或其后续模型回复、思考、工具活动可见时，对应书签显示为黄色。
 * - 悬停预览是一个**独立的小浮层**：与竖条留 6px 空隙、四角圆角、不贴边、不可点击，
 *   垂直居中于当前书签。它渲染在滚动容器之外，避免被 overflow 裁掉。
 * - 书签数超过可视高度（长会话）时整栏可滚动：滚动条 4px 细条，不挤占内容。
 */
export function BookmarkRail({
  userMessages,
  scrollRoot,
  turnRefs,
  onJump
}: {
  userMessages: { timestamp: number; content: string }[];
  scrollRoot: RefObject<HTMLDivElement>;
  turnRefs: RefObject<Map<number, HTMLDivElement>>;
  onJump: (timestamp: number) => void;
}) {
  const [visibleBookmarks, setVisibleBookmarks] = useState<ReadonlySet<number>>(() => new Set());
  const railRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollable, setScrollable] = useState(false);
  const [hovered, setHovered] = useState<{ timestamp: number; top: number } | null>(null);

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const targets = new Map<Element, number>();
    for (const message of userMessages) {
      const node = turnRefs.current?.get(message.timestamp);
      if (node) targets.set(node, message.timestamp);
    }
    const visible = new Set<number>();
    let disposed = false;
    // 一轮只观察一个容器，避免同轮多个内容块进出视口时相互取消高亮。
    // 滚动、窗口缩放、工具展开和流式内容导致的布局变化均会更新。
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed) return;
        for (const entry of entries) {
          const timestamp = targets.get(entry.target);
          if (timestamp === undefined) continue;
          if (entry.isIntersecting) visible.add(timestamp);
          else visible.delete(timestamp);
        }
        setVisibleBookmarks((previous) =>
          previous.size === visible.size && [...visible].every((id) => previous.has(id))
            ? previous
            : new Set(visible)
        );
      },
      // 不设可见比例下限，超长回复只露出一小部分也应高亮。
      { root, threshold: 0 }
    );
    targets.forEach((_timestamp, node) => observer.observe(node));
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [userMessages, scrollRoot, turnRefs]);

  const bookmarks = useMemo<BookmarkData[]>(() => {
    return userMessages.map((m) => ({
      timestamp: m.timestamp,
      content: m.content
    }));
  }, [userMessages]);

  const registerBar = useCallback((timestamp: number, el: HTMLDivElement | null) => {
    if (el) barRefs.current.set(timestamp, el);
    else barRefs.current.delete(timestamp);
  }, []);

  // 是否需要滚动：只有真的装不下时才接管指针事件（否则滚轮照常滚聊天区）
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const update = () => setScrollable(strip.scrollHeight > strip.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [bookmarks.length]);

  // 跟随：把当前可见的第一条书签滚进视野（只改 strip.scrollTop，不惊动外层聊天滚动）
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const first = bookmarks.find((bm) => visibleBookmarks.has(bm.timestamp));
    if (!first) return;
    const bar = barRefs.current.get(first.timestamp);
    if (!bar) return;
    const top = bar.offsetTop;
    const bottom = top + bar.offsetHeight;
    if (top < strip.scrollTop) strip.scrollTop = Math.max(0, top - 8);
    else if (bottom > strip.scrollTop + strip.clientHeight)
      strip.scrollTop = bottom - strip.clientHeight + 8;
  }, [bookmarks, visibleBookmarks]);

  // 浮层定位只读「书签当前的静态几何」：书签 hover 时不改尺寸、整栏不会重新居中，
  // 所以进入时量一次就永远对齐（旧实现 hover 变高 → 重新居中 → 浮层与书签错位）。
  const handleHover = useCallback((timestamp: number, el: HTMLElement | null) => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    const rail = railRef.current;
    if (!el || !rail) {
      // 相邻书签之间只有 4px 空隙，延迟隐藏可以避免来回移动时闪烁。
      hideTimerRef.current = setTimeout(() => setHovered(null), 120);
      return;
    }
    const railRect = rail.getBoundingClientRect();
    const barRect = el.getBoundingClientRect();
    const center = barRect.top - railRect.top + barRect.height / 2;
    const top = Math.min(Math.max(center, CARD_EDGE), railRect.height - CARD_EDGE);
    setHovered({ timestamp, top });
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const hoveredBookmark = hovered
    ? bookmarks.find((bm) => bm.timestamp === hovered.timestamp)
    : undefined;

  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute left-0 top-0 z-10 flex h-full w-5 flex-col items-start py-2"
      aria-label={t.showBookmarks}
    >
      <div
        ref={stripRef}
        onScroll={() => setHovered(null)}
        className={`bookmark-strip flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto ${
          scrollable ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
      >
        {/* min-h-full + justify-center：书签少时垂直居中（与旧行为一致），多时正常滚动 */}
        <div className="flex min-h-full w-full flex-col items-start justify-center gap-1">
          {bookmarks.map((bm) => (
            <BookmarkBar
              key={bm.timestamp}
              bm={bm}
              visible={visibleBookmarks.has(bm.timestamp)}
              onJump={onJump}
              onHover={handleHover}
              register={registerBar}
            />
          ))}
        </div>
      </div>
      {/* 悬停预览：独立小浮层（不贴住竖条、不可点击），渲染在滚动容器之外避免被裁剪 */}
      {hoveredBookmark && hovered && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-30 flex max-w-[240px] items-center rounded-md border border-od-border bg-od-bg-alt px-2 py-1 text-xs text-od-text shadow-lg"
          style={{ left: CARD_LEFT, top: hovered.top, transform: 'translateY(-50%)' }}
        >
          <span className="truncate">
            {truncate(normalizeWhitespace(hoveredBookmark.content), 160)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 单个书签：窄竖条，hover 时变粗并拉出预览卡片（卡片由父级渲染，见 BookmarkRail）。
 * 书签整体在书签栏中垂直居中堆叠。
 */
const BookmarkBar = memo(function BookmarkBar({
  bm,
  visible,
  onJump,
  onHover,
  register
}: {
  bm: BookmarkData;
  visible: boolean;
  onJump: (timestamp: number) => void;
  onHover: (timestamp: number, el: HTMLElement | null) => void;
  register: (timestamp: number, el: HTMLDivElement | null) => void;
}) {
  const color = visible ? 'var(--od-yellow)' : 'var(--od-accent)';
  const setRef = useCallback(
    (el: HTMLDivElement | null) => register(bm.timestamp, el),
    [bm.timestamp, register]
  );
  const preview = useMemo(() => truncate(normalizeWhitespace(bm.content), 160), [bm.content]);

  // 注意两点：
  // 1. 外层容器是 pointer-events-none，滚动容器在「装得下」时也是 pointer-events-none
  //   （这样滚轮能透传给聊天区），所以书签自身必须显式 pointer-events-auto，
  //   否则 hover / 点击都会静默失效。
  // 2. 高度固定 6px：hover 只拉宽 + 发光（见 index.css 的 .bookmark-bar:hover）。
  //   高度一变整栏 justify-center 就会重新居中，预览浮层立刻与书签错位。
  return (
    <div
      ref={setRef}
      className="bookmark-bar pointer-events-auto flex h-1.5 w-full shrink-0 items-center"
      onMouseEnter={(event) => onHover(bm.timestamp, event.currentTarget)}
      onMouseLeave={() => onHover(bm.timestamp, null)}
    >
      <button
        type="button"
        aria-label={preview}
        aria-current={visible ? 'location' : undefined}
        onClick={() => onJump(bm.timestamp)}
        className="flex items-center"
      >
        {/* 当前可见对话轮次用黄色，其他书签保持蓝色；当前色也用作发光色（currentColor）。 */}
        <span
          className={`bookmark-chip block h-1.5 rounded-r-sm ${visible ? 'opacity-100' : 'opacity-70'}`}
          style={{ background: `rgb(${color})`, color: `rgb(${color})` }}
        />
      </button>
    </div>
  );
});
