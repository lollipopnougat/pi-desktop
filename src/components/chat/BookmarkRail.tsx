import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n/zh';
import { truncate } from '../../utils/text';
import { normalizeWhitespace } from './chat-utils';

type BookmarkData = { timestamp: number; content: string };

/**
 * 左侧书签栏：根据用户消息在会话中的位置（按时间顺序），
 * 在垂直方向按比例放置窄矩形书签。
 * - 默认：窄竖条（4px 宽），hover 时向右拉出展示消息内容（带动画）。
 * - 点击：滚动到对应用户消息。
 * - 用户消息或其后续模型回复、思考、工具活动可见时，对应书签显示为黄色。
 * - 书签数超过可视高度（长会话）时整栏可滚动：滚动条 4px 细条，不挤占内容；
 *   悬停预览卡片放在滚动容器之外渲染，否则会被 overflow 裁掉。
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

  const handleHover = useCallback((timestamp: number, el: HTMLElement | null) => {
    const strip = stripRef.current;
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (!el || !strip) {
      // 预览卡片在滚动容器之外，从竖条移到卡片会经过空隙：延迟隐藏，允许鼠标移入卡片
      hideTimerRef.current = setTimeout(() => setHovered(null), 160);
      return;
    }
    setHovered({ timestamp, top: el.offsetTop + el.offsetHeight / 2 - strip.scrollTop });
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hoveredBookmark = hovered
    ? bookmarks.find((bm) => bm.timestamp === hovered.timestamp)
    : undefined;

  return (
    <div
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
      {/* 预览卡片：渲染在滚动容器之外，避免被 overflow 裁剪 */}
      {hoveredBookmark && hovered && (
        <button
          type="button"
          aria-label={truncate(normalizeWhitespace(hoveredBookmark.content), 160)}
          onClick={() => {
            onJump(hoveredBookmark.timestamp);
            setHovered(null);
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={() => setHovered(null)}
          className="pointer-events-auto absolute left-4 z-20 flex max-w-[240px] items-center overflow-hidden rounded-r-md border border-l-0 border-od-border bg-od-bg-alt px-2 py-1 text-xs text-od-text shadow-lg"
          style={{ top: hovered.top, transform: 'translateY(-50%)' }}
        >
          <span className="truncate">
            {truncate(normalizeWhitespace(hoveredBookmark.content), 160)}
          </span>
        </button>
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
  const [hovered, setHovered] = useState(false);
  const BAR_H = 28; // 窄竖条高度
  const color = visible ? 'var(--od-yellow)' : 'var(--od-accent)';
  const setRef = useCallback(
    (el: HTMLDivElement | null) => register(bm.timestamp, el),
    [bm.timestamp, register]
  );
  const preview = useMemo(() => truncate(normalizeWhitespace(bm.content), 160), [bm.content]);

  return (
    <div
      ref={setRef}
      className="flex w-full shrink-0 items-center transition-all duration-200 ease-out"
      style={{ height: hovered ? `${BAR_H}px` : `${BAR_H - 22}px` }}
    >
      <button
        type="button"
        aria-label={preview}
        aria-current={visible ? 'location' : undefined}
        onClick={() => onJump(bm.timestamp)}
        onMouseEnter={(event) => {
          setHovered(true);
          onHover(bm.timestamp, event.currentTarget.parentElement);
        }}
        onMouseLeave={() => {
          setHovered(false);
          onHover(bm.timestamp, null);
        }}
        className="flex items-center transition-all duration-200 ease-out"
        style={{ height: hovered ? `${BAR_H}px` : `${BAR_H - 22}px` }}
      >
        {/* 当前可见对话轮次用黄色，其他书签保持蓝色；悬停时延续各自颜色。 */}
        <span
          className="block rounded-r-sm transition-all duration-200 ease-out"
          style={{
            width: hovered ? 14 : 12,
            height: hovered ? BAR_H : BAR_H - 22,
            background: `rgb(${color})`,
            opacity: hovered || visible ? 1 : 0.7,
            boxShadow: hovered ? `0 0 6px rgb(${color} / 0.6)` : 'none'
          }}
        />
      </button>
    </div>
  );
});
