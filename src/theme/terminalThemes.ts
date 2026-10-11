/**
 * 到 iTerm2-Color-Schemes/vscode/ 文件名的映射。
 *
 * 注意：iTerm2 主题配色精确对应终端 16 色 ANSI，与界面 UI 色板是两回事
 * （比如 VS Code Dark Modern 界面 accent 是 #0078d4 按钮蓝，但终端 ansiBlue 是 #3b8eea）。
 * 本表只为终端服务，界面与其他组件（Monaco / Markdown）仍走 themes.ts 的 vars。
 */
export const TERMINAL_THEME_FILE: Record<string, string> = {
  'atom-one-dark': 'One Half Dark.json',
  'atom-one-light': 'One Half Light.json',
  'vscode-plus-dark': 'Dark+.json',
  'vscode-plus-light': 'Light Owl.json',
  'vscode-modern-dark': 'Dark Modern.json',
  'vscode-modern-light': 'Light Owl.json',
  'github-dark': 'GitHub Dark Default.json',
  'github-light': 'GitHub Light Default.json',
  'jetbrains-dark': 'Idea.json',
  // jetbrains-light: 无官方 iTerm2 候选，保留手写 IntelliJ Light（见 TERMINAL_VARS_FALLBACK）
  'monokai-dark': 'Monokai Pro Spectrum.json',
  'monokai-light': 'Monokai Pro Light.json',
  'material-dark': 'Material Darker.json',
  'material-light': 'Material.json',
  'night-owl-dark': 'Night Owl.json',
  'night-owl-light': 'Night Owlish Light.json',
  'solarized-dark': 'iTerm2 Solarized Dark.json',
  'solarized-light': 'iTerm2 Solarized Light.json',
  'xcode-dark': 'Xcode Dark.json',
  'xcode-light': 'Xcode Light.json',
  'claude-dark': 'Claude Dark.json',
  'claude-light': 'Claude Light.json'
};

/** 无对应 iTerm2 JSON 的主题回退色：jetbrains-light */
export const TERMINAL_VARS_FALLBACK: Record<string, Record<string, string>> = {
  'jetbrains-light': {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#000000',
    cursorAccent: '#ffffff',
    selectionBackground: '#a6d2ff',
    black: '#000000',
    red: '#c7222d',
    green: '#067d17',
    yellow: '#b47c00',
    blue: '#0033b3',
    magenta: '#871094',
    cyan: '#0451a5',
    white: '#4b4b4b',
    brightBlack: '#6a6a6a',
    brightRed: '#d53232',
    brightGreen: '#0d8c14',
    brightYellow: '#d29d00',
    brightBlue: '#0451a5',
    brightMagenta: '#a91bc1',
    brightCyan: '#00627a',
    brightWhite: '#181818'
  }
};

export interface TerminalThemeData {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 从 iTerm2 JSON 的 workbench.colorCustomizations 转成 xterm ITheme */
export function parseITermTheme(json: Record<string, string>): TerminalThemeData {
  return {
    background: json['terminal.background'],
    foreground: json['terminal.foreground'],
    cursor: json['terminalCursor.foreground'],
    cursorAccent: json['terminalCursor.background'],
    selectionBackground: json['terminal.selectionBackground'],
    black: json['terminal.ansiBlack'],
    red: json['terminal.ansiRed'],
    green: json['terminal.ansiGreen'],
    yellow: json['terminal.ansiYellow'],
    blue: json['terminal.ansiBlue'],
    magenta: json['terminal.ansiMagenta'],
    cyan: json['terminal.ansiCyan'],
    white: json['terminal.ansiWhite'],
    brightBlack: json['terminal.ansiBrightBlack'],
    brightRed: json['terminal.ansiBrightRed'],
    brightGreen: json['terminal.ansiBrightGreen'],
    brightYellow: json['terminal.ansiBrightYellow'],
    brightBlue: json['terminal.ansiBrightBlue'],
    brightMagenta: json['terminal.ansiBrightMagenta'],
    brightCyan: json['terminal.ansiBrightCyan'],
    brightWhite: json['terminal.ansiBrightWhite']
  };
}
