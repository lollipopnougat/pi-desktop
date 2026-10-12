/**
 * GoalEditDialog:编辑目标的模态弹窗。
 *
 * 从 GoalBar 的编辑按钮触发,展示当前目标文本,编辑后提交:
 * 清除当前目标 → 创建新目标(用新文本)→ 启动自治循环。
 */
import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n/zh';
import Icon from '../common/Icon';

export default function GoalEditDialog() {
  const { goalEditDialogOpen, goalSnapshot, setGoalEditDialogOpen } = usePiStore(
    useShallow((s) => ({
      goalEditDialogOpen: s.goalEditDialogOpen,
      goalSnapshot: s.goalSnapshot,
      setGoalEditDialogOpen: s.setGoalEditDialogOpen
    }))
  );
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (goalEditDialogOpen) {
      setText(goalSnapshot?.goal?.text ?? '');
    }
  }, [goalEditDialogOpen, goalSnapshot]);

  if (!goalEditDialogOpen) return null;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      // 先关弹窗,避免等 agent 跑完才关(create 内部会 await prompt)
      setGoalEditDialogOpen(false);
      // 清除当前目标,按新目标继续(主进程 createGoal 会覆盖 complete 的旧目标)
      await window.pi.goal.clear();
      await window.pi.goal.create(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setGoalEditDialogOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleClose}
    >
      <div
        className="w-[480px] max-w-[90vw] rounded-xl border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-od-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="edit2" className="text-od-orange" />
            <span className="text-sm font-medium text-od-text-bright">{t.goal.edit}</span>
          </div>
          <button
            onClick={handleClose}
            className="text-od-text-dim hover:text-od-text-bright"
            title={t.goal.cancel}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.goal.createPlaceholder}
            rows={4}
            className="resize-none rounded-lg border border-od-border bg-od-bg-dark px-3 py-2 text-sm text-od-text-bright placeholder:text-od-text-dim focus:border-od-orange/80 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
          />
          <p className="text-xs text-od-text-dim">提交后将清除当前目标,按新目标继续推进。</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-od-border px-4 py-3">
          <button
            onClick={handleClose}
            className="rounded-lg px-3 py-1.5 text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            {t.goal.cancel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!text.trim() || submitting}
            className="rounded-lg bg-od-orange px-4 py-1.5 text-xs text-white transition-colors hover:bg-od-orange/80 disabled:opacity-30"
          >
            {t.goal.save}
          </button>
        </div>
      </div>
    </div>
  );
}
