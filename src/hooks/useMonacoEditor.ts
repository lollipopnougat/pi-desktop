import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { editor } from 'monaco-editor';
import { usePiStore } from '../store/pi-store';
import { buildMonacoOptions, resolveMonacoTheme } from '../lib/monaco-options';
import {
  ensureExtendedThemeDefined,
  getExtendedThemeDefinitionsVersion,
  isExtendedMonacoThemeId,
  isExtendedThemeDefined,
  subscribeExtendedThemeDefinitions
} from '../lib/monaco-themes';
import { onSystemColorChange, systemPrefersDark } from '../theme/applyTheme';

/**
 * 读取「编辑器」设置，产出可直接传给 @monaco-editor/react 的 `theme` + `options`。
 *
 * 只跟随应用明暗切换内置主题（不派生主题族配色，见 src/theme/applyTheme.ts 的说明）。
 * system 模式下必须自行订阅系统明暗变化：applyTheme 只改 DOM/变量，不触发 React
 * 重渲染，否则「跟随系统」下切换系统主题时已挂载的编辑器会停在旧明暗。
 */
export function useMonacoEditor(): {
  theme: string;
  options: editor.IStandaloneEditorConstructionOptions;
} {
  const colorMode = usePiStore((s) => s.colorMode);
  const monacoTheme = usePiStore((s) => s.monacoTheme);
  const monacoFontFamily = usePiStore((s) => s.monacoFontFamily);
  const monacoFontSize = usePiStore((s) => s.monacoFontSize);
  const monacoLineHeight = usePiStore((s) => s.monacoLineHeight);
  const monacoTabSize = usePiStore((s) => s.monacoTabSize);
  const monacoLigatures = usePiStore((s) => s.monacoLigatures);
  const monacoWordWrap = usePiStore((s) => s.monacoWordWrap);
  const monacoMinimap = usePiStore((s) => s.monacoMinimap);
  const monacoLineNumbers = usePiStore((s) => s.monacoLineNumbers);
  const monacoStickyScroll = usePiStore((s) => s.monacoStickyScroll);
  const monacoIndentGuides = usePiStore((s) => s.monacoIndentGuides);

  // 系统明暗：只在模式为 system 时订阅，用 useSyncExternalStore 保证快照始终新鲜
  // （订阅回调内部不是同步 setState，不会触发 cascading render）
  const subscribeSystem = useCallback(
    (onChange: () => void) => (colorMode === 'system' ? onSystemColorChange(onChange) : () => {}),
    [colorMode]
  );
  const systemIsDark = useSyncExternalStore(subscribeSystem, systemPrefersDark);

  // 扩展主题（monaco-themes）必须先 defineTheme 才能 setTheme（未注册的名字会被 Monaco
  // 静默回退到 vs）。注册进度用 useSyncExternalStore 订阅：注册完成后触发重渲染，
  // 把 theme 从回退值切到真正的主题名，不需在 effect 里 setState。
  useSyncExternalStore(subscribeExtendedThemeDefinitions, getExtendedThemeDefinitionsVersion);
  const needsExtendedLoad =
    isExtendedMonacoThemeId(monacoTheme) && !isExtendedThemeDefined(monacoTheme);
  useEffect(() => {
    if (needsExtendedLoad) void ensureExtendedThemeDefined(monacoTheme);
  }, [monacoTheme, needsExtendedLoad]);

  // 扩展主题尚未注册时先用「跟随明暗」的等价主题顶上（避免闪白）
  const theme = needsExtendedLoad
    ? resolveMonacoTheme('auto', colorMode, systemIsDark)
    : resolveMonacoTheme(monacoTheme, colorMode, systemIsDark);
  const options = useMemo(
    () =>
      buildMonacoOptions({
        monacoFontFamily,
        monacoFontSize,
        monacoLineHeight,
        monacoTabSize,
        monacoLigatures,
        monacoWordWrap,
        monacoMinimap,
        monacoLineNumbers,
        monacoStickyScroll,
        monacoIndentGuides
      }),
    [
      monacoFontFamily,
      monacoFontSize,
      monacoLineHeight,
      monacoTabSize,
      monacoLigatures,
      monacoWordWrap,
      monacoMinimap,
      monacoLineNumbers,
      monacoStickyScroll,
      monacoIndentGuides
    ]
  );

  return { theme, options };
}
