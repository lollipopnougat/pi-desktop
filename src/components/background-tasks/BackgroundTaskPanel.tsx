import { useEffect, useState } from 'react';
import type {
  BackgroundTaskLogResult,
  BackgroundTaskSnapshot,
  BackgroundTaskStatus
} from '../../types/pi';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import Icon from '../common/Icon';
import ConfirmDialog from '../common/ConfirmDialog';
import type { IconName } from '../common/icons';

const STATUS_META: Record<BackgroundTaskStatus, { icon: IconName; color: string; label: string }> =
  {
    running: { icon: 'spinner', color: 'text-od-accent', label: t.backgroundTasks.statusRunning },
    completed: {
      icon: 'circleCheck',
      color: 'text-od-green',
      label: t.backgroundTasks.statusCompleted
    },
    failed: {
      icon: 'circleExclamation',
      color: 'text-od-red',
      label: t.backgroundTasks.statusFailed
    },
    killed: { icon: 'stop', color: 'text-od-text-dim', label: t.backgroundTasks.statusKilled },
    interrupted: {
      icon: 'warning',
      color: 'text-od-yellow',
      label: t.backgroundTasks.statusInterrupted
    }
  };

function durationMs(task: BackgroundTaskSnapshot): number {
  return Math.max(0, (task.endTime ?? Date.now()) - task.startTime);
}

function BackgroundTaskCard({
  task,
  onOpen,
  onDelete,
  foreign = false
}: {
  task: BackgroundTaskSnapshot;
  onOpen: () => void;
  /** 删除该任务记录；未传表示不可删除（任务仍在运行） */
  onDelete?: () => void;
  /** true 表示该任务属于其他会话（仅在「全部」范围下可能为 true） */
  foreign?: boolean;
}) {
  const meta = STATUS_META[task.status];
  const running = task.status === 'running';

  const stop = async () => {
    if (!confirm(t.backgroundTasks.stopConfirm)) return;
    await window.pi.backgroundTasks.kill(task.id);
  };

  return (
    <div className="rounded-md border border-od-border bg-od-bg px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Icon name={meta.icon} spin={running} className={`w-3 shrink-0 ${meta.color}`} />
        <span className={`shrink-0 text-xs font-medium ${meta.color}`}>{meta.label}</span>
        <button
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left text-xs font-medium text-od-text-bright"
          title={t.backgroundTasks.openDetail}
        >
          {task.name}
        </button>
        {foreign && (
          <span
            className="shrink-0 rounded bg-od-bg-dark px-1.5 font-mono text-xs text-od-text-dim/70"
            title={t.backgroundTasks.otherSession}
          >
            {task.sessionId.slice(0, 6)}
          </span>
        )}
        {task.isAgent && (
          <span className="shrink-0 rounded bg-od-bg-dark px-1.5 text-xs text-od-text-dim">
            {t.backgroundTasks.agentBadge}
          </span>
        )}
        {running && (
          <button
            onClick={() => void stop()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-red"
            title={t.backgroundTasks.stopTask}
          >
            <Icon name="stop" className="w-2.5" />
          </button>
        )}
        {onDelete ? (
          <button
            onClick={onDelete}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-red"
            title={t.backgroundTasks.deleteTask}
          >
            <Icon name="delete" className="w-2.5" />
          </button>
        ) : (
          <button
            disabled
            className="flex h-5 w-5 shrink-0 cursor-not-allowed items-center justify-center rounded text-od-text-dim opacity-40"
            title={running ? t.backgroundTasks.deleteRunning : t.backgroundTasks.deleteTask}
          >
            <Icon name="delete" className="w-2.5" />
          </button>
        )}
      </div>
      <button onClick={onOpen} className="mt-1 block w-full text-left">
        <div className="line-clamp-2 font-mono text-xs leading-relaxed text-od-text-dim">
          {task.command}
        </div>
        <div className="mt-1 flex gap-3 text-xs text-od-text-dim/70">
          <span>{t.backgroundTasks.elapsedLabel(durationMs(task))}</span>
          <span>{t.backgroundTasks.bytesLabel(task.bytesWritten)}</span>
          {task.exitCode !== undefined && (
            <span>{t.backgroundTasks.exitCodeLabel(task.exitCode)}</span>
          )}
        </div>
      </button>
      {task.error && task.status !== 'running' && (
        <div className="mt-1 line-clamp-2 text-xs text-od-red">{task.error}</div>
      )}
    </div>
  );
}

function BackgroundTaskDetail({
  task,
  onClose
}: {
  task: BackgroundTaskSnapshot;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<BackgroundTaskLogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const meta = STATUS_META[task.status];

  const loadLogs = async () => {
    setLoading(true);
    setError('');
    try {
      setLogs(await window.pi.backgroundTasks.readLogs(task.id, { tail: true, maxBytes: 51200 }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void window.pi.backgroundTasks
      .readLogs(task.id, { tail: true, maxBytes: 51200 })
      .then((result) => {
        if (active) setLogs(result);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.id, task.status]);

  const stop = async () => {
    if (!confirm(t.backgroundTasks.stopConfirm)) return;
    await window.pi.backgroundTasks.kill(task.id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ paddingTop: window.pi.platform === 'darwin' ? 38 : 32 }}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-od-border px-4 py-2.5">
          <Icon
            name={meta.icon}
            spin={task.status === 'running'}
            className={`w-3.5 shrink-0 ${meta.color}`}
          />
          <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
          <span className="truncate text-sm font-semibold text-od-text-bright">{task.name}</span>
          <div className="flex-1" />
          {task.status === 'running' && (
            <button
              onClick={() => void stop()}
              className="rounded px-2 py-1 text-xs text-od-red transition-colors hover:bg-od-bg-hover"
            >
              {t.backgroundTasks.stopTask}
            </button>
          )}
        </div>

        <div className="grid shrink-0 gap-2 border-b border-od-border px-4 py-3 text-xs md:grid-cols-2">
          <div className="min-w-0">
            <div className="text-od-text-dim">{t.backgroundTasks.commandLabel}</div>
            <div className="break-all font-mono text-od-text">{task.command}</div>
          </div>
          <div className="min-w-0">
            <div className="text-od-text-dim">{t.backgroundTasks.cwdLabel}</div>
            <div className="truncate font-mono text-od-text" title={task.cwd}>
              {task.cwd}
            </div>
          </div>
          <div>
            <span className="text-od-text-dim">{t.backgroundTasks.taskIdLabel}: </span>
            <span className="font-mono text-od-text">{task.id}</span>
          </div>
          <div className="flex gap-3">
            <span>{t.backgroundTasks.elapsedLabel(durationMs(task))}</span>
            <span>{t.backgroundTasks.bytesLabel(task.bytesWritten)}</span>
            {task.exitCode !== undefined && (
              <span>{t.backgroundTasks.exitCodeLabel(task.exitCode)}</span>
            )}
          </div>
          {task.error && (
            <div className="rounded border border-od-red/40 px-2 py-1 text-od-red md:col-span-2">
              {task.error}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center border-b border-od-border px-4 py-2">
          <span className="text-xs font-medium text-od-text-bright">
            {t.backgroundTasks.logLabel}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => void loadLogs()}
            disabled={loading}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-50"
          >
            <Icon name="rotate" spin={loading} className="w-3" />
            {t.backgroundTasks.refreshLogs}
          </button>
          <button
            onClick={() => void window.pi.showInFolder(task.outputPath)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="folder" className="w-3" />
            {t.backgroundTasks.outputPathLabel}
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-od-bg-dark p-4">
          {loading && !logs ? (
            <div className="text-xs text-od-text-dim">{t.backgroundTasks.loadingLogs}</div>
          ) : error ? (
            <div className="text-xs text-od-red">{error}</div>
          ) : (
            <>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-od-text">
                {logs?.content || t.backgroundTasks.noLogs}
              </pre>
              {logs?.truncated && (
                <div className="mt-3 text-xs text-od-text-dim">
                  {t.backgroundTasks.logTruncated}
                  <span className="ml-1 font-mono">{logs.outputPath}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 后台任务列表（右侧工作区的「后台任务」标签）。
 *
 * 原来是聊天头部旁边的固定弹层；搬到工作区后可以拖宽、看长命令行与日志文件名，
 * 也避免与子 agent / 记忆面板叠成三层浮窗。
 */
export default function BackgroundTaskPanel() {
  const snapshot = usePiStore((state) => state.backgroundTaskSnapshot);
  const sessionId = usePiStore((state) => state.sessionId);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const [scope, setScope] = useState<'session' | 'all'>('session');
  /** 等待确认的删除目标：单条（label 为任务名）或当前范围全部已结束任务 */
  const [pendingRemove, setPendingRemove] = useState<{
    ids: string[];
    label: string;
    bulk: boolean;
  } | null>(null);
  const [removing, setRemoving] = useState(false);
  const allTasks = snapshot?.tasks ?? [];
  // 作用域过滤：默认只看当前会话的任务，任务记录自带 sessionId（见 electron/background-tasks/types.ts）
  const tasks =
    scope === 'session' ? allTasks.filter((task) => task.sessionId === sessionId) : allTasks;
  const activeCount = tasks.filter((task) => task.status === 'running').length;
  // 只允许清理已结束的任务：运行中的任务删掉记录会丢失子进程句柄
  const removable = tasks.filter((task) => task.status !== 'running');

  useEffect(() => {
    void window.pi.backgroundTasks
      .getSnapshot()
      .then((next) => usePiStore.getState().setBackgroundTaskSnapshot(next))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeCount === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeCount]);

  const detailTask = detailTaskId ? allTasks.find((task) => task.id === detailTaskId) : null;

  /** 刷新主进程快照（删除后主进程也会推送，这里保证时序上立即生效） */
  const refreshSnapshot = async () => {
    try {
      const next = await window.pi.backgroundTasks.getSnapshot();
      usePiStore.getState().setBackgroundTaskSnapshot(next);
    } catch {
      // 主进程不可用时保留现有快照
    }
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      const result = await window.pi.backgroundTasks.remove(pendingRemove.ids);
      await refreshSnapshot();
      if (result.removed.length === pendingRemove.ids.length) {
        usePiStore
          .getState()
          .showToast(t.backgroundTasks.cleanupDone(result.removed.length), { variant: 'success' });
      } else {
        const detail = result.failed.map((item) => item.error).join('; ') || result.error || '';
        if (result.removed.length === 0) {
          usePiStore
            .getState()
            .showToast(t.backgroundTasks.cleanupFailed(detail), { variant: 'error' });
        } else {
          usePiStore
            .getState()
            .showToast(t.backgroundTasks.cleanupPartial(result.removed.length, detail), {
              variant: 'warning'
            });
        }
      }
    } catch (error) {
      usePiStore
        .getState()
        .showToast(
          t.backgroundTasks.cleanupFailed(error instanceof Error ? error.message : String(error)),
          { variant: 'error' }
        );
    } finally {
      setRemoving(false);
      setPendingRemove(null);
    }
  };

  const requestRemove = (ids: string[], label: string, bulk: boolean) => {
    if (ids.length === 0) return;
    setPendingRemove({ ids, label, bulk });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-od-bg-dark">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-od-border bg-od-bg-alt px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-od-text-bright">
          <Icon name="backgroundTasks" className="w-3 shrink-0" />
          <span className="shrink-0">{t.backgroundTasks.panelTitle}</span>
          {activeCount > 0 && (
            <span className="shrink-0 rounded bg-od-bg-dark px-1.5 text-xs text-od-accent">
              {activeCount}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() =>
              requestRemove(
                removable.map((task) => task.id),
                '',
                true
              )
            }
            disabled={removable.length === 0}
            className="flex items-center gap-1 rounded border border-od-border bg-od-bg-dark px-1.5 py-0.5 text-xs text-od-text-dim transition-colors hover:border-od-red hover:text-od-red disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-od-border disabled:hover:text-od-text-dim"
            title={
              removable.length === 0
                ? t.backgroundTasks.cleanupEmpty
                : t.backgroundTasks.cleanupTitle
            }
          >
            <Icon name="delete" className="w-2.5" />
            <span>
              {t.backgroundTasks.cleanup}
              {removable.length > 0 ? ` (${removable.length})` : ''}
            </span>
          </button>
          <div
            className="flex items-center rounded border border-od-border bg-od-bg-dark p-0.5"
            title={t.backgroundTasks.scopeTitle}
          >
            {(['session', 'all'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setScope(value)}
                className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                  scope === value
                    ? 'bg-od-bg-hover text-od-text-bright'
                    : 'text-od-text-dim hover:text-od-text-bright'
                }`}
                title={
                  value === 'session'
                    ? t.backgroundTasks.showCurrentSession
                    : t.backgroundTasks.showAllSessions
                }
              >
                {value === 'session' ? t.backgroundTasks.scopeSession : t.backgroundTasks.scopeAll}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
            <Icon name="backgroundTasks" className="mb-2 w-8 text-od-text-dim" />
            <p className="text-xs text-od-text-dim">
              {scope === 'session'
                ? t.backgroundTasks.panelEmptySession
                : t.backgroundTasks.panelEmpty}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-1.5">
            {tasks.map((task) => (
              <BackgroundTaskCard
                key={task.id}
                task={task}
                foreign={task.sessionId !== sessionId}
                onDelete={
                  task.status === 'running'
                    ? undefined
                    : () => requestRemove([task.id], task.name, false)
                }
                onOpen={() => setDetailTaskId(task.id)}
              />
            ))}
          </div>
        )}
      </div>
      {detailTask && (
        <BackgroundTaskDetail task={detailTask} onClose={() => setDetailTaskId(null)} />
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        danger
        loading={removing}
        title={pendingRemove?.bulk ? t.backgroundTasks.cleanupTitle : t.backgroundTasks.deleteTitle}
        message={
          pendingRemove
            ? pendingRemove.bulk
              ? t.backgroundTasks.cleanupMessage(pendingRemove.ids.length)
              : t.backgroundTasks.deleteMessage(pendingRemove.label)
            : undefined
        }
        confirmText={
          pendingRemove?.bulk ? t.backgroundTasks.cleanupConfirm : t.backgroundTasks.deleteConfirm
        }
        onConfirm={() => void confirmRemove()}
        onClose={() => {
          if (!removing) setPendingRemove(null);
        }}
      />
    </div>
  );
}
