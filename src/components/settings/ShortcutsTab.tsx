import { useEffect, useMemo, useRef, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORIES,
  bindingFromKeyboardEvent,
  findShortcutConflict,
  formatBinding,
  isBindableBinding,
  isDefaultShortcutMap,
  isReservedBinding,
  matchesBinding,
  matchesShortcutQuery,
  normalizeBinding,
  type ShortcutActionId,
  type ShortcutCategory,
  type ShortcutMap
} from '../../lib/shortcuts';

const CATEGORY_LABEL: Record<ShortcutCategory, string> = {
  session: t.shortcutsCategorySession,
  view: t.shortcutsCategoryView,
  chat: t.shortcutsCategoryChat
};

/** 动作展示文案（id 未在 i18n 里登记时退化为 id，避免整页崩掉） */
function actionText(id: ShortcutActionId): { label: string; desc: string } {
  return t.shortcutActionText[id] ?? { label: id, desc: '' };
}

/** 重复绑定检测（手改 ui-config.json 才可能出现，UI 保存前已拦） */
function collectConflictIds(map: ShortcutMap): Set<string> {
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const value = map[action.id];
    if (!value) continue;
    const normalized = normalizeBinding(value);
    if (!normalized) continue;
    const previous = seen.get(normalized);
    if (previous) {
      conflicts.add(previous);
      conflicts.add(action.id);
    } else {
      seen.set(normalized, action.id);
    }
  }
  return conflicts;
}

/**
 * 设置页 - 键盘快捷键 tab。
 *
 * 交互参照 Codex 的快捷键面板：顶部「全部重置为默认值」+ 搜索框、一块数字快捷键设置、
 * 下方按分类分组的逐条绑定列表（按键胶囊 / 改键 / 恢复默认 / 清除）。
 *
 * 录键期间通过 store 的 `shortcutCaptureId` 让全局监听（useGlobalShortcuts）让路，
 * 否则「按 ⌘N 改键」会顺手新建一个会话。
 */
export default function ShortcutsTab() {
  const shortcuts = usePiStore((s) => s.shortcuts);
  const setShortcut = usePiStore((s) => s.setShortcut);
  const resetShortcut = usePiStore((s) => s.resetShortcut);
  const resetAllShortcuts = usePiStore((s) => s.resetAllShortcuts);
  const shortcutNumberKeys = usePiStore((s) => s.shortcutNumberKeys);
  const setShortcutNumberKeys = usePiStore((s) => s.setShortcutNumberKeys);
  const setShortcutCaptureId = usePiStore((s) => s.setShortcutCaptureId);
  const showToast = usePiStore((s) => s.showToast);

  const isMac = window.pi?.platform === 'darwin';
  const modLabel = isMac ? '⌘' : 'Ctrl';

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<ShortcutActionId | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const conflictIds = useMemo(() => collectConflictIds(shortcuts), [shortcuts]);
  const allDefault = useMemo(() => isDefaultShortcutMap(shortcuts), [shortcuts]);

  // 录键期间让全局快捷键让路（组件卸载/切行时自动恢复）
  useEffect(() => {
    setShortcutCaptureId(editingId);
    return () => setShortcutCaptureId(null);
  }, [editingId, setShortcutCaptureId]);

  // 打开 tab 即聚焦搜索框；⌘F / Ctrl+F 在 tab 内也可聚焦
  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // 录键中：Mod+F 让给改键流程（否则会一边改绑一边把焦点丢回搜索框）
      if (usePiStore.getState().shortcutCaptureId) return;
      if (!matchesBinding('Mod+F', event, isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isMac]);

  // 录键：捕获阶段吞掉按键，Esc 取消，⌫/Delete 清除
  useEffect(() => {
    if (!editingId) return;
    const finish = (binding: string | null) => {
      if (binding === null) {
        setEditingId(null);
        setHint(null);
        return;
      }
      const label = actionText(editingId).label;
      setShortcut(editingId, binding);
      setEditingId(null);
      setHint(null);
      showToast(
        binding
          ? t.shortcutsAssigned(label, formatBinding(binding, isMac))
          : t.shortcutsClearDone(label),
        { variant: 'success' }
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 录键时不允许任何按键落到其他地方（含全局监听、本 tab 的 Mod+F、下拉菜单）：
      // window 上的多个监听互不影响，只有 stopImmediatePropagation 能挡住后续监听
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.key === 'Escape') {
        finish(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        finish('');
        return;
      }
      // 只按修饰键：继续等待主键
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
        setHint(t.shortcutsNeedKey);
        return;
      }

      const binding = bindingFromKeyboardEvent(event, isMac);
      if (!binding) {
        setHint(t.shortcutsNeedKey);
        return;
      }
      if (!isBindableBinding(binding)) {
        setHint(t.shortcutsNeedModifier);
        return;
      }
      if (isReservedBinding(binding, isMac)) {
        setHint(t.shortcutsReserved);
        return;
      }
      const conflictId = findShortcutConflict(binding, shortcuts, editingId);
      if (conflictId) {
        setHint(t.shortcutsConflict(actionText(conflictId).label));
        return;
      }
      finish(binding);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [editingId, shortcuts, isMac, setShortcut, showToast]);

  const startEditing = (id: ShortcutActionId) => {
    setHint(null);
    setEditingId((current) => (current === id ? null : id));
  };

  const handleClear = (id: ShortcutActionId) => {
    setEditingId(null);
    setHint(null);
    setShortcut(id, '');
    showToast(t.shortcutsClearDone(actionText(id).label), { variant: 'success' });
  };

  const handleResetOne = (id: ShortcutActionId) => {
    setEditingId(null);
    setHint(null);
    resetShortcut(id);
    const fallback = DEFAULT_SHORTCUTS[id];
    showToast(
      fallback
        ? t.shortcutsAssigned(actionText(id).label, formatBinding(fallback, isMac))
        : t.shortcutsClearDone(actionText(id).label),
      { variant: 'success' }
    );
  };

  const handleResetAll = () => {
    setEditingId(null);
    setHint(null);
    resetAllShortcuts();
    showToast(t.shortcutsResetAllDone, { variant: 'success' });
  };

  const visibleActions = (category: ShortcutCategory) =>
    SHORTCUT_ACTIONS.filter((action) => {
      if (action.category !== category) return false;
      const text = actionText(action.id);
      const binding = shortcuts[action.id] ?? '';
      return matchesShortcutQuery(
        [
          text.label,
          text.desc,
          binding ? formatBinding(binding, isMac) : t.shortcutsUnassigned,
          binding
        ],
        query
      );
    });

  const hasResults = SHORTCUT_CATEGORIES.some((category) => visibleActions(category).length > 0);

  return (
    <div>
      {/* 标题 + 全部重置 */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-od-text">{t.shortcutsTitle}</h3>
          <div className="mt-1 text-xs leading-relaxed text-od-text-dim">{t.shortcutsDesc}</div>
        </div>
        <button
          type="button"
          onClick={handleResetAll}
          disabled={allDefault}
          className="shrink-0 rounded border border-od-border bg-od-bg-alt px-2.5 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover active:bg-od-border disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t.shortcutsResetAll}
        </button>
      </div>

      {/* 搜索：全局 `input:focus` 的 1px accent 阴影在这里很吵，用 focus:shadow-none 局部取消，
          输入态只用更亮的描边提示 */}
      <div className="mb-4 flex items-center gap-2 rounded border border-od-border bg-od-bg-alt px-2.5 py-1.5 focus-within:border-od-border-light">
        <Icon name="search" className="w-3 shrink-0 text-od-text-dim" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setQuery('');
            }
          }}
          placeholder={t.shortcutsSearch}
          aria-label={t.shortcutsSearch}
          className="min-w-0 flex-1 bg-transparent text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-transparent focus:shadow-none focus:outline-none"
        />
        {/* 与 SessionSearchModal 的按键胶囊、列表里的绑定胶囊同尺寸（text-xs）：
            ⌘(U+2318) 是细笔画符号字形，字号再小一档就只剩一笔模糊的圈，看着像“缩小了” */}
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t.cancel}
            title={t.cancel}
            className="shrink-0 rounded p-0.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="close" className="w-3" />
          </button>
        ) : (
          <kbd className="shrink-0 rounded-md border border-od-border-light px-1.5 py-0.5 text-xs text-od-text-dim">
            {formatBinding('Mod+F', isMac)}
          </kbd>
        )}
      </div>

      {/* 数字快捷键 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm text-od-text-bright">{t.shortcutsNumberKeys}</div>
          <div className="mt-0.5 text-xs text-od-text-dim">
            {t.shortcutsNumberKeysDesc(modLabel)}
          </div>
        </div>
        <Dropdown
          value={shortcutNumberKeys}
          onChange={(value) => setShortcutNumberKeys(value as 'workspace' | 'off')}
          options={[
            {
              value: 'workspace',
              label: t.shortcutsNumberKeysWorkspace(modLabel)
            },
            { value: 'off', label: t.shortcutsNumberKeysOff }
          ]}
          ariaLabel={t.shortcutsNumberKeys}
          align="right"
        />
      </div>

      {/* 分类列表 */}
      {SHORTCUT_CATEGORIES.map((category) => {
        const actions = visibleActions(category);
        if (actions.length === 0) return null;
        return (
          <div
            key={category}
            className="mb-4 overflow-hidden rounded border border-od-border bg-od-bg-alt"
          >
            <div className="border-b border-od-border px-3 py-2 text-xs font-semibold text-od-text">
              {CATEGORY_LABEL[category]}
            </div>
            <div className="divide-y divide-od-border">
              {actions.map((action) => {
                const text = actionText(action.id);
                const binding = shortcuts[action.id] ?? '';
                const recording = editingId === action.id;
                const hasConflict = conflictIds.has(action.id);
                const formatted = binding ? formatBinding(binding, isMac) : '';
                const canReset = binding !== DEFAULT_SHORTCUTS[action.id];
                return (
                  <div
                    key={action.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-od-text-bright">{text.label}</span>
                        {hasConflict ? (
                          <span className="shrink-0 rounded bg-od-red/15 px-1 py-0.5 text-[0.7rem] text-od-red">
                            {t.shortcutsConflictBadge}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-od-text-dim">
                        {recording && hint ? (
                          <span className="text-od-red">{hint}</span>
                        ) : (
                          text.desc
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center">
                      {/* 按键胶囊：参照 Codex —— 圆角、无描边、浅色底；录键态换主题色 */}
                      <button
                        type="button"
                        onClick={() => startEditing(action.id)}
                        title={recording ? t.shortcutsEscHint : t.shortcutsEdit}
                        aria-label={`${text.label} ${t.shortcutsEdit}`}
                        aria-pressed={recording}
                        className={`min-w-[4.5rem] rounded-full px-3 py-1 text-center text-xs font-medium transition-colors ${
                          recording
                            ? 'bg-od-accent/15 text-od-accent ring-1 ring-od-accent ring-inset'
                            : binding
                              ? 'bg-od-bg-hover text-od-text-bright hover:bg-od-border active:bg-od-border-light'
                              : 'text-od-text-dim ring-1 ring-od-border ring-inset hover:bg-od-bg-hover hover:text-od-text'
                        }`}
                      >
                        {recording ? t.shortcutsRecording : formatted || t.shortcutsUnassigned}
                      </button>
                      <div className="ml-2 flex items-center">
                        <button
                          type="button"
                          onClick={() => handleResetOne(action.id)}
                          disabled={!canReset}
                          title={t.shortcutsRestoreDefault}
                          aria-label={`${text.label} ${t.shortcutsRestoreDefault}`}
                          className="rounded-md p-1.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:cursor-not-allowed disabled:opacity-25"
                        >
                          <Icon name="rotate" className="w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleClear(action.id)}
                          disabled={!binding}
                          title={t.shortcutsClear}
                          aria-label={`${text.label} ${t.shortcutsClear}`}
                          className="rounded-md p-1.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-red disabled:cursor-not-allowed disabled:opacity-25"
                        >
                          <Icon name="delete" className="w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {!hasResults && (
        <div className="rounded border border-od-border bg-od-bg-alt px-3 py-6 text-center text-xs text-od-text-dim">
          {t.shortcutsSearchEmpty}
        </div>
      )}

      <div className="text-xs text-od-text-dim">{t.shortcutsEscHint}</div>
    </div>
  );
}
