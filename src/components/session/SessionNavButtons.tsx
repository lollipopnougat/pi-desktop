/**
 * 标题栏左上角的会话前进/后退按钮（对齐 Codex 的位置：macOS 红绿灯之后、侧栏开关之前）。
 *
 * 交互：
 * - 单击 = 后退 / 前进一步（会话导航历史，见 src/lib/session-nav.ts）
 * - **长按后退键 380ms**（或右键）= 弹出最近会话列表，可直接跳到历史里的任意一条
 * - 走到历史两端时置灰但保留占位，避免侧栏图标左右跳动
 *
 * 两个实现细节：
 * 1. 菜单用 `fixed` + 按钮的 `getBoundingClientRect()` 定位，不用 `absolute`——标题栏是
 *    flex 行、外层还有滚动/裁切上下文，absolute 弹出的面板会被裁掉或盖在聊天区后面。
 * 2. 长按后紧接着的 click 必须吞掉（`suppressClick`），否则「长按看历史」会顺手后退一步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import {
  canGoBack,
  canGoForward,
  jumpToSessionNav,
  navigateSessionHistory
} from '../../lib/session-nav';
import { t } from '../../i18n/zh';
import Icon from '../common/Icon';
import Tooltip from '../common/Tooltip';

/** 长按判定阈值：短于它按普通点击处理 */
const LONG_PRESS_MS = 380;

interface MenuAnchor {
  top: number;
  left: number;
}

export default function SessionNavButtons() {
  const sessionNav = usePiStore((s) => s.sessionNav);
  const sessionNavIndex = usePiStore((s) => s.sessionNavIndex);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 长按已经打开菜单 → 吞掉随后那次 click */
  const suppressClick = useRef(false);

  const back = canGoBack(sessionNavIndex);
  const forward = canGoForward(sessionNavIndex, sessionNav.length);
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const openMenu = useCallback(() => {
    const rect = backRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.bottom + 6, left: rect.left });
  }, []);

  const startPress = () => {
    if (sessionNav.length <= 1) return; // 只有一条历史，没有可跳的
    clearTimer();
    suppressClick.current = false;
    timerRef.current = window.setTimeout(() => {
      suppressClick.current = true;
      openMenu();
    }, LONG_PRESS_MS);
  };

  const cancelPress = () => {
    clearTimer();
  };

  const handleBack = () => {
    if (suppressClick.current) {
      // 这次 click 是长按的尾巴（菜单已经打开），不要再后退
      suppressClick.current = false;
      return;
    }
    cancelPress();
    // 用 aria-disabled 而不是 disabled：原生 disabled 的按钮**不派发 pointer 事件**，
    // 走到历史最早一项后长按键就再也打不开「最近会话」列表了（那正是最想跳的时候）。
    if (!canGoBack(usePiStore.getState().sessionNavIndex)) return;
    void navigateSessionHistory(-1);
  };

  const handleJump = (index: number) => {
    setAnchor(null);
    if (index === sessionNavIndex) return;
    void jumpToSessionNav(index);
  };

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip label={t.navBack} shortcutId="session.back">
        <button
          ref={backRef}
          onClick={handleBack}
          onPointerDown={startPress}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(e) => {
            e.preventDefault();
            cancelPress();
            openMenu();
          }}
          aria-disabled={!back}
          className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
            back ? '' : 'titlebar-btn-off'
          }`}
          aria-label={t.navBack}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Icon name="chevronLeft" className="w-3" />
        </button>
      </Tooltip>
      <Tooltip label={t.navForward} shortcutId="session.forward">
        <button
          onClick={() => {
            // 同上：aria-disabled 保留 pointer 事件，点击时才判断能不能走
            if (
              !canGoForward(
                usePiStore.getState().sessionNavIndex,
                usePiStore.getState().sessionNav.length
              )
            )
              return;
            void navigateSessionHistory(1);
          }}
          aria-disabled={!forward}
          className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
            forward ? '' : 'titlebar-btn-off'
          }`}
          aria-label={t.navForward}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Icon name="chevronRight" className="w-3" />
        </button>
      </Tooltip>

      {anchor && (
        <>
          {/* 点击空白 / Esc 关闭：铺一层透明遮罩，避免动到聊天区的交互 */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setAnchor(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setAnchor(null);
            }}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          />
          <div
            className="fixed z-50 w-72 overflow-hidden rounded-lg border border-od-border-light bg-od-bg-alt py-1 shadow-xl"
            style={
              {
                top: anchor.top,
                left: anchor.left,
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
            role="menu"
            aria-label={t.navHistoryLabel}
          >
            <div className="px-3 py-1 text-xs text-od-text-dim">{t.navHistoryLabel}</div>
            <div className="max-h-72 overflow-y-auto">
              {[...sessionNav].reverse().map((entry, reversedIndex) => {
                const index = sessionNav.length - 1 - reversedIndex;
                const active = index === sessionNavIndex;
                return (
                  <button
                    key={`${entry.target}-${index}`}
                    onClick={() => handleJump(index)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-od-bg-hover ${
                      active ? 'text-od-accent' : 'text-od-text-bright'
                    }`}
                    role="menuitem"
                  >
                    <Icon
                      name={active ? 'chevronRight' : 'clock'}
                      className={`w-3 shrink-0 ${active ? 'text-od-accent' : 'text-od-text-dim'}`}
                    />
                    <span className="truncate">{entry.label || t.sessionUnnamed}</span>
                    {active && (
                      <span className="ml-auto shrink-0 text-xs text-od-accent">
                        {t.navHistoryCurrent}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
