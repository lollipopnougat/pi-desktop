/**
 * 主题应用：把主题族 + 明暗模式解析成实际生效的变量表，写到
 * DOM / Monaco / xterm / 防闪烁缓存。
 *
 * 数据流：
 * - 权威来源：store 的 themeFamily + colorMode（持久化在 ui-config.json）。
 * - 解析：resolveVariant(family, mode, systemIsDark) 得当前生效变体。
 * - DOM：写 <html data-theme="family:dark|light"> + inline --od-* 变量。
 * - 语法高亮：不再使用 per-theme 样式表；hljs 类统一用 CSS 变量（index.css
 *   里的 .hljs-keyword { color: rgb(var(--od-syn-keyword)) } 等）。
 * - Monaco：不再由本文件接管。编辑器主题/字体等外观项由设置页「编辑器」section
 *   控制（store 的 monaco* 偏好 + src/hooks/useMonacoEditor.ts），默认 'auto' 时
 *   同样只跟随明暗切换内置 vs-dark / vs，不跟随主题族配色：主题族取色面向 UI/终端
 *   （ansi 色板），拿它覆盖 Monaco 会把 keyword/string 染成不符合编辑器惯例的颜色
 *   （例如 VS Code 终端 ansiRed 是红、而编辑器 keyword 应是蓝）。
 * - xterm：派发 'pi-theme-change' CustomEvent，TerminalPanel 热更新。
 * - 防闪烁：localStorage['pi-theme-vars'] 缓存变量 JSON，index.html 启动脚本读取。
 *
 * 新增主题：只需在 themes.ts 的 THEME_FAMILIES 加一项，本文件无需改动。
 */
import {
  getThemeFamily,
  isColorMode,
  isThemeFamilyId,
  resolveVariant,
  rgbStrToHex,
  type ColorMode
} from './themes';

/* ---------------- 系统明暗探测 ---------------- */
const sysMedia =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function systemPrefersDark(): boolean {
  return sysMedia ? sysMedia.matches : true;
}

/** 订阅系统明暗变化（mode === 'system' 时热切换）。返回退订函数。 */
export function onSystemColorChange(cb: (isDark: boolean) => void): () => void {
  if (!sysMedia) return () => {};
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  sysMedia.addEventListener?.('change', handler);
  return () => sysMedia.removeEventListener?.('change', handler);
}

/* ---------------- 应用入口 ---------------- */
export function applyTheme(familyId: string, mode: ColorMode): void {
  if (!isThemeFamilyId(familyId)) familyId = getThemeFamily(undefined).id;
  if (!isColorMode(mode)) mode = 'system';
  const variant = resolveVariant(familyId, mode, systemPrefersDark());

  const root = document.documentElement;
  root.dataset.theme = `${familyId}:${variant.resolved}`;
  root.style.colorScheme = variant.resolved;
  for (const [k, val] of Object.entries(variant.vars)) {
    root.style.setProperty(`--od-${k}`, val);
  }
  try {
    window.localStorage.setItem('pi-theme', familyId);
    window.localStorage.setItem('pi-theme-mode', mode);
    window.localStorage.setItem('pi-theme-vars', JSON.stringify(variant.vars));
  } catch {}
  // 窗口材质联动：主进程侧 nativeTheme.themeSource + vibrancy 材质切换
  // （浅色用 titlebar 材质呈现亮玻璃，深色用 under-window）。
  // 用户选“跟随系统”时传 system，材质明暗跟随系统设置自动切换。
  window.pi?.setThemeAppearance?.(mode === 'system' ? 'system' : variant.resolved).catch(() => {});
  window.dispatchEvent(new CustomEvent('pi-theme-change', { detail: { familyId, mode } }));
}

/* ---------------- xterm ---------------- */
/**
 * 主题变量 -> xterm ITheme 近似回退。
 * 正式路径在 TerminalPanel 中经 pi:terminalTheme IPC 读取 iTerm2 官方 JSON
 * （workbench.colorCustomizations），这里只是 JSON 遭失脱机场景下的近似适配。
 */
function adjust(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(Math.max(0, Math.min(255, v + delta * 255)));
  const r = f((n >> 16) & 255),
    g = f((n >> 8) & 255),
    b = f(n & 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function terminalThemeFor(familyId: string, mode: ColorMode): Record<string, string> {
  const variant = resolveVariant(familyId, mode, systemPrefersDark());
  const v = (k: string) => rgbStrToHex(variant.vars[k] ?? variant.vars.text ?? '0 0 0');
  const isLight = variant.resolved === 'light';
  const brightDelta = isLight ? -0.12 : 0.15;
  const red = v('red'),
    green = v('green'),
    yellow = v('yellow');
  const blue = v('accent'),
    magenta = v('purple'),
    cyan = v('cyan');
  const black = v('border-light'),
    white = v('text');
  return {
    background: v('term-bg'),
    foreground: white,
    cursor: v('term-cursor'),
    cursorAccent: v('term-bg'),
    selectionBackground: v('sel-bg'),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: adjust(black, brightDelta),
    brightRed: adjust(red, brightDelta),
    brightGreen: adjust(green, brightDelta),
    brightYellow: adjust(yellow, brightDelta),
    brightBlue: adjust(blue, brightDelta),
    brightMagenta: adjust(magenta, brightDelta),
    brightCyan: adjust(cyan, brightDelta),
    brightWhite: adjust(white, isLight ? 0.08 : 0.1)
  };
}

export function applyTerminalTheme(
  familyId: string,
  mode: ColorMode,
  term: { options: { theme?: unknown } }
): void {
  term.options.theme = terminalThemeFor(familyId, mode);
}
