import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/theme/applyTheme', () => ({ applyTheme: vi.fn() }));

import { normalizeUiSettings, usePiStore } from '../../src/store/pi-store';

/**
 * 毛玻璃半透明开关（标题栏 / 侧栏 / 状态栏）。
 *
 * 漏掉 normalizeUiSettings 的布尔分支会静默丢弃磁盘值、每次启动回退默认值，
 * 所以这里同时校验「归一化」与「往返」两侧。
 */
describe('毛玻璃半透明（translucentPanels）设置', () => {
  it('默认开启（沿用改动前的毛玻璃外观）', () => {
    expect(usePiStore.getState().translucentPanels).toBe(true);
  });

  it('归一化保留布尔值，非法值忽略', () => {
    expect(normalizeUiSettings({ translucentPanels: false })).toEqual({
      translucentPanels: false
    });
    expect(normalizeUiSettings({ translucentPanels: true })).toEqual({ translucentPanels: true });
    // 字符串 / 数字不是合法布尔：不能写进 patch（否则 store 会拿到脏值）
    expect(normalizeUiSettings({ translucentPanels: 'false' as unknown as boolean })).toEqual({});
    expect(normalizeUiSettings({ translucentPanels: 0 as unknown as boolean })).toEqual({});
  });

  it('setter 更新 store 状态', () => {
    usePiStore.getState().setTranslucentPanels(false);
    expect(usePiStore.getState().translucentPanels).toBe(false);
    usePiStore.getState().setTranslucentPanels(true);
    expect(usePiStore.getState().translucentPanels).toBe(true);
  });

  it('磁盘值经归一化后能回写到 store（往返）', () => {
    const patch = normalizeUiSettings({ translucentPanels: false });
    usePiStore.setState(patch);
    expect(usePiStore.getState().translucentPanels).toBe(false);
    usePiStore.getState().setTranslucentPanels(true);
  });
});
