/**
 * SubagentPanel:子 agent 运行面板（右侧工作区的一个标签页，由聊天头部的 agents 按钮打开）。
 *
 * 实时展示(pi:subagentUpdate 推送):
 * - 每个_run:agent 名/任务摘要/状态徽标/当前工具/轮次/耗时
 * - 运行中可停止(窗口右下 stop 按钮)
 * - 完成的 run 可展开查看结果输出
 * - 底部:可用 agent 定义列表(builtin/user/project)
 */
import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import type { SubagentRunState } from '../../store/pi-store';
import Icon from '../common/Icon';
import type { IconName } from '../common/icons';
import { t } from '../../i18n/zh';
import SubagentRunDetailModal from './SubagentRunDetailModal';

const STATUS_META: Record<string, { icon: IconName; color: string; label: string }> = {
  queued: { icon: 'clock', color: 'text-od-text-dim', label: t.subagents.statusQueued },
  running: { icon: 'spinner', color: 'text-od-accent', label: t.subagents.statusRunning },
  complete: { icon: 'circleCheck', color: 'text-od-green', label: t.subagents.statusComplete },
  failed: { icon: 'circleExclamation', color: 'text-od-red', label: t.subagents.statusFailed },
  stopped: { icon: 'stop', color: 'text-od-text-dim', label: t.subagents.statusStopped }
};

function RunCard({ run, onOpenDetail }: { run: SubagentRunState; onOpenDetail: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[run.status] ?? STATUS_META.queued;
  const isRunning = run.status === 'running' || run.status === 'queued';
  // 耗时:运行中由 progress.durationMs 提供(主进程持续更新);
  // 已结束用 endedAt-startedAt;不在此处调 Date.now()(render 纯度)
  const durationMs =
    run.progress?.durationMs ??
    (run.endedAt != null && run.startedAt != null ? run.endedAt - run.startedAt : 0);
  const tokens = run.usage ? run.usage.input + run.usage.output : 0;

  const handleStop = () => {
    if (confirm(t.subagents.stopConfirm)) {
      window.pi.subagents.stop(run.id);
    }
  };

  return (
    <div className="rounded-md border border-od-border bg-od-bg px-2.5 py-2">
      {/* 首行:状态 + agent 名 + 任务名(点击整行打开详情) */}
      <div className="flex items-center gap-2">
        <Icon
          name={meta.icon}
          className={`w-3 shrink-0 ${meta.color}`}
          spin={run.status === 'running'}
        />
        <span className={`text-xs font-medium shrink-0 ${meta.color}`}>{meta.label}</span>
        <button
          onClick={onOpenDetail}
          className="min-w-0 flex flex-1 items-center gap-2 text-left"
          title={t.subagents.openDetail}
        >
          <span className="truncate text-xs font-medium text-od-text-bright">{run.name}</span>
          <span className="shrink-0 text-xs text-od-text-dim">({run.agent})</span>
        </button>
        {run.async && (
          <span className="shrink-0 rounded bg-od-bg-dark px-1.5 text-xs text-od-text-dim">
            {t.subagents.asyncBadge}
          </span>
        )}
        <div className="flex-1" />
        {isRunning && (
          <button
            onClick={handleStop}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-red transition-colors"
            title={t.subagents.stopRun}
          >
            <Icon name="stop" className="w-2.5" />
          </button>
        )}
      </div>

      {/* 任务摘要 */}
      <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-od-text-dim" title={run.task}>
        {run.task}
      </div>

      {/* 运行中:当前工具 / 轮次 / 耗时 */}
      {isRunning && run.progress && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-od-text-dim">
          {run.progress.currentTool && (
            <span className="text-od-accent">
              {t.subagents.currentTool(run.progress.currentTool)}
            </span>
          )}
          {run.progress.turns > 0 && <span>{t.subagents.turnsLabel(run.progress.turns)}</span>}
          <span>{t.subagents.elapsedLabel(durationMs)}</span>
        </div>
      )}

      {/* 已结束:输出/错误摘要 + 展开详情 */}
      {!isRunning && (run.output || run.error) && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-od-text-dim hover:text-od-text-bright transition-colors"
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className="w-2.5" />
            <span>{expanded ? t.subagents.hideOutput : t.subagents.viewOutput}</span>
            {tokens > 0 && (
              <span className="ml-1 text-od-text-dim/70">· {t.subagents.tokensLabel(tokens)}</span>
            )}
            <span className="ml-1 text-od-text-dim/70">
              · {t.subagents.elapsedLabel(durationMs)}
            </span>
          </button>
          {(expanded || run.status === 'failed') && (
            <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-od-bg-dark px-2 py-1.5 font-mono text-xs leading-relaxed text-od-text">
              {run.status === 'failed' && run.error
                ? `${t.subagents.errorLabel}: ${run.error}`
                : run.output || t.subagents.noOutput}
              {run.outputSource === 'fallback' && (
                <div className="mt-1 text-od-text-dim">{t.subagents.outputSourceFallback}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SubagentPanel() {
  const subagentSnapshot = usePiStore((s) => s.subagentSnapshot);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  // 标签被激活时组件才挂载：这里拉一次快照，覆盖「重开应用后没收到推送」的场景（历史 run 从会话恢复）
  useEffect(() => {
    void refreshSubagentSnapshot();
  }, []);

  const runs = subagentSnapshot?.runs ?? [];
  const agents = subagentSnapshot?.agents ?? [];
  const activeCount = runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
  const detailRun = detailRunId != null ? runs.find((r) => r.id === detailRunId) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-od-bg-dark">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-od-border bg-od-bg-alt px-3">
        <Icon name="agents" className="w-3 text-od-accent" />
        <span className="text-xs font-medium text-od-text-bright">{t.subagents.panelTitle}</span>
        {activeCount > 0 && (
          <span className="rounded bg-od-bg-hover px-1.5 text-xs text-od-accent">
            {activeCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-od-text-dim">
          {t.subagents.runsCount(runs.length)}
          <button
            type="button"
            onClick={() => void refreshSubagentSnapshot()}
            className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.subagents.refresh}
          >
            <Icon name="rotate" className="w-3" />
          </button>
        </div>
      </div>

      {/* Runs */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {runs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
            <Icon name="agents" className="mb-2 w-8 text-od-text-dim" />
            <p className="text-xs text-od-text-dim">{t.subagents.panelEmpty}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-1.5">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} onOpenDetail={() => setDetailRunId(run.id)} />
            ))}
          </div>
        )}
      </div>

      {/* 可用 agent 列表 */}
      {agents.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t border-od-border bg-od-bg-alt px-3 py-2">
          <div className="mb-1 text-xs font-medium text-od-text-dim">
            {t.subagents.agentsSectionTitle}
          </div>
          <div className="flex flex-col gap-0.5">
            {agents.map((a) => (
              <div key={a.name} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 font-mono text-od-accent">{a.name}</span>
                <span className="shrink-0 text-od-text-dim/70">
                  {a.source === 'builtin'
                    ? t.subagents.sourceBuiltin
                    : a.source === 'user'
                      ? t.subagents.sourceUser
                      : t.subagents.sourceProject}
                </span>
                <span className="line-clamp-2 text-od-text-dim">{a.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 详情弹窗（工作区内的模态，仍浮在面板之上） */}
      {detailRun && <SubagentRunDetailModal run={detailRun} onClose={() => setDetailRunId(null)} />}
    </div>
  );
}

/** 拉一次主进程快照并写回 store（标签激活时 / 点刷新时用） */
async function refreshSubagentSnapshot(): Promise<void> {
  try {
    const snapshot = await window.pi.subagents.getSnapshot();
    usePiStore.getState().setSubagentSnapshot(snapshot);
  } catch {
    /* 子 agent 服务不可用：保留旧快照 */
  }
}
