import { loader } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  EXTENDED_MONACO_THEMES,
  EXTENDED_MONACO_THEME_LOADERS,
  type ExtendedMonacoThemeId
} from './monaco-themes.generated';

export { EXTENDED_MONACO_THEMES };
export type { ExtendedMonacoThemeId };

/**
 * 编辑器扩展主题（来源 monaco-themes@0.4.x，MIT；表在 monaco-themes.generated.ts）。
 *
 * 与「内置主题」（vs / vs-dark / hc-black / hc-light）的区别：
 * - 内置主题由 Monaco 自己注册，主题名可以直接喂给 <Editor theme>；
 * - 扩展主题必须先 `monaco.editor.defineTheme(id, data)`，否则 setTheme 拿到未注册的名字
 *   会静默回退到 vs（浅色）。所以选择扩展主题时要先加载并注册，再切换。
 *
 * 54 个主题 JSON 合计约 470KB，按「每个主题一个 chunk」动态加载，只有被选中的那个会被取回来。
 *
 * loader 用静态 import（@monaco-editor/react 本来就随应用打进主包，改成动态 import 反而
 * 让 Rollup 告警「既动态又静态导入，不会拆成单独 chunk」）。
 */

const EXTENDED_THEME_IDS = new Set<string>(EXTENDED_MONACO_THEMES.map((th) => th.id));

/** 是否为扩展主题 id（供持久化校验与 hook 分派用） */
export function isExtendedMonacoThemeId(v: unknown): v is ExtendedMonacoThemeId {
  return typeof v === 'string' && EXTENDED_THEME_IDS.has(v);
}

/** 读取扩展主题的 JSON 数据（失败返回 null，调用方保持当前主题不切换） */
export async function loadExtendedThemeData(
  id: string
): Promise<editor.IStandaloneThemeData | null> {
  const load = EXTENDED_MONACO_THEME_LOADERS[id as ExtendedMonacoThemeId];
  if (!load) return null;
  try {
    const mod = (await load()) as { default?: editor.IStandaloneThemeData };
    return mod.default ?? null;
  } catch {
    return null;
  }
}

const definedThemes = new Set<string>();
const inFlight = new Map<string, Promise<boolean>>();

// 注册进度用「版本号 + 订阅」广播：已挂载的编辑器挂在扩展主题上时，
// 注册完成要触发重渲染才能把 theme 从回退值切到真正的主题名。
let definedVersion = 0;
const definedListeners = new Set<() => void>();

export function subscribeExtendedThemeDefinitions(listener: () => void): () => void {
  definedListeners.add(listener);
  return () => {
    definedListeners.delete(listener);
  };
}

export function getExtendedThemeDefinitionsVersion(): number {
  return definedVersion;
}

/** 该扩展主题是否已注册到 Monaco */
export function isExtendedThemeDefined(id: string): boolean {
  return definedThemes.has(id);
}

/**
 * 确保扩展主题已注册（幂等；并发调用共享同一个 promise，不会重复加载/重复注册）。
 *
 * 注意 Monaco 实例的来源：@monaco-editor/loader 由 src/hooks/useMonaco.ts 配置为从
 * 本地 min/vs 加载，必须用 loader.init() 取到**同一个**实例；直接 `import 'monaco-editor'`
 * 会拿到另一份 ESM 实例，defineTheme 会打在不存在的编辑器上。
 */
export function ensureExtendedThemeDefined(id: string): Promise<boolean> {
  if (definedThemes.has(id)) return Promise.resolve(true);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const data = await loadExtendedThemeData(id);
    if (!data) return false;
    const monaco = await loader.init();
    monaco.editor.defineTheme(id, data);
    definedThemes.add(id);
    definedVersion += 1;
    for (const listener of definedListeners) listener();
    return true;
  })()
    .catch(() => false)
    .finally(() => {
      inFlight.delete(id);
    });

  inFlight.set(id, task);
  return task;
}
