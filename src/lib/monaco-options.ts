import type { editor } from 'monaco-editor';
import type { MonacoThemeChoice } from '../store/pi-store';
import type { ColorMode } from '../theme/themes';

/**
 * 编辑器（Monaco）UI 偏好 → Monaco 构造选项 / 主题名。
 *
 * 全部为纯函数，便于测试；设置页、代码面板、diff 视图、JSON 编辑器共用同一份设置，
 * 保证「设置页改什么，所有 Monaco 实例就变成什么」。
 *
 * 设计约束：
 * - 空字体族 = 不写 fontFamily，交给 Monaco 的内置默认（Linux 上是
 *   'Droid Sans Mono', 'monospace'，macOS/Windows 回退到系统等宽字体），
 *   这样不必猜用户装了哪套字体。
 * - Tab 宽度是「作者性设置」：同时写 tabSize + insertSpaces，并关掉 detectIndentation，
 *   否则 Monaco 会按文件内容覆盖用户显式设置的值（表现为「设置了没生效」）。
 * - lineHeight 沿用 Monaco 语义：0 = 按字号自动，1~8 视为字号倍数，>=8 为像素值。
 */

/** 与编辑器相关的 UI 偏好（store 中 monaco* 字段的投影，不含主题——主题走 theme prop） */
export interface MonacoEditorPrefs {
  monacoFontFamily: string;
  monacoFontSize: number;
  monacoLineHeight: number;
  monacoTabSize: number;
  monacoLigatures: boolean;
  monacoWordWrap: boolean;
  monacoMinimap: boolean;
  monacoLineNumbers: boolean;
  monacoStickyScroll: boolean;
  monacoIndentGuides: boolean;
}

/** 设置 → Monaco 构造选项。调用方可用展开顺序覆盖单项（如 readOnly）。 */
export function buildMonacoOptions(
  prefs: MonacoEditorPrefs
): editor.IStandaloneEditorConstructionOptions {
  const options: editor.IStandaloneEditorConstructionOptions = {
    // 容器尺寸变化时自动布局（设置页预览块、可拖拽面板都需要）
    automaticLayout: true,
    fontSize: prefs.monacoFontSize,
    lineHeight: prefs.monacoLineHeight,
    tabSize: prefs.monacoTabSize,
    insertSpaces: true,
    detectIndentation: false,
    fontLigatures: prefs.monacoLigatures,
    wordWrap: prefs.monacoWordWrap ? 'on' : 'off',
    minimap: { enabled: prefs.monacoMinimap },
    lineNumbers: prefs.monacoLineNumbers ? 'on' : 'off',
    stickyScroll: { enabled: prefs.monacoStickyScroll },
    guides: { indentation: prefs.monacoIndentGuides }
  };
  const family = prefs.monacoFontFamily.trim();
  if (family) options.fontFamily = family;
  return options;
}

/**
 * 编辑器主题名。
 * - 'auto'：跟随应用明暗（深色 vs-dark / 浅色 vs）
 * - 其余：锁定对应内置主题（hc-black / hc-light 为高对比度）
 */
export function resolveMonacoTheme(
  choice: MonacoThemeChoice,
  mode: ColorMode,
  systemIsDark: boolean
): string {
  if (choice !== 'auto') return choice;
  const variant = mode === 'system' ? (systemIsDark ? 'dark' : 'light') : mode;
  return variant === 'dark' ? 'vs-dark' : 'vs';
}
