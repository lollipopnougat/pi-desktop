/**
 * 原生视图（内置浏览器 `WebContentsView`）与 App 浮层的遮挡判定。
 *
 * 原生视图永远画在 HTML 之上，所以 App 的弹层要能看见，只能把视图收起来；
 * 但只有**真正和视图矩形相交**的浮层才需要收，否则左侧栏的小下拉也会把右侧
 * 浏览器整块弄成空白。判定本身是纯几何，抽出来便于单测。
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 小于这个尺寸的浮层视为不可见的动画残影（scale-0 / 收拢动画结束态） */
export const MIN_OVERLAY_SIZE = 8;

export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/** 是否有任意浮层与视口相交（调用方负责先过滤不可见/不绘制内容的浮层） */
export function anyOverlayCovers(viewport: RectLike, overlays: RectLike[]): boolean {
  return overlays.some(
    (overlay) =>
      overlay.width >= MIN_OVERLAY_SIZE &&
      overlay.height >= MIN_OVERLAY_SIZE &&
      rectsIntersect(viewport, overlay)
  );
}

/**
 * 背景色是否完全透明（Chromium 对未设置背景的元素返回 `rgba(0, 0, 0, 0)`）。
 * 用于区分「真的画出内容的浮层」和「透明点击捕获层」。
 */
export function isTransparentColor(color: string | undefined): boolean {
  if (!color || color === 'transparent') return true;
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return false;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 4) return false;
  return Number.parseFloat(parts[3]) === 0;
}
