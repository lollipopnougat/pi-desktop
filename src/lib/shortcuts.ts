/**
 * 键盘快捷键核心（纯函数，无 React / 无 IPC，可在 node 下单测）
 *
 * 约定：
 * - 绑定用 `+` 连接修饰键与按键，例如 `Mod+Shift+T`、`Mod+,`、`Ctrl+Alt+K`
 * - `Mod` = macOS 的 ⌘ / 其他平台的 Ctrl（跨平台默认值只写一份）
 * - `Ctrl` 只在 macOS 上表示独立的 Control 键；与 `Mod` 不能同时出现（非 mac 上语义重叠）
 * - 修饰键存储顺序固定 Mod → Ctrl → Alt → Shift，按键在最后；比较一律走规范化以后的字符串
 * - 空字符串表示「未分配」（用户主动清除）；字段缺失表示「用默认值」，两者语义不同
 */

export type ShortcutCategory = 'session' | 'view' | 'chat';

export interface ShortcutAction {
  id: string;
  category: ShortcutCategory;
  /** 默认绑定；空字符串 = 默认未分配 */
  defaultBinding: string;
}

/** id → 绑定。空串表示未分配；缺失的键在 resolveShortcutMap 里补默认值 */
export type ShortcutMap = Record<string, string>;

/**
 * 全部可配置动作。新增动作要同步：
 * - 执行层 `src/lib/shortcut-commands.ts`（switch 分支）
 * - 文案 `src/i18n/zh.ts` 的 `shortcutActionText`
 * - 测试 `tests/shortcuts/*`（默认值/冲突/文案完整性）
 */
export const SHORTCUT_ACTIONS = [
  // === 会话 ===
  { id: 'session.new', category: 'session', defaultBinding: 'Mod+N' },
  { id: 'session.search', category: 'session', defaultBinding: 'Mod+K' },
  { id: 'session.tree', category: 'session', defaultBinding: 'Mod+Shift+T' },
  { id: 'session.reload', category: 'session', defaultBinding: '' },
  { id: 'session.exportHtml', category: 'session', defaultBinding: '' },
  // === 视图 ===
  { id: 'view.sidebar', category: 'view', defaultBinding: 'Mod+B' },
  { id: 'view.workspace', category: 'view', defaultBinding: 'Mod+Shift+E' },
  { id: 'view.workspaceMax', category: 'view', defaultBinding: '' },
  { id: 'view.terminal', category: 'view', defaultBinding: 'Mod+J' },
  { id: 'view.todo', category: 'view', defaultBinding: '' },
  { id: 'view.settings', category: 'view', defaultBinding: 'Mod+,' },
  { id: 'view.theme', category: 'view', defaultBinding: '' },
  // === 对话 ===
  { id: 'chat.focusInput', category: 'chat', defaultBinding: 'Mod+L' },
  { id: 'chat.stop', category: 'chat', defaultBinding: 'Mod+.' }
] as const satisfies readonly ShortcutAction[];

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id'];

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ['session', 'view', 'chat'];

/** 动作索引（id → 定义） */
export const SHORTCUT_ACTION_BY_ID: Record<ShortcutActionId, ShortcutAction> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action])
) as Record<ShortcutActionId, ShortcutAction>;

export function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(SHORTCUT_ACTION_BY_ID, value)
  );
}

/** 默认绑定表（含未分配项，值为空串） */
export const DEFAULT_SHORTCUTS: ShortcutMap = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding])
);

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type ModifierToken = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, ModifierToken> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  meta: 'Mod',
  super: 'Mod',
  win: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift'
};

const NAMED_KEY_ALIASES: Record<string, string> = {
  space: 'Space',
  spacebar: 'Space',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
  minus: '-',
  equal: '=',
  backquote: '`',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight'
};

/** 可绑定的标点/符号键（`+` 不参与：它本身就是分隔符） */
const SYMBOL_KEYS = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`']);

/** KeyboardEvent.code（物理键位）→ 绑定用按键 token */
const CODE_KEY_MAP: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight'
};

const FUNCTION_KEY_RE = /^F([1-9]|1[0-9]|2[0-4])$/;

/** 单个按键 token 规范化；无法识别返回 null */
function normalizeKeyToken(raw: string): string | null {
  if (!raw) return null;
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9]$/.test(raw)) return raw;
  const named = NAMED_KEY_ALIASES[raw.toLowerCase()];
  if (named) return named;
  if (FUNCTION_KEY_RE.test(raw.toUpperCase())) return raw.toUpperCase();
  if (SYMBOL_KEYS.has(raw)) return raw;
  return null;
}

/**
 * 把任意写法规范成存储用的标准串；非法（只有修饰键 / 两个按键 / Mod+Ctrl 并存）返回 null。
 * 幂等：normalizeBinding(normalizeBinding(x)!) === normalizeBinding(x)
 */
export function normalizeBinding(binding: string): string | null {
  if (typeof binding !== 'string') return null;
  const trimmed = binding.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('+').map((part) => part.trim());
  if (parts.some((part) => !part)) return null;

  const modifiers = new Set<ModifierToken>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) return null;
    key = normalizeKeyToken(part);
    if (key === null) return null;
  }
  if (key === null) return null;
  // Mod 在非 mac 上就是 Ctrl，两者并存语义重复，直接判非法
  if (modifiers.has('Mod') && modifiers.has('Ctrl')) return null;

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join('+');
}

/**
 * 是否允许绑定：必须有修饰键，或按键是 F1–F24。
 * 允许裸字母/数字会让全局监听吃掉正常输入。
 */
export function isBindableBinding(binding: string): boolean {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  return parts.length > 1 || FUNCTION_KEY_RE.test(key);
}

/** 从键盘事件取按键 token（优先 event.code：不受输入法/Shift 变体影响） */
function keyFromEvent(event: KeyboardEvent): string | null {
  const code = event.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (FUNCTION_KEY_RE.test(code)) return code;
  const fromCode = CODE_KEY_MAP[code];
  if (fromCode) return fromCode;
  // 兜底：老浏览器/合成事件没有 code（小键盘也走这条：只认主键盘数字）
  return normalizeKeyToken(event.key ?? '');
}

/** 事件 → 标准绑定串；只按修饰键时返回 null */
export function bindingFromKeyboardEvent(event: KeyboardEvent, isMac: boolean): string | null {
  const key = keyFromEvent(event);
  if (!key) return null;
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (isMac && event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return normalizeBinding(parts.join('+'));
}

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Escape: '⎋',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Space: '␣',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘'
};

/** 绑定 → 展示文案（mac 用 ⌃⌥⇧⌘ 符号，其他平台用 Ctrl+Alt+Shift） */
export function formatBinding(binding: string, isMac: boolean): string {
  const normalized = normalizeBinding(binding);
  if (!normalized) return '';
  const parts = normalized.split('+');
  const key = parts.pop() as string;
  const has = (modifier: ModifierToken) => parts.includes(modifier);

  if (isMac) {
    return [
      has('Ctrl') ? '⌃' : '',
      has('Alt') ? '⌥' : '',
      has('Shift') ? '⇧' : '',
      has('Mod') ? '⌘' : '',
      MAC_KEY_LABELS[key] ?? key
    ].join('');
  }

  const labels: string[] = [];
  if (has('Mod') || has('Ctrl')) labels.push('Ctrl');
  if (has('Alt')) labels.push('Alt');
  if (has('Shift')) labels.push('Shift');
  labels.push(MAC_KEY_LABELS[key] ?? key);
  return labels.join('+');
}

/** 事件是否命中绑定 */
export function matchesBinding(binding: string, event: KeyboardEvent, isMac: boolean): boolean {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;
  return bindingFromKeyboardEvent(event, isMac) === normalized;
}

/**
 * 系统/宿主保留组合：这些由 OS 或 Electron 菜单拦截，绑了也用不上，
 * 或者会抢掉窗口级操作（⌘W 关窗、⌘Q 退出等），统一禁止。
 */
export function isReservedBinding(binding: string, isMac: boolean): boolean {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const has = (modifier: ModifierToken) => parts.includes(modifier);

  if (isMac) {
    if (has('Mod') && !has('Alt') && !has('Ctrl')) {
      if (['Q', 'W', 'H', 'M', 'Tab', 'Space'].includes(key)) return true;
    }
    if (has('Mod') && has('Alt') && key === 'Escape') return true;
    return false;
  }

  if (key === 'F4' && has('Alt')) return true;
  if (has('Alt') && (key === 'Tab' || key === 'Space')) return true;
  if ((has('Mod') || has('Ctrl')) && !has('Alt')) {
    if (['Q', 'W', 'Tab', 'Escape'].includes(key)) return true;
    if (has('Shift') && key === 'Tab') return true;
  }
  return false;
}

/**
 * 查找与 binding 冲突的动作 id。
 * 同一条绑定被两个动作占用时，执行层只会命中先注册的那个，所以保存前必须拦下来。
 */
export function findShortcutConflict(
  binding: string,
  map: ShortcutMap,
  exceptId?: string
): ShortcutActionId | null {
  const normalized = normalizeBinding(binding);
  if (!normalized) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === exceptId) continue;
    const value = map[action.id];
    if (!value) continue;
    if (normalizeBinding(value) === normalized) return action.id;
  }
  return null;
}

/**
 * 磁盘值 → 完整绑定表（每个已知动作都有一项）。
 * - 字段缺失：用默认值
 * - 空串：保持未分配
 * - 非法/不可绑定：回退默认值（避免一个坏值让快捷键彻底失效）
 * - 未知动作 id：丢弃（老版本遗留）
 */
export function resolveShortcutMap(stored: unknown): ShortcutMap {
  const source =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const map: ShortcutMap = {};
  for (const action of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(source, action.id)) {
      map[action.id] = action.defaultBinding;
      continue;
    }
    const value = source[action.id];
    if (typeof value !== 'string') {
      map[action.id] = action.defaultBinding;
      continue;
    }
    if (!value.trim()) {
      map[action.id] = '';
      continue;
    }
    const normalized = normalizeBinding(value);
    map[action.id] =
      normalized && isBindableBinding(normalized) ? normalized : action.defaultBinding;
  }
  return map;
}

/** 绑定表是否与默认值完全一致（设置页「全部重置」按钮的禁用态用） */
export function isDefaultShortcutMap(map: ShortcutMap): boolean {
  return SHORTCUT_ACTIONS.every((action) => (map[action.id] ?? '') === action.defaultBinding);
}

/** 搜索文本：标签 + 说明 + 绑定展示串 + 原始串（都由调用方拼好后传入） */
export function matchesShortcutQuery(
  haystacks: (string | null | undefined)[],
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => (value ?? '').toLowerCase().includes(needle));
}
