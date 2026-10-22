import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  bindingFromKeyboardEvent,
  findShortcutConflict,
  formatBinding,
  isBindableBinding,
  isDefaultShortcutMap,
  isReservedBinding,
  matchesBinding,
  matchesShortcutQuery,
  normalizeBinding,
  resolveShortcutMap
} from '../../src/lib/shortcuts';

/** 构造最小键盘事件（node 环境没有 KeyboardEvent 构造器） */
function keyEvent(init: {
  code?: string;
  key?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}): KeyboardEvent {
  return {
    code: init.code ?? '',
    key: init.key ?? '',
    metaKey: !!init.meta,
    ctrlKey: !!init.ctrl,
    altKey: !!init.alt,
    shiftKey: !!init.shift
  } as unknown as KeyboardEvent;
}

describe('normalizeBinding', () => {
  it('规范化修饰键顺序与大小写', () => {
    expect(normalizeBinding('shift+mod+t')).toBe('Mod+Shift+T');
    expect(normalizeBinding('Mod+Shift+T')).toBe('Mod+Shift+T');
    expect(normalizeBinding('alt+mod+a')).toBe('Mod+Alt+A');
    expect(normalizeBinding('Mod+,')).toBe('Mod+,');
  });

  it('支持别名（cmd/option/control/esc 等）', () => {
    expect(normalizeBinding('cmd+n')).toBe('Mod+N');
    expect(normalizeBinding('option+cmd+a')).toBe('Mod+Alt+A');
    expect(normalizeBinding('esc')).toBe('Escape');
    expect(normalizeBinding('Mod+Period')).toBe('Mod+.');
  });

  it('拒绝只有修饰键、两个按键、Mod+Ctrl 并存、未知按键', () => {
    expect(normalizeBinding('Mod')).toBeNull();
    expect(normalizeBinding('Mod+N+K')).toBeNull();
    expect(normalizeBinding('Mod+Ctrl+K')).toBeNull();
    expect(normalizeBinding('Mod+Hyper+K')).toBeNull();
    expect(normalizeBinding('')).toBeNull();
    expect(normalizeBinding('Mod++')).toBeNull();
  });

  it('幂等', () => {
    const once = normalizeBinding('shift+alt+mod+k');
    expect(once).toBe('Mod+Alt+Shift+K');
    expect(normalizeBinding(once as string)).toBe(once);
  });
});

describe('formatBinding', () => {
  it('macOS 用符号并按 ⌃⌥⇧⌘ 排布', () => {
    expect(formatBinding('Mod+N', true)).toBe('⌘N');
    expect(formatBinding('Mod+Shift+O', true)).toBe('⇧⌘O');
    expect(formatBinding('Mod+Alt+A', true)).toBe('⌥⌘A');
    expect(formatBinding('Ctrl+Mod+O', true)).toBe(''); // Mod+Ctrl 不允许
    expect(formatBinding('Ctrl+Alt+K', true)).toBe('⌃⌥K');
    expect(formatBinding('Mod+.', true)).toBe('⌘.');
  });

  it('其他平台用 Ctrl/Alt/Shift 文案', () => {
    expect(formatBinding('Mod+N', false)).toBe('Ctrl+N');
    expect(formatBinding('Mod+Shift+E', false)).toBe('Ctrl+Shift+E');
    expect(formatBinding('Ctrl+Alt+K', false)).toBe('Ctrl+Alt+K');
  });

  it('未分配/非法绑定返回空串', () => {
    expect(formatBinding('', true)).toBe('');
    expect(formatBinding('Mod', true)).toBe('');
  });
});

describe('bindingFromKeyboardEvent / matchesBinding', () => {
  it('mac 上 Meta 记为 Mod，Ctrl 单独记录', () => {
    expect(bindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', meta: true }), true)).toBe(
      'Mod+N'
    );
    expect(bindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', ctrl: true }), true)).toBe(
      'Ctrl+N'
    );
  });

  it('非 mac 上 Ctrl 记为 Mod，Meta 被忽略', () => {
    expect(bindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', ctrl: true }), false)).toBe(
      'Mod+N'
    );
    expect(bindingFromKeyboardEvent(keyEvent({ code: 'KeyN', key: 'n', meta: true }), false)).toBe(
      'N'
    );
  });

  it('按物理键位取符号键，Shift 单独作为修饰键', () => {
    expect(
      bindingFromKeyboardEvent(
        keyEvent({ code: 'Period', key: '>', meta: true, shift: true }),
        true
      )
    ).toBe('Mod+Shift+.');
  });

  it('只按修饰键返回 null', () => {
    expect(
      bindingFromKeyboardEvent(keyEvent({ code: 'ShiftLeft', key: 'Shift', shift: true }), true)
    ).toBeNull();
  });

  it('matchesBinding 要求修饰键完全一致', () => {
    const shiftN = keyEvent({ code: 'KeyN', key: 'N', meta: true, shift: true });
    const plainN = keyEvent({ code: 'KeyN', key: 'n', meta: true });
    expect(matchesBinding('Mod+N', plainN, true)).toBe(true);
    expect(matchesBinding('Mod+N', shiftN, true)).toBe(false);
    expect(matchesBinding('Mod+Shift+N', shiftN, true)).toBe(true);
  });
});

describe('可绑定性与保留组合', () => {
  it('必须有修饰键或使用功能键', () => {
    expect(isBindableBinding('Mod+N')).toBe(true);
    expect(isBindableBinding('F5')).toBe(true);
    expect(isBindableBinding('N')).toBe(false);
    expect(isBindableBinding('7')).toBe(false);
  });

  it('拦截系统/窗口占用的组合', () => {
    expect(isReservedBinding('Mod+Q', true)).toBe(true);
    expect(isReservedBinding('Mod+W', true)).toBe(true);
    expect(isReservedBinding('Mod+Tab', true)).toBe(true);
    expect(isReservedBinding('Mod+Shift+N', true)).toBe(false);
    expect(isReservedBinding('Mod+Q', false)).toBe(true);
    expect(isReservedBinding('Alt+F4', false)).toBe(true);
    expect(isReservedBinding('Mod+Shift+P', false)).toBe(false);
  });
});

describe('findShortcutConflict', () => {
  const map = { 'session.new': 'Mod+N', 'view.sidebar': 'Mod+B' };

  it('命中其他动作时返回该动作 id', () => {
    expect(findShortcutConflict('Mod+N', map, 'view.sidebar')).toBe('session.new');
    expect(findShortcutConflict('mod+b', { ...DEFAULT_SHORTCUTS }, 'session.new')).toBe(
      'view.sidebar'
    );
  });

  it('排除自身与空绑定不算冲突', () => {
    expect(findShortcutConflict('Mod+N', map, 'session.new')).toBeNull();
    expect(findShortcutConflict('Mod+Alt+9', map)).toBeNull();
  });
});

describe('resolveShortcutMap', () => {
  it('缺失字段补默认值，空串保持未分配', () => {
    const resolved = resolveShortcutMap({ 'session.new': 'Mod+Shift+U', 'session.reload': '' });
    expect(resolved['session.new']).toBe('Mod+Shift+U');
    expect(resolved['session.reload']).toBe('');
    // 未出现在磁盘上的动作走默认值
    expect(resolved['session.search']).toBe(DEFAULT_SHORTCUTS['session.search']);
    // 默认未分配的动作同样保持未分配
    expect(resolved['view.todo']).toBe('');
  });

  it('非法值回退默认值，未知动作丢弃', () => {
    const resolved = resolveShortcutMap({
      'session.new': 'N', // 没有修饰键，不可绑定
      'view.sidebar': 42,
      'not.an.action': 'Mod+9'
    });
    expect(resolved['session.new']).toBe(DEFAULT_SHORTCUTS['session.new']);
    expect(resolved['view.sidebar']).toBe(DEFAULT_SHORTCUTS['view.sidebar']);
    expect(resolved).not.toHaveProperty('not.an.action');
  });

  it('容忍非对象输入', () => {
    expect(resolveShortcutMap(null)).toEqual({ ...DEFAULT_SHORTCUTS });
    expect(resolveShortcutMap('nope')).toEqual({ ...DEFAULT_SHORTCUTS });
    expect(resolveShortcutMap([])).toEqual({ ...DEFAULT_SHORTCUTS });
  });

  it('isDefaultShortcutMap 识别默认表', () => {
    expect(isDefaultShortcutMap({ ...DEFAULT_SHORTCUTS })).toBe(true);
    expect(isDefaultShortcutMap({ ...DEFAULT_SHORTCUTS, 'session.new': '' })).toBe(false);
    expect(isDefaultShortcutMap({ ...DEFAULT_SHORTCUTS, 'view.todo': 'Mod+Shift+U' })).toBe(false);
  });
});

describe('默认绑定表', () => {
  it('动作 id 唯一', () => {
    const ids = SHORTCUT_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('默认绑定互不冲突', () => {
    const used = new Map<string, string>();
    for (const action of SHORTCUT_ACTIONS) {
      if (!action.defaultBinding) continue;
      const normalized = normalizeBinding(action.defaultBinding);
      expect(normalized).not.toBeNull();
      expect(used.has(normalized as string)).toBe(false);
      used.set(normalized as string, action.id);
    }
  });

  it('默认绑定都可用（带修饰键且未被系统占用）', () => {
    for (const action of SHORTCUT_ACTIONS) {
      if (!action.defaultBinding) continue;
      expect(isBindableBinding(action.defaultBinding)).toBe(true);
      expect(isReservedBinding(action.defaultBinding, true)).toBe(false);
      expect(isReservedBinding(action.defaultBinding, false)).toBe(false);
    }
  });
});

describe('matchesShortcutQuery', () => {
  it('空查询命中，大小写不敏感', () => {
    expect(matchesShortcutQuery(['新建会话'], '')).toBe(true);
    expect(matchesShortcutQuery(['Session', '⌘N'], '⌘n')).toBe(true);
    expect(matchesShortcutQuery(['session'], 'terminal')).toBe(false);
  });
});
