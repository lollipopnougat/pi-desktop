/**
 * 编辑器扩展主题（monaco-themes）测试
 *
 * 覆盖：
 * - 生成表 src/lib/monaco-themes.generated.ts 与 node_modules 里的实际文件一致
 *   （文件数、label→文件名、base、id 唯一、不与内置主题名冲突）——monaco-themes 升级后
 *   跑这个用例即可发现需要重新生成（node scripts/generate-monaco-themes.mjs）
 * - 每个主题的动态 import 都能真的加载出合法的 Monaco 主题数据
 * - id 校验：扩展主题 id 生效、内置主题名不被误判、未知 id 安全返回
 * - 持久化：ui-config 里的扩展主题 id 会被保留，非法主题名被丢弃
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXTENDED_MONACO_THEMES,
  ensureExtendedThemeDefined,
  isExtendedMonacoThemeId,
  loadExtendedThemeData
} from '../../src/lib/monaco-themes';
import {
  MONACO_BUILTIN_THEME_CHOICES,
  isMonacoThemeChoice,
  normalizeUiSettings
} from '../../src/store/pi-store';

const THEMES_DIR = path.resolve(__dirname, '../../node_modules/monaco-themes/themes');

function themeFiles(): string[] {
  return fs
    .readdirSync(THEMES_DIR)
    .filter((file) => file.endsWith('.json') && file !== 'themelist.json');
}

describe('扩展主题表与 monaco-themes 包的一致性', () => {
  it('覆盖包里的全部主题文件（不多不少）', () => {
    const files = themeFiles();
    expect(EXTENDED_MONACO_THEMES).toHaveLength(files.length);
    const labels = EXTENDED_MONACO_THEMES.map((th) => th.label).sort();
    expect(labels).toEqual(files.map((file) => file.replace(/\.json$/, '')).sort());
  });

  it('每个主题的 base 与包里 JSON 的 base 一致', () => {
    for (const theme of EXTENDED_MONACO_THEMES) {
      const raw = fs.readFileSync(path.join(THEMES_DIR, `${theme.label}.json`), 'utf8');
      const data = JSON.parse(raw) as { base: string; inherit: boolean };
      expect(data.base, theme.label).toBe(theme.base);
      expect(data.inherit, theme.label).toBe(true);
    }
  });

  it('id 唯一且不与内置主题名冲突', () => {
    const ids = EXTENDED_MONACO_THEMES.map((th) => th.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const builtin of MONACO_BUILTIN_THEME_CHOICES) {
      expect(ids).not.toContain(builtin);
    }
  });

  it('每个 id 都是合法的 Monaco 主题名（defineTheme 会校验 /^[a-z0-9-]+$/）', () => {
    for (const theme of EXTENDED_MONACO_THEMES) {
      expect(theme.id, theme.label).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('扩展主题数据加载', () => {
  it('每个主题都能加载出合法的 Monaco 主题数据', async () => {
    for (const theme of EXTENDED_MONACO_THEMES) {
      const data = await loadExtendedThemeData(theme.id);
      expect(data, theme.id).not.toBeNull();
      expect(['vs', 'vs-dark', 'hc-black', 'hc-light'], theme.id).toContain(data?.base);
      expect(Array.isArray(data?.rules), theme.id).toBe(true);
      expect((data?.rules.length ?? 0) > 0, theme.id).toBe(true);
      expect(typeof data?.colors, theme.id).toBe('object');
    }
  });

  it('未知 id 返回 null，且不会去碰 Monaco 实例', async () => {
    expect(await loadExtendedThemeData('not-a-theme')).toBeNull();
    expect(await ensureExtendedThemeDefined('not-a-theme')).toBe(false);
  });
});

describe('主题 id 校验与持久化', () => {
  it('扩展主题 id 与内置主题名都算合法', () => {
    expect(isExtendedMonacoThemeId('dracula')).toBe(true);
    expect(isExtendedMonacoThemeId('monokai')).toBe(true);
    for (const builtin of MONACO_BUILTIN_THEME_CHOICES) {
      expect(isExtendedMonacoThemeId(builtin)).toBe(false);
      expect(isMonacoThemeChoice(builtin)).toBe(true);
    }
    expect(isMonacoThemeChoice('dracula')).toBe(true);
    expect(isMonacoThemeChoice('nope')).toBe(false);
  });

  it('ui-config 里的扩展主题 id 会被保留，非法主题名被丢弃', () => {
    expect(normalizeUiSettings({ monacoTheme: 'night-owl' })).toEqual({
      monacoTheme: 'night-owl'
    });
    expect(normalizeUiSettings({ monacoTheme: 'not-a-theme' })).not.toHaveProperty('monacoTheme');
  });
});
