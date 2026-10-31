/**
 * 悬停提示（标题栏按钮用）：一行文案 + 快捷键胶囊，样式对齐 Codex 的 pill tooltip。
 *
 * 为什么不用原生 `title`：
 * - `title` 有 1~2 秒延迟、样式不可控、深色主题下是系统白框
 * - **`title` 在 `disabled` 的按钮上不显示**（Chromium 行为），而导航键走到历史两端时就是要置灰
 *   提示「到头了」，这时候最需要说明
 *
 * 三个实现细节：
 * 1. 用 `fixed` + 触发器 `getBoundingClientRect()` 定位，不用 `absolute`——标题栏处在
 *    flex/滚动/裁切上下文里，绝对定位会被裁掉
 * 2. 首次渲染后按实际宽度夹到视口内（非 macOS 上标题栏从 16px 起，居中会溢出左边）
 * 3. `pointer-events-none`：提示本身不能吃掉 hover，否则一闪一闪
 *
 * `shortcutId` 传了就显示当前绑定（用户改键后提示立刻跟着变）；未分配则不显示胶囊。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePiStore } from '../../store/pi-store';
import { formatBinding, type ShortcutActionId } from '../../lib/shortcuts';

/** 悬停多久后出现：太短会跟着鼠标乱闪，太长会让人以为没有提示 */
const SHOW_DELAY_MS = 280;
/** 与触发器、视口边缘的最小间距 */
const GAP = 6;

export interface TooltipProps {
  /** 提示文案 */
  label: string;
  /** 快捷键动作 id（可选）：显示对应按键，未分配时不显示胶囊 */
  shortcutId?: ShortcutActionId;
  /** 触发元素 */
  children: ReactNode;
  /** 提示相对触发器的方位，默认在下方（贴标题栏下沿） */
  placement?: 'bottom' | 'top';
}

export default function Tooltip({
  label,
  shortcutId,
  children,
  placement = 'bottom'
}: TooltipProps) {
  const binding = usePiStore((s) => (shortcutId ? s.shortcuts[shortcutId] : ''));
  const isMac = window.pi?.platform === 'darwin';
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 先按触发器算出锚点，量到真实宽度后再夹进视口 */
  const [anchor, setAnchor] = useState<{ top: number; center: number } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const show = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({
        top: placement === 'bottom' ? rect.bottom + GAP : rect.top - GAP,
        center: rect.left + rect.width / 2
      });
    }, SHOW_DELAY_MS);
  };

  const hide = () => {
    clearTimer();
    setAnchor(null);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!anchor) return;
    const width = tipRef.current?.offsetWidth ?? 0;
    const left = Math.min(
      Math.max(GAP, anchor.center - width / 2),
      Math.max(GAP, window.innerWidth - width - GAP)
    );
    // top 在 placement === 'top' 时表示「底边贴在触发器上方」，用 translateY(-100%) 对齐
    setPos({ top: anchor.top, left });
  }, [anchor]);

  const keys = binding ? formatBinding(binding, isMac) : '';

  return (
    <span
      ref={wrapRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {anchor && (
        <div
          ref={tipRef}
          role="tooltip"
          className="pointer-events-none fixed z-[60] flex items-center gap-1.5 whitespace-nowrap rounded-md border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright shadow-xl"
          style={
            {
              top: pos?.top ?? anchor.top,
              left: pos?.left ?? anchor.center,
              transform: `translateX(${pos ? 0 : '-50%'}) translateY(${
                placement === 'top' ? '-100%' : '0'
              })`,
              visibility: pos ? 'visible' : 'hidden',
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        >
          <span>{label}</span>
          {keys && (
            <kbd className="rounded border border-od-border bg-od-bg-hover px-1 py-px font-mono text-xs leading-tight text-od-text">
              {keys}
            </kbd>
          )}
        </div>
      )}
    </span>
  );
}
