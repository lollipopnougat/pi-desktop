/**
 * 【自动生成，请勿手改】编辑器扩展主题表（来源：monaco-themes@0.4.8，MIT）
 *
 * 重新生成：node scripts/generate-monaco-themes.mjs
 * 消费者：src/lib/monaco-themes.ts（下发 defineTheme）、设置页「编辑器」主题下拉框
 */

/** 扩展主题元数据（按 label 排序；base 决定下拉框里归入深色还是浅色分组） */
export const EXTENDED_MONACO_THEMES = [
  { id: 'active4d', label: 'Active4D', base: 'vs' },
  { id: 'all-hallows-eve', label: 'All Hallows Eve', base: 'vs-dark' },
  { id: 'amy', label: 'Amy', base: 'vs-dark' },
  { id: 'birds-of-paradise', label: 'Birds of Paradise', base: 'vs-dark' },
  { id: 'blackboard', label: 'Blackboard', base: 'vs-dark' },
  { id: 'brilliance-black', label: 'Brilliance Black', base: 'vs-dark' },
  { id: 'brilliance-dull', label: 'Brilliance Dull', base: 'vs-dark' },
  { id: 'chrome-devtools', label: 'Chrome DevTools', base: 'vs' },
  { id: 'clouds', label: 'Clouds', base: 'vs' },
  { id: 'clouds-midnight', label: 'Clouds Midnight', base: 'vs-dark' },
  { id: 'cobalt', label: 'Cobalt', base: 'vs-dark' },
  { id: 'cobalt2', label: 'Cobalt2', base: 'vs-dark' },
  { id: 'dawn', label: 'Dawn', base: 'vs' },
  { id: 'dominion-day', label: 'Dominion Day', base: 'vs-dark' },
  { id: 'dracula', label: 'Dracula', base: 'vs-dark' },
  { id: 'dreamweaver', label: 'Dreamweaver', base: 'vs' },
  { id: 'eiffel', label: 'Eiffel', base: 'vs' },
  { id: 'espresso-libre', label: 'Espresso Libre', base: 'vs-dark' },
  { id: 'github', label: 'GitHub', base: 'vs' },
  { id: 'github-dark', label: 'GitHub Dark', base: 'vs-dark' },
  { id: 'github-light', label: 'GitHub Light', base: 'vs' },
  { id: 'idle', label: 'IDLE', base: 'vs' },
  { id: 'idlefingers', label: 'idleFingers', base: 'vs-dark' },
  { id: 'iplastic', label: 'iPlastic', base: 'vs' },
  { id: 'katzenmilch', label: 'Katzenmilch', base: 'vs' },
  { id: 'krtheme', label: 'krTheme', base: 'vs-dark' },
  { id: 'kuroir-theme', label: 'Kuroir Theme', base: 'vs' },
  { id: 'lazy', label: 'LAZY', base: 'vs' },
  { id: 'magicwb-amiga', label: 'MagicWB (Amiga)', base: 'vs' },
  { id: 'merbivore', label: 'Merbivore', base: 'vs-dark' },
  { id: 'merbivore-soft', label: 'Merbivore Soft', base: 'vs-dark' },
  { id: 'monoindustrial', label: 'monoindustrial', base: 'vs-dark' },
  { id: 'monokai', label: 'Monokai', base: 'vs-dark' },
  { id: 'monokai-bright', label: 'Monokai Bright', base: 'vs-dark' },
  { id: 'night-owl', label: 'Night Owl', base: 'vs-dark' },
  { id: 'nord', label: 'Nord', base: 'vs-dark' },
  { id: 'oceanic-next', label: 'Oceanic Next', base: 'vs-dark' },
  { id: 'pastels-on-dark', label: 'Pastels on Dark', base: 'vs-dark' },
  { id: 'slush-and-poppies', label: 'Slush and Poppies', base: 'vs' },
  { id: 'solarized-dark', label: 'Solarized-dark', base: 'vs-dark' },
  { id: 'solarized-light', label: 'Solarized-light', base: 'vs' },
  { id: 'spacecadet', label: 'SpaceCadet', base: 'vs-dark' },
  { id: 'sunburst', label: 'Sunburst', base: 'vs-dark' },
  { id: 'textmate-mac-classic', label: 'Textmate (Mac Classic)', base: 'vs' },
  { id: 'tomorrow', label: 'Tomorrow', base: 'vs' },
  { id: 'tomorrow-night', label: 'Tomorrow-Night', base: 'vs-dark' },
  { id: 'tomorrow-night-blue', label: 'Tomorrow-Night-Blue', base: 'vs-dark' },
  { id: 'tomorrow-night-bright', label: 'Tomorrow-Night-Bright', base: 'vs-dark' },
  { id: 'tomorrow-night-eighties', label: 'Tomorrow-Night-Eighties', base: 'vs-dark' },
  { id: 'twilight', label: 'Twilight', base: 'vs-dark' },
  { id: 'upstream-sunburst', label: 'Upstream Sunburst', base: 'vs-dark' },
  { id: 'vibrant-ink', label: 'Vibrant Ink', base: 'vs-dark' },
  { id: 'xcode-default', label: 'Xcode_default', base: 'vs' },
  { id: 'zenburnesque', label: 'Zenburnesque', base: 'vs-dark' }
] as const;

export type ExtendedMonacoTheme = (typeof EXTENDED_MONACO_THEMES)[number];
export type ExtendedMonacoThemeId = ExtendedMonacoTheme['id'];

/** id → 主题 JSON 的动态 import（每个主题一个 chunk，选中才加载；路径相对本文件） */
export const EXTENDED_MONACO_THEME_LOADERS: Record<
  ExtendedMonacoThemeId,
  () => Promise<{ default: unknown }>
> = {
  active4d: () => import('../../node_modules/monaco-themes/themes/Active4D.json'),
  'all-hallows-eve': () => import('../../node_modules/monaco-themes/themes/All Hallows Eve.json'),
  amy: () => import('../../node_modules/monaco-themes/themes/Amy.json'),
  'birds-of-paradise': () =>
    import('../../node_modules/monaco-themes/themes/Birds of Paradise.json'),
  blackboard: () => import('../../node_modules/monaco-themes/themes/Blackboard.json'),
  'brilliance-black': () => import('../../node_modules/monaco-themes/themes/Brilliance Black.json'),
  'brilliance-dull': () => import('../../node_modules/monaco-themes/themes/Brilliance Dull.json'),
  'chrome-devtools': () => import('../../node_modules/monaco-themes/themes/Chrome DevTools.json'),
  clouds: () => import('../../node_modules/monaco-themes/themes/Clouds.json'),
  'clouds-midnight': () => import('../../node_modules/monaco-themes/themes/Clouds Midnight.json'),
  cobalt: () => import('../../node_modules/monaco-themes/themes/Cobalt.json'),
  cobalt2: () => import('../../node_modules/monaco-themes/themes/Cobalt2.json'),
  dawn: () => import('../../node_modules/monaco-themes/themes/Dawn.json'),
  'dominion-day': () => import('../../node_modules/monaco-themes/themes/Dominion Day.json'),
  dracula: () => import('../../node_modules/monaco-themes/themes/Dracula.json'),
  dreamweaver: () => import('../../node_modules/monaco-themes/themes/Dreamweaver.json'),
  eiffel: () => import('../../node_modules/monaco-themes/themes/Eiffel.json'),
  'espresso-libre': () => import('../../node_modules/monaco-themes/themes/Espresso Libre.json'),
  github: () => import('../../node_modules/monaco-themes/themes/GitHub.json'),
  'github-dark': () => import('../../node_modules/monaco-themes/themes/GitHub Dark.json'),
  'github-light': () => import('../../node_modules/monaco-themes/themes/GitHub Light.json'),
  idle: () => import('../../node_modules/monaco-themes/themes/IDLE.json'),
  idlefingers: () => import('../../node_modules/monaco-themes/themes/idleFingers.json'),
  iplastic: () => import('../../node_modules/monaco-themes/themes/iPlastic.json'),
  katzenmilch: () => import('../../node_modules/monaco-themes/themes/Katzenmilch.json'),
  krtheme: () => import('../../node_modules/monaco-themes/themes/krTheme.json'),
  'kuroir-theme': () => import('../../node_modules/monaco-themes/themes/Kuroir Theme.json'),
  lazy: () => import('../../node_modules/monaco-themes/themes/LAZY.json'),
  'magicwb-amiga': () => import('../../node_modules/monaco-themes/themes/MagicWB (Amiga).json'),
  merbivore: () => import('../../node_modules/monaco-themes/themes/Merbivore.json'),
  'merbivore-soft': () => import('../../node_modules/monaco-themes/themes/Merbivore Soft.json'),
  monoindustrial: () => import('../../node_modules/monaco-themes/themes/monoindustrial.json'),
  monokai: () => import('../../node_modules/monaco-themes/themes/Monokai.json'),
  'monokai-bright': () => import('../../node_modules/monaco-themes/themes/Monokai Bright.json'),
  'night-owl': () => import('../../node_modules/monaco-themes/themes/Night Owl.json'),
  nord: () => import('../../node_modules/monaco-themes/themes/Nord.json'),
  'oceanic-next': () => import('../../node_modules/monaco-themes/themes/Oceanic Next.json'),
  'pastels-on-dark': () => import('../../node_modules/monaco-themes/themes/Pastels on Dark.json'),
  'slush-and-poppies': () =>
    import('../../node_modules/monaco-themes/themes/Slush and Poppies.json'),
  'solarized-dark': () => import('../../node_modules/monaco-themes/themes/Solarized-dark.json'),
  'solarized-light': () => import('../../node_modules/monaco-themes/themes/Solarized-light.json'),
  spacecadet: () => import('../../node_modules/monaco-themes/themes/SpaceCadet.json'),
  sunburst: () => import('../../node_modules/monaco-themes/themes/Sunburst.json'),
  'textmate-mac-classic': () =>
    import('../../node_modules/monaco-themes/themes/Textmate (Mac Classic).json'),
  tomorrow: () => import('../../node_modules/monaco-themes/themes/Tomorrow.json'),
  'tomorrow-night': () => import('../../node_modules/monaco-themes/themes/Tomorrow-Night.json'),
  'tomorrow-night-blue': () =>
    import('../../node_modules/monaco-themes/themes/Tomorrow-Night-Blue.json'),
  'tomorrow-night-bright': () =>
    import('../../node_modules/monaco-themes/themes/Tomorrow-Night-Bright.json'),
  'tomorrow-night-eighties': () =>
    import('../../node_modules/monaco-themes/themes/Tomorrow-Night-Eighties.json'),
  twilight: () => import('../../node_modules/monaco-themes/themes/Twilight.json'),
  'upstream-sunburst': () =>
    import('../../node_modules/monaco-themes/themes/Upstream Sunburst.json'),
  'vibrant-ink': () => import('../../node_modules/monaco-themes/themes/Vibrant Ink.json'),
  'xcode-default': () => import('../../node_modules/monaco-themes/themes/Xcode_default.json'),
  zenburnesque: () => import('../../node_modules/monaco-themes/themes/Zenburnesque.json')
};
