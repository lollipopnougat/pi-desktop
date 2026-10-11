import { usePiStore } from '../../store/pi-store';
import { getTodoProgress } from '../../utils/todo-progress';
import { t } from '../../i18n/zh';

export default function TodoProgressCapsule() {
  const todoPhases = usePiStore((state) => state.todoPhases);
  const todoPanelOpen = usePiStore((state) => state.todoPanelOpen);
  const setTodoPanelOpen = usePiStore((state) => state.setTodoPanelOpen);
  const summary = getTodoProgress(todoPhases);

  if (!summary) return null;

  const progressDeg = Math.round(summary.progress * 360);

  return (
    <button
      type="button"
      onClick={() => setTodoPanelOpen(!todoPanelOpen)}
      aria-label={t.todoCapsuleLabel(
        summary.currentStep,
        summary.totalSteps,
        summary.currentTask.content
      )}
      title={summary.currentTask.content}
      className={`absolute left-1/2 top-10 z-30 flex h-7 max-w-[70%] -translate-x-1/2 items-center gap-2 rounded-full border px-2.5 text-xs shadow-lg transition-colors ${
        todoPanelOpen
          ? 'border-od-accent/60 bg-od-bg-hover text-od-text-bright'
          : 'border-od-border-light bg-od-bg-alt/95 text-od-text hover:border-od-accent/50 hover:text-od-text-bright'
      }`}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(rgb(var(--od-accent)) ${progressDeg}deg, rgb(var(--od-border-light)) ${progressDeg}deg)`
        }}
        aria-hidden="true"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-od-bg-alt" />
      </span>
      <span className="shrink-0 font-mono tabular-nums text-od-accent">
        {summary.currentStep}/{summary.totalSteps}
      </span>
      <span className="h-3 w-px shrink-0 bg-od-border-light" aria-hidden="true" />
      <span className="min-w-0 truncate">{summary.currentTask.content}</span>
    </button>
  );
}
