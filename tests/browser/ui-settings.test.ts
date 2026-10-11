import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/theme/applyTheme', () => ({ applyTheme: vi.fn() }));

import {
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  normalizeUiSettings,
  usePiStore
} from '../../src/store/pi-store';

describe('browser UI settings migration', () => {
  it('migrates the old codePanelWidth when rightPanelWidth is absent', () => {
    expect(normalizeUiSettings({ codePanelWidth: 640 }).rightPanelWidth).toBe(640);
    expect(normalizeUiSettings({ codePanelWidth: 100 }).rightPanelWidth).toBe(
      RIGHT_PANEL_WIDTH_MIN
    );
    expect(normalizeUiSettings({ codePanelWidth: 5000 }).rightPanelWidth).toBe(
      RIGHT_PANEL_WIDTH_MAX
    );
  });

  it('prefers the new width and restores the browser switch', () => {
    expect(
      normalizeUiSettings({
        codePanelWidth: 500,
        rightPanelWidth: 720,
        browserEnabled: true
      })
    ).toMatchObject({ rightPanelWidth: 720, browserEnabled: true });
  });

  it('maximizes the workspace and exits maximized mode when the panel closes', () => {
    usePiStore.getState().setRightPanelMaximized(true);
    expect(usePiStore.getState()).toMatchObject({
      rightPanelOpen: true,
      rightPanelMaximized: true
    });

    usePiStore.getState().setRightPanelOpen(false);
    expect(usePiStore.getState()).toMatchObject({
      rightPanelOpen: false,
      rightPanelMaximized: false
    });
  });
});

describe('编辑器（Monaco）设置迁移', () => {
  it('保留开关字段与主题枚举', () => {
    expect(
      normalizeUiSettings({
        monacoLigatures: false,
        monacoWordWrap: false,
        monacoMinimap: true,
        monacoLineNumbers: false,
        monacoStickyScroll: true,
        monacoIndentGuides: false,
        monacoTheme: 'hc-black'
      })
    ).toEqual({
      monacoLigatures: false,
      monacoWordWrap: false,
      monacoMinimap: true,
      monacoLineNumbers: false,
      monacoStickyScroll: true,
      monacoIndentGuides: false,
      monacoTheme: 'hc-black'
    });
  });

  it('丢弃非法主题名与非布尔开关值（否则会覆盖默认值）', () => {
    expect(normalizeUiSettings({ monacoTheme: 'solarized' })).not.toHaveProperty('monacoTheme');
    expect(normalizeUiSettings({ monacoMinimap: 'yes' })).not.toHaveProperty('monacoMinimap');
  });

  it('clamp 数值区间并保留字符串字体族', () => {
    expect(
      normalizeUiSettings({ monacoFontSize: 999, monacoTabSize: 0, monacoLineHeight: -5 })
    ).toEqual({ monacoFontSize: 48, monacoTabSize: 1, monacoLineHeight: 0 });
    expect(normalizeUiSettings({ monacoFontFamily: 'Fira Code' })).toEqual({
      monacoFontFamily: 'Fira Code'
    });
  });

  it('行高只接受「0 = 自动」或 >= 1 的倍数（0~1 之间会行重叠，收敛到 1）', () => {
    expect(normalizeUiSettings({ monacoLineHeight: 0.5 })).toEqual({ monacoLineHeight: 1 });
    expect(normalizeUiSettings({ monacoLineHeight: 1.5 })).toEqual({ monacoLineHeight: 1.5 });
    expect(normalizeUiSettings({ monacoLineHeight: 99 })).toEqual({ monacoLineHeight: 3 });
  });

  it('setter 写盘的是 clamp 后的值', async () => {
    const setUiSettings = vi.fn().mockResolvedValue(undefined);
    const g = globalThis as unknown as { window?: unknown };
    const previous = g.window;
    g.window = { pi: { setUiSettings } };
    try {
      usePiStore.getState().setMonacoFontSize(999);
      expect(usePiStore.getState().monacoFontSize).toBe(48);
      expect(setUiSettings).toHaveBeenCalledWith({ monacoFontSize: 48 });

      usePiStore.getState().setMonacoTheme('hc-light');
      expect(setUiSettings).toHaveBeenCalledWith({ monacoTheme: 'hc-light' });

      // 非法主题不入库、不改状态
      usePiStore.getState().setMonacoTheme('nope' as never);
      expect(setUiSettings).toHaveBeenCalledTimes(2);
      expect(usePiStore.getState().monacoTheme).toBe('hc-light');

      // 复位（要在 stub 还活着时做，否则 saveSetting 会摸不到 window）
      usePiStore.getState().setMonacoTheme('auto');
    } finally {
      if (previous === undefined) delete g.window;
      else g.window = previous;
    }
  });
});
