import { useEffect, useRef, useState } from 'react';
import type { BrowserTabState } from '../../types/pi';
import { anyOverlayCovers, isTransparentColor, type RectLike } from '../../lib/overlay-geometry';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

interface BrowserContentProps {
  tab: BrowserTabState;
  browserId: string;
  obscured: boolean;
}

/**
 * 这个浮层在屏幕上到底画东西了吗？
 * 很多浮动层是「透明点击捕获层」（下拉遮罩、`fixed inset-0 z-10` 的小透明壳）：
 * 它们和面板相交，但自己不画任何东西，为了它们把浏览器收起来只会让面板无故变空。
 */
function paintsSomething(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node);
  if (!isTransparentColor(style.backgroundColor)) return true;
  if (style.backgroundImage !== 'none') return true;
  if (style.boxShadow !== 'none') return true;
  if (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderLeftWidth) > 0) return true;
  if ((node.textContent || '').trim().length > 0) return true;
  // 透明外壳：看它下面有没有真正画出色块/边框的子元素（用例：遮罩 + 居中面板）
  const children = node.querySelectorAll<HTMLElement>('*');
  for (let i = 0; i < children.length && i < 40; i += 1) {
    const childStyle = window.getComputedStyle(children[i]);
    const painted =
      !isTransparentColor(childStyle.backgroundColor) ||
      childStyle.backgroundImage !== 'none' ||
      childStyle.boxShadow !== 'none';
    if (!painted) continue;
    const rect = children[i].getBoundingClientRect();
    if (rect.width >= 8 && rect.height >= 8) return true;
  }
  return false;
}

/**
 * 收集当前会挡住内容的 `fixed` 浮层矩形。
 *
 * 过滤规则：
 * - `display:none` / `visibility:hidden` → 不可见；
 * - `pointer-events:none` 的空壳（`ToastHost` 外壳、拖拽区）→ 本身不画内容；
 * - 透明外壳（下拉遮罩的 `fixed inset-0 z-10`）→ 看它下面有没有真正画东西的子元素，
 *   没有就不算遮挡（否则开个下拉就把浏览器整块弄空）。
 */
function collectOverlayRects(): RectLike[] {
  const rects: RectLike[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('.fixed')) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.pointerEvents === 'none') continue;
    if (!paintsSomething(node)) continue;
    rects.push(node.getBoundingClientRect());
  }
  return rects;
}

/**
 * 面板矩形是否被 App 自己的浮层盖住。
 *
 * 内置浏览器是原生 `WebContentsView`，永远画在所有 HTML 之上——连模态弹窗也是。
 * 所以只要浮层与面板矩形有重叠，就必须把原生视图收起来，否则弹窗会被浏览器挡住。
 * 关键是**只看几何重叠**：以前是「DOM 里存在任何 `.fixed` 元素就收起」，左侧栏
 * 的小下拉 / 提示气泡 / toast 都会把右侧浏览器整块弄空。
 */
function isPanelCovered(viewport: DOMRect): boolean {
  return anyOverlayCovers(viewport, collectOverlayRects());
}

export default function BrowserContent({ tab, browserId, obscured }: BrowserContentProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  /** 原生视图被 App 浮层盖住时的静态底图（截图），避免面板变成一片空白 */
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const frozenRef = useRef<string | null>(null);
  const address = addressDraft ?? tab.url;

  // 空态（没网址）和右栏收起时不显示原生视图
  const shouldShow = !obscured && !!tab.url;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const hideView = () => {
      window.pi.browser.setVisible(false).catch(() => {});
    };
    const clearFrozen = () => {
      if (!frozenRef.current) return;
      frozenRef.current = null;
      setFrozenFrame(null);
    };
    let frame = 0;
    // 量面板矩形 + 判断是否被浮层遮挡 + 下发给主进程（合帧，避免 MutationObserver 洪泛）
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
          hideView();
          return;
        }
        window.pi.browser
          .setViewport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .catch(() => {});
        if (!shouldShow || !isPanelCovered(rect)) {
          clearFrozen();
          window.pi.browser.setVisible(shouldShow).catch(() => {});
          return;
        }
        // 被浮层压住：原生视图不能与 HTML 叠层，只能收起来；
        // 收之前先拍一张静态底图垫在面板里，弹窗看起来就不像「把网页弄没了」。
        if (frozenRef.current) {
          hideView();
          return;
        }
        window.pi.browser
          .capture()
          .then((dataUrl) => {
            if (!dataUrl) return;
            frozenRef.current = dataUrl;
            setFrozenFrame(dataUrl);
          })
          .catch(() => {})
          .finally(hideView);
      });
    };
    apply();
    const resizeObserver = new ResizeObserver(apply);
    resizeObserver.observe(element);
    // 浮层挂载/卸载 / 动画 / z-index 变化都可能改变遮挡关系
    const mutationObserver = new MutationObserver(apply);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    window.addEventListener('resize', apply);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [browserId, shouldShow]);

  // 只在真正卸载时收起视图。以前收在 visible effect 的 cleanup 里，
  // 每次换网址 / 浮层开关都会先收再显，画面会闪一下空。
  useEffect(() => {
    return () => {
      window.pi.browser.setVisible(false).catch(() => {});
    };
  }, [browserId]);

  const navigate = async () => {
    const next = address.trim();
    if (!next) return;
    await window.pi.browser.navigate(browserId, next);
    setAddressDraft(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-od-bg-dark">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-od-border bg-od-bg-alt px-2">
        <button
          type="button"
          onClick={() => window.pi.browser.back(browserId)}
          disabled={!tab.canGoBack}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserBack}
        >
          <Icon name="back" className="w-3" />
        </button>
        <button
          type="button"
          onClick={() => window.pi.browser.forward(browserId)}
          disabled={!tab.canGoForward}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserForward}
        >
          <Icon name="forward" className="w-3" />
        </button>
        <button
          type="button"
          onClick={() =>
            tab.loading ? window.pi.browser.stop(browserId) : window.pi.browser.reload(browserId)
          }
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
          title={tab.loading ? t.browserStop : t.browserReload}
        >
          <Icon name={tab.loading ? 'stop' : 'refresh'} className="w-3" />
        </button>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <input
            value={address}
            onChange={(event) => setAddressDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder={t.browserAddressPlaceholder}
            className="h-7 w-full rounded border border-od-border-light bg-od-bg-dark px-2 text-xs text-od-text-bright"
          />
        </form>
        <button
          type="button"
          disabled={!tab.url}
          onClick={() => tab.url && window.pi.openExternal(tab.url)}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserOpenExternal}
        >
          <Icon name="external" className="w-3" />
        </button>
      </div>

      <div ref={viewportRef} className="relative flex-1 min-h-0 overflow-hidden bg-od-bg">
        {frozenFrame && (
          <img
            src={frozenFrame}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-90"
          />
        )}
        {!tab.url && (
          <form
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate();
            }}
          >
            <Icon name="browser" className="w-7 text-od-text-dim" />
            <div className="text-sm text-od-text-bright">{t.browserEmptyTitle}</div>
            <input
              value={address}
              onChange={(event) => setAddressDraft(event.target.value)}
              placeholder={t.browserEmptyHint}
              autoFocus
              className="h-8 w-full max-w-md rounded border border-od-border-light bg-od-bg-alt px-3 text-xs text-od-text-bright"
            />
          </form>
        )}
      </div>
    </div>
  );
}
