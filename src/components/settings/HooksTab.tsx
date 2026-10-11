import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import ConfirmDialog from '../common/ConfirmDialog';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { HookConfig, HookEvent } from '../../types/pi';

/**
 * 设置页 - 钩子 tab：
 * 按 5 组生命周期事件展示 pi SDK 的 18 种可挂载事件，每组可添加/编辑/删除/启停
 * shell 钩子。配置实时落盘 ~/.pi-desktop/hooks.json，主进程 runner 每次事件实时
 * 重读，改动立即生效。
 *
 * 能力标注（与主进程 runner 语义一致）：
 * - 可阻止：退出码 2 → 阻止该动作，stderr 反馈给模型
 * - 可改写：退出码 0 且 stdout 非空 → 替换输入文本（input 事件）
 */

interface EventMeta {
  event: HookEvent;
  label: string;
  desc: string;
  /** 可阻止（退出码 2） */
  blockable?: boolean;
  /** 可改写（stdout 替换文本） */
  transformable?: boolean;
}

interface GroupMeta {
  title: string;
  events: EventMeta[];
}

const GROUPS: GroupMeta[] = [
  {
    title: t.hooks.groupInput,
    events: [
      {
        event: 'input',
        label: t.hooks.eventInput,
        desc: t.hooks.eventInputDesc,
        blockable: true,
        transformable: true
      },
      {
        event: 'before_agent_start',
        label: t.hooks.eventBeforeAgentStart,
        desc: t.hooks.eventBeforeAgentStartDesc
      },
      { event: 'message_end', label: t.hooks.eventMessageEnd, desc: t.hooks.eventMessageEndDesc }
    ]
  },
  {
    title: t.hooks.groupAgent,
    events: [
      { event: 'agent_start', label: t.hooks.eventAgentStart, desc: t.hooks.eventAgentStartDesc },
      { event: 'agent_end', label: t.hooks.eventAgentEnd, desc: t.hooks.eventAgentEndDesc },
      {
        event: 'agent_settled',
        label: t.hooks.eventAgentSettled,
        desc: t.hooks.eventAgentSettledDesc
      }
    ]
  },
  {
    title: t.hooks.groupTool,
    events: [
      {
        event: 'tool_call',
        label: t.hooks.eventToolCall,
        desc: t.hooks.eventToolCallDesc,
        blockable: true
      },
      { event: 'tool_result', label: t.hooks.eventToolResult, desc: t.hooks.eventToolResultDesc }
    ]
  },
  {
    title: t.hooks.groupSession,
    events: [
      {
        event: 'session_start',
        label: t.hooks.eventSessionStart,
        desc: t.hooks.eventSessionStartDesc
      },
      {
        event: 'session_before_compact',
        label: t.hooks.eventSessionBeforeCompact,
        desc: t.hooks.eventSessionBeforeCompactDesc,
        blockable: true
      },
      {
        event: 'session_compact',
        label: t.hooks.eventSessionCompact,
        desc: t.hooks.eventSessionCompactDesc
      },
      {
        event: 'session_before_switch',
        label: t.hooks.eventSessionBeforeSwitch,
        desc: t.hooks.eventSessionBeforeSwitchDesc,
        blockable: true
      },
      {
        event: 'session_before_fork',
        label: t.hooks.eventSessionBeforeFork,
        desc: t.hooks.eventSessionBeforeForkDesc,
        blockable: true
      },
      {
        event: 'session_shutdown',
        label: t.hooks.eventSessionShutdown,
        desc: t.hooks.eventSessionShutdownDesc
      }
    ]
  },
  {
    title: t.hooks.groupProvider,
    events: [
      {
        event: 'before_provider_request',
        label: t.hooks.eventBeforeProviderRequest,
        desc: t.hooks.eventBeforeProviderRequestDesc
      },
      {
        event: 'after_provider_response',
        label: t.hooks.eventAfterProviderResponse,
        desc: t.hooks.eventAfterProviderResponseDesc
      },
      {
        event: 'model_select',
        label: t.hooks.eventModelSelect,
        desc: t.hooks.eventModelSelectDesc
      },
      {
        event: 'thinking_level_select',
        label: t.hooks.eventThinkingLevelSelect,
        desc: t.hooks.eventThinkingLevelSelectDesc
      }
    ]
  }
];

export default function HooksTab() {
  const [hooks, setHooks] = useState<HookConfig[] | null>(null);
  /** 编辑弹窗：null 关闭 */
  const [editing, setEditing] = useState<{ hook: Partial<HookConfig>; isNew: boolean } | null>(
    null
  );
  const [confirmDelete, setConfirmDelete] = useState<HookConfig | null>(null);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    try {
      const list = await window.pi.getHooks();
      setHooks(Array.isArray(list) ? list : []);
    } catch {
      setHooks([]);
    }
  };

  const toggleEnabled = async (hook: HookConfig, enabled: boolean) => {
    // 乐观更新，失败回滚
    setHooks((prev) => (prev ? prev.map((h) => (h.id === hook.id ? { ...h, enabled } : h)) : prev));
    try {
      const res = await window.pi.setHookEnabled(hook.id, enabled);
      if (!res.ok) throw new Error(res.error);
    } catch {
      setHooks((prev) =>
        prev ? prev.map((h) => (h.id === hook.id ? { ...h, enabled: hook.enabled } : h)) : prev
      );
    }
  };

  const performDelete = async () => {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      await window.pi.deleteHook(target.id);
    } catch {}
    await load();
  };

  return (
    <div>
      {/* 说明卡片 */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.hooks.title}</h3>
        <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Icon name="hook" className="mt-0.5 w-3 shrink-0 text-od-accent" />
            <div className="text-xs leading-relaxed text-od-text-dim">{t.hooks.desc}</div>
          </div>
        </div>
      </div>

      {/* 按事件分组 */}
      {GROUPS.map((group) => (
        <div key={group.title} className="mb-4">
          <div className="mb-2 flex items-center gap-2 border-b border-od-border pb-1.5">
            <span className="text-xs font-semibold text-od-text">{group.title}</span>
            <span className="text-xs text-od-text-dim">
              {t.hooks.hookCount(
                (hooks ?? []).filter((h) => group.events.some((e) => e.event === h.event)).length
              )}
            </span>
          </div>

          <div className="space-y-2">
            {group.events.map(({ event, label, desc, blockable, transformable }) => {
              const list = (hooks ?? []).filter((h) => h.event === event);
              return (
                <div key={event} className="rounded border border-od-border bg-od-bg-alt">
                  {/* 事件标题行 */}
                  <div className="flex items-center justify-between gap-2 border-b border-od-border px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <code className="rounded bg-od-bg px-1.5 py-0.5 font-mono text-xs text-od-text-bright">
                        {label}
                      </code>
                      <span className="truncate text-xs text-od-text-dim">{desc}</span>
                      {blockable && (
                        <span className="rounded bg-od-accent/15 px-1.5 py-0.5 text-xs text-od-accent">
                          可阻止
                        </span>
                      )}
                      {transformable && (
                        <span className="rounded bg-od-accent/15 px-1.5 py-0.5 text-xs text-od-accent">
                          可改写
                        </span>
                      )}
                      {hooks && list.length > 0 && (
                        <span className="rounded bg-od-bg-hover px-1.5 py-0.5 text-xs text-od-text-dim">
                          {t.hooks.hookCount(list.length)}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => setEditing({ hook: { event }, isNew: true })}
                      className="flex shrink-0 items-center gap-1 rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
                    >
                      <Icon name="plus" className="w-3" />
                      {t.hooks.addHook}
                    </button>
                  </div>

                  {/* 钩子列表 */}
                  {list.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-od-text-dim/70">{t.hooks.empty}</div>
                  ) : (
                    <div className="divide-y divide-od-border">
                      {list.map((hook) => (
                        <div
                          key={hook.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-od-text-bright">{hook.name}</div>
                            <div
                              className="truncate font-mono text-xs text-od-text-dim"
                              title={hook.command}
                            >
                              {hook.command}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-od-text-dim">{hook.timeoutSec}s</span>
                            <Switch
                              checked={hook.enabled}
                              onChange={(v) => toggleEnabled(hook, v)}
                            />
                            <button
                              onClick={() => setEditing({ hook: { ...hook }, isNew: false })}
                              className="rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
                              title={t.hooks.editHook}
                            >
                              <Icon name="edit2" className="w-3" />
                            </button>
                            <button
                              onClick={() => setConfirmDelete(hook)}
                              className="rounded border border-od-border-light px-2 py-1 text-xs text-od-red transition-colors hover:bg-od-bg-hover"
                              title={t.delete}
                            >
                              <Icon name="delete" className="w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* 添加/编辑弹窗 */}
      {editing && (
        <HookEditModal
          initial={editing.hook}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t.delete}
        message={confirmDelete ? t.hooks.deleteConfirm(confirmDelete.name) : ''}
        confirmText={t.delete}
        danger
        onConfirm={performDelete}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** 添加/编辑钩子弹窗：名称/事件/命令/超时/启用，Esc 关闭 */
function HookEditModal({
  initial,
  isNew,
  onClose,
  onSaved
}: {
  initial: Partial<HookConfig>;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [event, setEvent] = useState<HookEvent>(initial.event ?? 'tool_call');
  const [command, setCommand] = useState(initial.command ?? '');
  const [timeoutSec, setTimeoutSec] = useState<number>(initial.timeoutSec ?? 60);
  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const showToast = usePiStore((state) => state.showToast);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const handleSave = async () => {
    if (saving) return;
    if (!command.trim()) {
      setError(t.hooks.invalidCommand);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await window.pi.upsertHook({
        id: initial.id,
        event,
        name: name.trim(),
        command: command.trim(),
        timeoutSec: Math.max(1, Math.floor(timeoutSec) || 60),
        enabled
      });
      if (!res.ok) throw new Error(res.error);
      onSaved();
      onClose();
    } catch (e: any) {
      // 必填校验仍内联（指向命令输入框），保存失败改 toast
      showToast(t.hooks.saveFailed(String(e?.message || e)), { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,90vw)] rounded-lg border border-od-border bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="hook" className="w-3.5 text-od-accent" />
            {isNew ? t.hooks.addHook : t.hooks.editHook}
          </div>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="close" size="xs" />
          </button>
        </div>

        {/* 表单 */}
        <div className="space-y-3 px-4 py-3">
          {/* 名称 */}
          <div>
            <label className="mb-1 block text-xs text-od-text">{t.hooks.nameLabel}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.hooks.namePlaceholder}
              className="w-full rounded border border-od-border-light bg-od-bg px-2.5 py-1.5 text-xs text-od-text-bright outline-none focus:border-od-accent"
            />
          </div>
          {/* 事件 + 超时 */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-od-text">Event</label>
              <Dropdown
                className="w-full"
                fullWidth
                value={event}
                onChange={(v) => setEvent(v as HookEvent)}
                disabled={!isNew}
                triggerClassName="flex w-full items-center justify-between gap-2 rounded border border-od-border-light bg-od-bg px-2 py-1.5 text-xs text-od-text-bright outline-none transition-colors hover:bg-od-bg-hover focus:border-od-accent disabled:cursor-not-allowed disabled:opacity-60"
                panelWidth="w-full"
                ariaLabel="Event"
                groups={GROUPS.map((g) => ({
                  label: g.title,
                  options: g.events.map((e) => ({
                    value: e.event,
                    label: `${e.label}${e.blockable ? '（可阻止）' : ''}${
                      e.transformable ? '（可改写）' : ''
                    }`
                  }))
                }))}
              />
            </div>
            <div className="w-36">
              <label className="mb-1 block text-xs text-od-text">{t.hooks.timeoutLabel}</label>
              <input
                type="number"
                min={1}
                max={3600}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full rounded border border-od-border-light bg-od-bg px-2.5 py-1.5 text-xs text-od-text-bright outline-none focus:border-od-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>
          {/* 命令 */}
          <div>
            <label className="mb-1 block text-xs text-od-text">{t.hooks.commandLabel}</label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t.hooks.commandPlaceholder}
              spellCheck={false}
              rows={3}
              className="w-full resize-none rounded border border-od-border-light bg-od-bg px-2.5 py-1.5 font-mono text-xs text-od-text-bright outline-none focus:border-od-accent"
            />
          </div>
          {/* 启用 */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-od-text">{t.hooks.enabledLabel}</span>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between border-t border-od-border px-4 py-2.5">
          <div className="min-w-0 truncate text-xs text-od-red">{error}</div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClose}
              className="rounded border border-od-border-light px-3 py-1.5 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
            >
              {t.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded bg-od-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-od-accent/80 disabled:opacity-50"
            >
              {saving ? t.memory.savingFile : t.memory.saveFile}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
