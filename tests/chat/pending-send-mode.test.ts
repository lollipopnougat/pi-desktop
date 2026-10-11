import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/theme/applyTheme', () => ({ applyTheme: vi.fn() }));

import { normalizeUiSettings, usePiStore, type UiSettings } from '../../src/store/pi-store';

/**
 * 模型回复期间（streaming）发送消息的默认投递方式：
 * 持久化为 ui-config.json 的 streamingSendMode，取值 'steer'（引导消息）/ 'followUp'（排队消息）。
 */
describe('streamingSendMode（待发送消息默认方式）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认按引导消息发送，保持既有行为', () => {
    expect(usePiStore.getState().streamingSendMode).toBe('steer');
  });

  it('从磁盘值恢复合法取值', () => {
    expect(normalizeUiSettings({ streamingSendMode: 'followUp' }).streamingSendMode).toBe(
      'followUp'
    );
    expect(normalizeUiSettings({ streamingSendMode: 'steer' }).streamingSendMode).toBe('steer');
  });

  it('非法取值被丢弃（回退默认值）', () => {
    const invalid = { streamingSendMode: 'queue' } as unknown as UiSettings;
    expect(normalizeUiSettings(invalid).streamingSendMode).toBeUndefined();
  });

  it('设置时同步写入 ui-config.json 并更新 store', () => {
    const setUiSettings = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { pi: { setUiSettings } });

    usePiStore.getState().setStreamingSendMode('followUp');

    expect(setUiSettings).toHaveBeenCalledWith({ streamingSendMode: 'followUp' });
    expect(usePiStore.getState().streamingSendMode).toBe('followUp');

    // 复原，避免影响同文件其它用例
    usePiStore.getState().setStreamingSendMode('steer');
  });
});
