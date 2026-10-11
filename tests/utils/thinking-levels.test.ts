import { describe, it, expect } from 'vitest';
import {
  THINKING_LEVELS,
  getSelectedThinkingLevels,
  buildThinkingLevelMap
} from '../../src/types/shared';

// ─── getSelectedThinkingLevels ───

describe('shared — getSelectedThinkingLevels', () => {
  it('无 thinkingLevelMap 时返回除 xhigh/max 外的全部等级（SDK 默认语义）', () => {
    const selected = getSelectedThinkingLevels({});
    expect([...selected].sort()).toEqual(['high', 'low', 'medium', 'off']);
  });

  it('map[level] === null 的等级被排除', () => {
    const selected = getSelectedThinkingLevels({
      thinkingLevelMap: { off: 'off', low: null, medium: null, high: 'high' }
    });
    expect([...selected]).toEqual(['off', 'high']);
  });

  it('xhigh/max 需显式映射才可选', () => {
    const selected = getSelectedThinkingLevels({
      thinkingLevelMap: { off: 'off', high: 'high', xhigh: undefined, max: 'max' }
    });
    expect([...selected]).toEqual(['off', 'high', 'max']);
  });

  it('全 null 的 map（理论不应出现）解析为空集', () => {
    const map = Object.fromEntries(THINKING_LEVELS.map((l) => [l, null]));
    const selected = getSelectedThinkingLevels({ thinkingLevelMap: map });
    expect(selected.size).toBe(0);
  });
});

// ─── buildThinkingLevelMap ───

describe('shared — buildThinkingLevelMap', () => {
  it('勾选的等级映射为自身，未勾选为 null', () => {
    const map = buildThinkingLevelMap(new Set(['off', 'high']));
    expect(map.off).toBe('off');
    expect(map.high).toBe('high');
    expect(map.low).toBeNull();
    expect(map.medium).toBeNull();
    expect(map.xhigh).toBeNull();
    expect(map.max).toBeNull();
  });

  it('与 getSelectedThinkingLevels 互逆（往返一致）', () => {
    const selected = new Set(['off', 'medium', 'high', 'max']);
    const map = buildThinkingLevelMap(selected);
    expect(getSelectedThinkingLevels({ thinkingLevelMap: map })).toEqual(selected);
  });

  it('构造的 map 被 SDK getSupportedThinkingLevels 语义接受：全等级勾选时 xhigh/max 可选', () => {
    const map = buildThinkingLevelMap(new Set(THINKING_LEVELS));
    // SDK 语义：xhigh/max 仅在 map[level] 非 null/undefined 时可选
    expect(map.xhigh).toBe('xhigh');
    expect(map.max).toBe('max');
  });
});
