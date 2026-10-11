/**
 * GoalBar:输入框上方的目标状态条。
 *
 * 显示:目标文本摘要 + 状态徽标 + 预算条 + pause/resume/clear/edit 按钮。
 * 流式时隐藏(避免遮挡)。无 active goal 时隐藏。
 */
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import Icon from '../common/Icon';
import { formatTokens } from '../../utils/format';

const STATUS_STYLES: Record<string, { color: string; label: string; icon: string }> = {
  active: { color: 'text-od-green', label: t.goal.active, icon: 'target' },
  paused: { color: 'text-od-text-dim', label: t.goal.paused, icon: 'pause' },
  blocked: { color: 'text-od-red', label: t.goal.blocked, icon: 'circleExclamation' },
  budget_limited: {
    color: 'text-od-yellow',
    label: t.goal.budgetLimited,
    icon: 'circleExclamation'
  },
  complete: { color: 'text-od-green', label: t.goal.complete, icon: 'circleCheck' }
};

export default function GoalBar() {
  const { goalSnapshot, setGoalEditDialogOpen } = usePiStore();
  if (!goalSnapshot?.goal) return null;
  // 目标已完成/阻塞后隐藏 GoalBar(标记已在消息上显示)
  if (goalSnapshot.goal.status === 'complete' || goalSnapshot.goal.status === 'blocked') {
    return null;
  }

  const g = goalSnapshot.goal;
  const style = STATUS_STYLES[g.status] ?? STATUS_STYLES.active;
  const isComplete = g.status === 'complete';
  const isActive = g.status === 'active';

  const handlePause = () => window.pi.goal.pause();
  const handleResume = () => window.pi.goal.resume();
  const handleEdit = () => setGoalEditDialogOpen(true);
  const handleClear = () => {
    if (confirm(t.goal.confirmClear)) window.pi.goal.clear();
  };

  const budgetPct =
    g.tokenBudget != null && g.tokenBudget > 0
      ? Math.min(100, (g.tokensUsed / g.tokenBudget) * 100)
      : null;

  return (
    <div className="mx-3 mb-1 rounded-lg border border-od-border bg-od-bg-alt px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name={style.icon as any} className={`w-3 ${style.color}`} />
        <span className={`text-xs font-medium ${style.color}`}>{style.label}</span>
        <span className="text-od-border-light">·</span>
        <span className="flex-1 truncate text-xs text-od-text" title={g.text}>
          {g.text}
        </span>

        {/* 操作按钮 */}
        <div className="flex shrink-0 items-center gap-1">
          {isActive && (
            <button
              onClick={handlePause}
              className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.goal.pause}
            >
              <Icon name="pause" className="w-3" />
            </button>
          )}
          {!isActive && !isComplete && (
            <button
              onClick={handleResume}
              className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.goal.resume}
            >
              <Icon name="continue" className="w-3" />
            </button>
          )}
          {!isComplete && (
            <button
              onClick={handleEdit}
              className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.goal.edit}
            >
              <Icon name="edit2" className="w-3" />
            </button>
          )}
          {!isComplete && (
            <button
              onClick={handleClear}
              className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-red"
              title={t.goal.clear}
            >
              <Icon name="close" className="w-3" />
            </button>
          )}
        </div>
      </div>

      {/* 预算条 */}
      {g.tokenBudget != null && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-od-bg-dark">
            <div
              className={`h-full rounded-full ${
                budgetPct != null && budgetPct >= 100
                  ? 'bg-od-red'
                  : budgetPct != null && budgetPct >= 80
                    ? 'bg-od-yellow'
                    : 'bg-od-green'
              }`}
              style={{ width: `${budgetPct ?? 0}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-od-text-dim">
            {formatTokens(g.tokensUsed)} / {formatTokens(g.tokenBudget)}
          </span>
        </div>
      )}
      {g.tokenBudget == null && g.tokensUsed > 0 && (
        <div className="mt-1 font-mono text-xs text-od-text-dim">
          {t.goal.tokensUsed(g.tokensUsed)} · {g.timeUsedSeconds}s
        </div>
      )}

      {/* safety pause 提示 */}
      {g.safetyPauseCause === 'continuation_limit' && (
        <div className="mt-1 text-xs text-od-yellow">{t.goal.safetyPauseContinuation}</div>
      )}
      {g.safetyPauseCause === 'no_progress' && (
        <div className="mt-1 text-xs text-od-yellow">{t.goal.safetyPauseNoProgress}</div>
      )}
    </div>
  );
}
