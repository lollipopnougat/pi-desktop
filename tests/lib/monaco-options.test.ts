/**
 * 编辑器（Monaco）设置 → Monaco 选项/主题名（src/lib/monaco-options.ts）
 *
 * 覆盖：
 * - 默认偏好产出与 Monaco 原生默认/改造前硬编码一致的选项
 * - 空字体族不写 fontFamily（保留 Monaco 跨平台内置默认）
 * - Tab 宽度是作者性设置（tabSize + insertSpaces + 关 detectIndentation）
 * - 各开关映射（wordWrap / lineNumbers / minimap / stickyScroll / guides）
 * - 主题解析：auto 跟随明暗、显式选择恒定生效
 */
import { describe, expect, it } from 'vitest';
import {
  buildMonacoOptions,
  resolveMonacoTheme,
  type MonacoEditorPrefs
} from '../../src/lib/monaco-options';
import {
  MONACO_FONT_FAMILY_DEFAULT,
  MONACO_FONT_SIZE_DEFAULT,
  MONACO_LINE_HEIGHT_DEFAULT,
  MONACO_TAB_SIZE_DEFAULT
} from '../../src/store/pi-store';

const basePrefs: MonacoEditorPrefs = {
  monacoFontFamily: MONACO_FONT_FAMILY_DEFAULT,
  monacoFontSize: MONACO_FONT_SIZE_DEFAULT,
  monacoLineHeight: MONACO_LINE_HEIGHT_DEFAULT,
  monacoTabSize: MONACO_TAB_SIZE_DEFAULT,
  monacoLigatures: true,
  monacoWordWrap: true,
  monacoMinimap: false,
  monacoLineNumbers: true,
  monacoStickyScroll: false,
  monacoIndentGuides: true
};

describe('buildMonacoOptions', () => {
  it('默认偏好映射为预期的 Monaco 选项', () => {
    const options = buildMonacoOptions(basePrefs);
    expect(options).toMatchObject({
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 0,
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
      fontLigatures: true,
      wordWrap: 'on',
      minimap: { enabled: false },
      lineNumbers: 'on',
      stickyScroll: { enabled: false },
      guides: { indentation: true }
    });
  });

  it('字体族为空时不写 fontFamily，交给 Monaco 内置默认', () => {
    expect('fontFamily' in buildMonacoOptions(basePrefs)).toBe(false);
    expect('fontFamily' in buildMonacoOptions({ ...basePrefs, monacoFontFamily: '   ' })).toBe(
      false
    );
  });

  it('字体族去掉首尾空白后写入', () => {
    expect(
      buildMonacoOptions({ ...basePrefs, monacoFontFamily: '  Fira Code, monospace  ' }).fontFamily
    ).toBe('Fira Code, monospace');
  });

  it('每个开关都能翻转对应选项', () => {
    const options = buildMonacoOptions({
      ...basePrefs,
      monacoWordWrap: false,
      monacoLineNumbers: false,
      monacoMinimap: true,
      monacoStickyScroll: true,
      monacoIndentGuides: false,
      monacoLigatures: false
    });
    expect(options).toMatchObject({
      wordWrap: 'off',
      lineNumbers: 'off',
      minimap: { enabled: true },
      stickyScroll: { enabled: true },
      guides: { indentation: false },
      fontLigatures: false
    });
  });

  it('字号/行高/Tab 宽度按用户值下发（行高支持小数倍数）', () => {
    const options = buildMonacoOptions({
      ...basePrefs,
      monacoFontSize: 16,
      monacoLineHeight: 1.5,
      monacoTabSize: 2
    });
    expect(options).toMatchObject({ fontSize: 16, lineHeight: 1.5, tabSize: 2 });
  });
});

describe('resolveMonacoTheme', () => {
  it('auto 跟随应用明暗', () => {
    expect(resolveMonacoTheme('auto', 'dark', false)).toBe('vs-dark');
    expect(resolveMonacoTheme('auto', 'light', true)).toBe('vs');
  });

  it('auto + system 模式看系统明暗', () => {
    expect(resolveMonacoTheme('auto', 'system', true)).toBe('vs-dark');
    expect(resolveMonacoTheme('auto', 'system', false)).toBe('vs');
  });

  it('显式选择的主题恒定生效，不被明暗覆盖', () => {
    expect(resolveMonacoTheme('hc-black', 'light', false)).toBe('hc-black');
    expect(resolveMonacoTheme('hc-light', 'dark', true)).toBe('hc-light');
    expect(resolveMonacoTheme('vs-dark', 'light', false)).toBe('vs-dark');
    expect(resolveMonacoTheme('vs', 'dark', true)).toBe('vs');
  });
});
