import { usePiStore } from '../../store/pi-store';
import type { TodoPhase, TodoStatus } from '../../store/pi-store';
import Icon from '../common/Icon';
import type { IconName } from '../common/icons';
import { t } from '../../i18n/zh';

const statusIcon = (s: TodoStatus): IconName => {
  switch (s) {
    case 'completed':
      return 'check';
    case 'in_progress':
      return 'spinner';
    case 'abandoned':
      return 'cross';
    default:
      return 'circle';
  }
};

const statusColor = (s: TodoStatus): string => {
  switch (s) {
    case 'completed':
      return 'text-od-green';
    case 'in_progress':
      return 'text-od-accent';
    case 'abandoned':
      return 'text-od-text-dim';
    default:
      return 'text-od-text-dim';
  }
};

const itemOpacity = (s: TodoStatus): string => {
  switch (s) {
    case 'completed':
      return 'opacity-60';
    case 'abandoned':
      return 'opacity-40';
    default:
      return '';
  }
};

interface TodoPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function TodoPanel({ open, onClose }: TodoPanelProps) {
  const todoPhases = usePiStore((s) => s.todoPhases);
  const isEmpty = todoPhases.length === 0;

  if (!open) return null;

  return (
    <div
      className="fixed z-40 flex flex-col bg-od-bg-alt border border-od-border-light rounded-lg shadow-2xl"
      style={{
        top: window.pi?.platform === 'darwin' ? 44 : 36,
        right: 12,
        width: 280,
        minHeight: 160,
        maxHeight: '50vh'
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-od-border px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 text-xs text-od-text-bright font-medium">
          <Icon name="todo" className="w-3" />
          <span>{t.todoPanel}</span>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright transition-colors"
          title={t.closePanel}
        >
          <Icon name="close" className="w-3" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 h-full overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full px-4 my-6 text-center">
            <Icon name="todo" className="w-8 mb-2 text-od-text-dim" />
            <p className="text-xs text-od-text-dim">{t.todoPanelEmpty}</p>
            <p className="text-xs text-od-text-dim mt-1 leading-relaxed">{t.todoPanelHint}</p>
          </div>
        ) : (
          <div className="py-2">
            {todoPhases.map((phase: TodoPhase, pi: number) => {
              const doneCount = phase.tasks.filter(
                (t: { status: string }) => t.status === 'completed'
              ).length;
              const totalCount = phase.tasks.length;
              const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

              return (
                <div key={pi} className="px-2 mb-2">
                  {/* Phase header */}
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <span className="text-xs font-semibold text-od-text-bright uppercase tracking-wider">
                      {phase.name}
                    </span>
                    <span className="text-xs text-od-text-dim">
                      {doneCount}/{totalCount}
                      {totalCount > 0 && (
                        <span className="ml-1 text-od-accent">{progressPct}%</span>
                      )}
                    </span>
                  </div>

                  {/* Progress bar */}
                  {totalCount > 0 && (
                    <div className="mx-1 mb-1.5 h-0.5 rounded-full bg-od-bg-hover overflow-hidden">
                      <div
                        className="h-full rounded-full bg-od-accent transition-all duration-500"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  )}

                  {/* Tasks */}
                  {phase.tasks.map(
                    (task: { id: string; content: string; status: TodoStatus }, ti: number) => (
                      <div
                        key={task.id}
                        className={`flex items-start gap-2 px-1 py-0.5 rounded transition-colors hover:bg-od-bg-hover/50 group ${itemOpacity(task.status)}`}
                      >
                        <span className={`mt-0.5 shrink-0 ${statusColor(task.status)}`}>
                          <Icon
                            name={statusIcon(task.status)}
                            spin={task.status === 'in_progress'}
                            className="w-2.5"
                          />
                        </span>
                        <span
                          className={`text-xs flex-1 leading-relaxed ${
                            task.status === 'completed'
                              ? 'line-through text-od-text-dim'
                              : task.status === 'in_progress'
                                ? 'text-od-text-bright'
                                : 'text-od-text'
                          }`}
                        >
                          {task.content}
                        </span>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
