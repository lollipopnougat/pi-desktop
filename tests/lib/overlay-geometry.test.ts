import { describe, expect, it } from 'vitest';
import {
  MIN_OVERLAY_SIZE,
  anyOverlayCovers,
  isTransparentColor,
  rectsIntersect,
  type RectLike
} from '../../src/lib/overlay-geometry';

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  width,
  height
});

// 浏览器面板：右下角 600×700
const viewport = rect(700, 100, 600, 700);

describe('rectsIntersect', () => {
  it('完全包含 / 部分重叠都算相交', () => {
    expect(rectsIntersect(viewport, rect(800, 200, 100, 100))).toBe(true);
    expect(rectsIntersect(viewport, rect(1200, 700, 400, 400))).toBe(true);
    expect(rectsIntersect(viewport, rect(0, 0, 1400, 900))).toBe(true);
  });

  it('完全在左/上/右/下侧不算相交', () => {
    expect(rectsIntersect(viewport, rect(0, 0, 200, 200))).toBe(false);
    expect(rectsIntersect(viewport, rect(700, 0, 600, 100))).toBe(false);
    expect(rectsIntersect(viewport, rect(1300, 100, 100, 700))).toBe(false);
    expect(rectsIntersect(viewport, rect(700, 800, 600, 100))).toBe(false);
  });

  it('仅贴边（共线）不算相交', () => {
    expect(rectsIntersect(viewport, rect(100, 100, 600, 700))).toBe(false);
    expect(rectsIntersect(viewport, rect(700, 0, 600, 100))).toBe(false);
  });
});

describe('anyOverlayCovers', () => {
  it('没有任何浮层时不遮挡', () => {
    expect(anyOverlayCovers(viewport, [])).toBe(false);
  });

  it('左侧栏的浮层不会遮挡右侧面板', () => {
    expect(anyOverlayCovers(viewport, [rect(20, 60, 320, 400), rect(100, 300, 240, 40)])).toBe(
      false
    );
  });

  it('模态弹窗（全屏遮罩）会遮挡', () => {
    expect(anyOverlayCovers(viewport, [rect(0, 0, 1400, 900)])).toBe(true);
  });

  it('压住面板一角的浮层也算遮挡', () => {
    expect(anyOverlayCovers(viewport, [rect(1100, 700, 200, 200)])).toBe(true);
  });

  it('小于 MIN_OVERLAY_SIZE 的残影忽略', () => {
    const tiny = rect(800, 200, MIN_OVERLAY_SIZE - 1, MIN_OVERLAY_SIZE - 1);
    expect(anyOverlayCovers(viewport, [tiny])).toBe(false);
  });
});

describe('isTransparentColor', () => {
  it('Chromium 的透明默认值', () => {
    expect(isTransparentColor('rgba(0, 0, 0, 0)')).toBe(true);
    expect(isTransparentColor('transparent')).toBe(true);
    expect(isTransparentColor(undefined)).toBe(true);
  });

  it('半透明/不透明都不算透明', () => {
    expect(isTransparentColor('rgba(0, 0, 0, 0.6)')).toBe(false);
    expect(isTransparentColor('rgb(33, 36, 43)')).toBe(false);
    expect(isTransparentColor('rgb(0 0 0 / 0.5)')).toBe(false);
  });
});
