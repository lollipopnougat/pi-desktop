import { useEffect, useMemo, useState, type RefObject } from 'react';
import { t } from '../../i18n/zh';
import { truncate } from '../../utils/text';
import { normalizeWhitespace } from './chat-utils';

/**
 * 左侧书签栏：根据用户消息在会话中的位置（按时间顺序），
 * 在垂直方向按比例放置窄矩形书签。
 * - 默认：窄竖条（4px 宽），hover 时向右拉出展示消息内容（带动画）。
 * - 点击：滚动到对应用户消息。
 * - 用户消息或其后续模型回复、思考、工具活动可见时，对应书签显示为黄色。
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

  const bookmarks = useMemo(() => {
    return userMessages.map((m) => ({
      timestamp: m.timestamp,
      content: m.content
    }));
  }, [userMessages]);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-10 flex h-full w-5 flex-col items-start justify-center gap-1 py-2"
      aria-label={t.showBookmarks}
    >
      {bookmarks.map((bm) => (
        <Bookmark
          key={bm.timestamp}
          bm={bm}
          visible={visibleBookmarks.has(bm.timestamp)}
          onJump={onJump}
        />
      ))}
    </div>
  );
}

/**
 * 单个书签：窄竖条，hover 向右拉出展示内容。
 * 书签整体在书签栏中垂直居中堆叠（flex justify-center）。
 */
function Bookmark({
  bm,
  visible,
  onJump
}: {
  bm: { timestamp: number; content: string };
  visible: boolean;
  onJump: (timestamp: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const BAR_H = 28; // 窄竖条高度
  const MAX_WIDTH = 240; // 拉出卡片最大宽度
  const color = visible ? 'var(--od-yellow)' : 'var(--od-accent)';

  const preview = useMemo(() => truncate(normalizeWhitespace(bm.content), 160), [bm.content]);

  return (
    <div
      className="pointer-events-auto flex items-center transition-all duration-200 ease-out"
      style={{ height: hovered ? `${BAR_H}px` : `${BAR_H - 22}px` }}
    >
      {/* 可点击/可 hover 的整体热区（含拉出卡片） */}
      <button
        type="button"
        aria-label={preview}
        aria-current={visible ? 'location' : undefined}
        onClick={() => onJump(bm.timestamp)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="group flex items-center transition-all duration-200 ease-out"
        style={{ height: hovered ? `${BAR_H}px` : `${BAR_H - 22}px` }}
      >
        {/* 当前可见对话轮次用黄色，其他书签保持蓝色；悬停时延续各自颜色。 */}
        <span
          className="block rounded-r-sm transition-all duration-200 ease-out"
          style={{
            width: hovered ? 16 : 12,
            height: hovered ? BAR_H : BAR_H - 22,
            background: `rgb(${color})`,
            opacity: hovered || visible ? 1 : 0.7,
            boxShadow: hovered ? `0 0 6px rgb(${color} / 0.6)` : 'none'
          }}
        />
        {/* 拉出卡片：默认宽度 0 / 不可见，hover 时展开 */}
        <span
          className="flex items-center overflow-hidden whitespace-nowrap rounded-r-md border border-l-0 border-od-border bg-od-bg-alt text-xs text-od-text transition-all duration-200 ease-out"
          style={{
            maxWidth: hovered ? `${MAX_WIDTH}px` : '0px',
            height: hovered ? `${BAR_H}px` : `${BAR_H}px`,
            opacity: hovered ? 1 : 0,
            marginLeft: 0,
            paddingLeft: hovered ? 8 : 0,
            paddingRight: hovered ? 8 : 0,
            paddingTop: 0,
            paddingBottom: 0
          }}
        >
          <span className="truncate">{preview}</span>
        </span>
      </button>
    </div>
  );
}
