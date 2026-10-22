import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_SEARCH_ENTRIES,
  SETTINGS_TABS,
  SETTINGS_TAB_BY_KEY,
  flattenSettingsResults,
  searchSettings
} from '../../src/components/settings/settings-nav';

describe('设置页分组导航', () => {
  it('每个 tab 恰好出现一次', () => {
    const keys = SETTINGS_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(12);
  });

  it('分组非空，且 tab 全部能在索引里查回', () => {
    expect(SETTINGS_GROUPS.length).toBeGreaterThan(1);
    for (const group of SETTINGS_GROUPS) {
      expect(group.label.trim().length).toBeGreaterThan(0);
      expect(group.tabs.length).toBeGreaterThan(0);
      for (const tab of group.tabs) {
        expect(tab.label.trim().length).toBeGreaterThan(0);
        expect(SETTINGS_TAB_BY_KEY.get(tab.key)).toBe(tab);
      }
    }
  });

  it('分组内没有重复 tab', () => {
    const keys = SETTINGS_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('设置搜索目录', () => {
  it('条目字段合法', () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      expect(SETTINGS_TAB_BY_KEY.has(entry.tab)).toBe(true);
      expect(entry.title.trim().length).toBeGreaterThan(0);
      if (entry.section !== undefined) expect(entry.section.trim().length).toBeGreaterThan(0);
      for (const keyword of entry.keywords ?? []) expect(keyword.trim().length).toBeGreaterThan(0);
    }
  });

  it('没有同一 tab 内完全重复的条目，且条目名不与 tab 名重名', () => {
    const seen = new Set<string>();
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      const key = `${entry.tab}:${entry.title}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      // 搜索结果的分组头展示的就是 tab 名，条目再同名会出现两行一样的文字
      expect(entry.title).not.toBe(SETTINGS_TAB_BY_KEY.get(entry.tab)?.label);
    }
  });
});

describe('searchSettings', () => {
  it('空查询返回空结果（无查询时由 UI 显示分组导航）', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('按别名命中，并能带出所在分区', () => {
    const results = searchSettings('字体');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tab.key).toBe('appearance');
    const titles = results.flatMap((result) => result.entries.map((entry) => entry.title));
    expect(titles).toContain('终端');
  });

  it('大小写与空格不敏感（英文查询）', () => {
    const lower = searchSettings('api key');
    const upper = searchSettings('APIKEY');
    expect(lower.length).toBeGreaterThan(0);
    expect(upper.map((r) => r.tab.key)).toEqual(lower.map((r) => r.tab.key));
    expect(lower.some((r) => r.tab.key === 'models')).toBe(true);
  });

  it('匹配 tab 名称时标记 tabHit', () => {
    const results = searchSettings('记忆');
    const memory = results.find((result) => result.tab.key === 'memory');
    expect(memory?.tabHit).toBe(true);
    expect(memory?.entries.length).toBeGreaterThan(0);
  });

  it('每个 tab 都能用自己的名称搜索到', () => {
    for (const tab of SETTINGS_TABS) {
      const results = searchSettings(tab.label);
      expect(results.some((result) => result.tab.key === tab.key)).toBe(true);
    }
  });

  it('无匹配时返回空数组', () => {
    expect(searchSettings('这个设置不存在zzz')).toEqual([]);
  });

  it('结果按导航顺序排列', () => {
    const order = new Map(SETTINGS_TABS.map((tab, index) => [tab.key, index]));
    const indexes = searchSettings('模型').map((result) => order.get(result.tab.key) ?? -1);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

describe('flattenSettingsResults', () => {
  it('摊平后 tab 级命中排在该 tab 的分区命中之前', () => {
    const rows = flattenSettingsResults(searchSettings('记忆'));
    const memoryRows = rows.filter((row) => row.tab.key === 'memory');
    expect(memoryRows[0].tabLevel).toBe(true);
    expect(memoryRows.slice(1).every((row) => !row.tabLevel)).toBe(true);
  });

  it('行标题非空，且与 tab 顺序一致', () => {
    const rows = flattenSettingsResults(searchSettings('模型'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.title.trim().length).toBeGreaterThan(0);

    const order = new Map(SETTINGS_TABS.map((tab, index) => [tab.key, index]));
    const indexes = rows.map((row) => order.get(row.tab.key) ?? -1);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
