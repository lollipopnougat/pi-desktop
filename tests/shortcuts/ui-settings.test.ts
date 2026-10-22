import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/theme/applyTheme', () => ({ applyTheme: vi.fn() }));

import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS } from '../../src/lib/shortcuts';
import { normalizeUiSettings, usePiStore } from '../../src/store/pi-store';
import { t } from '../../src/i18n/zh';

afterEach(() => {
  vi.unstubAllGlobals();
  usePiStore.getState().resetAllShortcuts();
  usePiStore.getState().setShortcutNumberKeys('workspace');
});

describe('快捷键持久化（ui-config.json）', () => {
  it('从磁盘恢复绑定，缺失/非法值回退默认', () => {
    const patch = normalizeUiSettings({
      shortcuts: { 'session.new': 'Mod+Shift+U', 'session.search': '', 'view.todo': 'nope' }
    });
    expect(patch.shortcuts).toMatchObject({
      'session.new': 'Mod+Shift+U',
      'session.search': '',
      'view.todo': DEFAULT_SHORTCUTS['view.todo']
    });
    // 补全：已知动作都会有一项
    expect(Object.keys(patch.shortcuts ?? {}).sort()).toEqual(
      SHORTCUT_ACTIONS.map((action) => action.id).sort()
    );
  });

  it('非对象值被忽略（保持 store 默认，不被重置成默认表）', () => {
    const patch = normalizeUiSettings({ shortcuts: 'bad' as unknown as Record<string, string> });
    expect(patch.shortcuts).toBeUndefined();
  });

  it('数字快捷键只接受 workspace / off', () => {
    expect(normalizeUiSettings({ shortcutNumberKeys: 'off' }).shortcutNumberKeys).toBe('off');
    expect(
      normalizeUiSettings({ shortcutNumberKeys: 'tabs' as unknown as 'off' }).shortcutNumberKeys
    ).toBeUndefined();
  });

  it('改绑后写入 store 并持久化整份绑定表', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setShortcut('session.new', 'Mod+Shift+U');

    expect(usePiStore.getState().shortcuts['session.new']).toBe('Mod+Shift+U');
    expect(setUiSettings).toHaveBeenCalledTimes(1);
    const payload = setUiSettings.mock.calls[0][0] as { shortcuts: Record<string, string> };
    expect(payload.shortcuts['session.new']).toBe('Mod+Shift+U');
    // 未改动的动作也随整份表写回（读的时候缺失字段会补默认，写回保证一致性）
    expect(payload.shortcuts['session.search']).toBe(DEFAULT_SHORTCUTS['session.search']);
  });

  it('未知动作 id 不写入', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setShortcut('not.an.action', 'Mod+9');

    expect(setUiSettings).not.toHaveBeenCalled();
    expect(usePiStore.getState().shortcuts).not.toHaveProperty('not.an.action');
  });

  it('单个动作恢复默认', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setShortcut('session.new', '');
    expect(usePiStore.getState().shortcuts['session.new']).toBe('');

    usePiStore.getState().resetShortcut('session.new');
    expect(usePiStore.getState().shortcuts['session.new']).toBe(DEFAULT_SHORTCUTS['session.new']);
  });

  it('全部重置恢复默认表', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setShortcut('view.sidebar', '');
    usePiStore.getState().resetAllShortcuts();

    expect(usePiStore.getState().shortcuts).toEqual({ ...DEFAULT_SHORTCUTS });
  });

  it('数字快捷键切换会持久化', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setShortcutNumberKeys('off');

    expect(setUiSettings).toHaveBeenCalledWith({ shortcutNumberKeys: 'off' });
    expect(usePiStore.getState().shortcutNumberKeys).toBe('off');
  });
});

describe('快捷键文案覆盖', () => {
  it('每个动作都有中文标签与说明', () => {
    for (const action of SHORTCUT_ACTIONS) {
      const text = t.shortcutActionText[action.id];
      expect(text, action.id).toBeTruthy();
      expect(text.label.length).toBeGreaterThan(0);
      expect(text.desc.length).toBeGreaterThan(0);
    }
  });
});
