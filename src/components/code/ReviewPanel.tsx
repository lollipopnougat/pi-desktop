import { useEffect, useState } from 'react';
import DiffViewer from './DiffViewer';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { TurnFileChange } from '../../types/shared';
import { relativeToCwd, splitDisplayPath } from '../../lib/turn-changes';
import { resolveTurnFileDiff, type ResolvedFileDiff } from '../../lib/turn-diff';

/**
 * 一轮改动的审核面板（右侧工作区）：左侧文件列表 + 右侧该文件完整前后 diff。
 *
 * 内容解析是异步的：需要读当前文件再倒序反应用 patch（见 `src/lib/turn-diff.ts`）；
 * 解析失败（文件在这轮之后又被改过 / 已删除）退回 patch 片段渲染，绝不空白。
 */
export default function ReviewPanel({ changes }: { changes: TurnFileChange[] }) {
  const cwd = usePiStore((state) => state.cwd);
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path ?? '');
  const selected = changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null;
  const [diff, setDiff] = useState<ResolvedFileDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 没有可选项时由下方的空态兜住，这里直接跳过
    if (!selected) return;
    let disposed = false;
    setLoading(true);
    setDiff(null);
    resolveTurnFileDiff(selected, (path) => window.pi.readFile(path))
      .then((result) => {
        if (!disposed) setDiff(result);
      })
      .catch(() => {
        if (!disposed) setDiff(null);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [selected]);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-xs text-od-text-dim">
        {t.turnChanges.reviewEmpty}
      </div>
    );
  }

  const totals = changes.reduce(
    (sum, change) => ({
      additions: sum.additions + change.additions,
      deletions: sum.deletions + change.deletions
    }),
    { additions: 0, deletions: 0 }
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex w-60 shrink-0 flex-col border-r border-od-border bg-od-bg-alt">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-od-border px-2.5 py-1.5 text-xs text-od-text-dim">
          <Icon name="diff" className="w-3" />
          <span>{t.turnChanges.filesChanged(changes.length)}</span>
          <span className="ml-auto font-mono text-od-green">+{totals.additions}</span>
          <span className="font-mono text-od-red">−{totals.deletions}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {changes.map((change) => {
            const display = relativeToCwd(change.path, cwd);
            const { dir, name } = splitDisplayPath(display);
            const active = change.path === selected?.path;
            return (
              <button
                key={change.path}
                type="button"
                onClick={() => setSelectedPath(change.path)}
                title={display}
                className={`flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors ${
                  active
                    ? 'bg-od-bg-hover text-od-text-bright'
                    : 'text-od-text hover:bg-od-bg-hover/60'
                }`}
              >
                <Icon name="file" className="w-3 shrink-0 text-od-text-dim" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-od-text-dim">{dir}</span>
                  {name}
                </span>
                <span
                  className={`shrink-0 font-mono ${change.additions ? 'text-od-green' : 'text-od-text-dim'}`}
                >
                  +{change.additions}
                </span>
                <span
                  className={`shrink-0 font-mono ${change.deletions ? 'text-od-red' : 'text-od-text-dim'}`}
                >
                  −{change.deletions}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-od-border bg-od-bg-alt px-2.5 py-1 text-xs">
          <Icon name="file" className="w-3 shrink-0 text-od-text-dim" />
          <span
            className="min-w-0 flex-1 truncate font-mono"
            title={relativeToCwd(selected.path, cwd)}
          >
            {relativeToCwd(selected.path, cwd)}
          </span>
          {selected.kind === 'write' && (
            <span
              className="shrink-0 rounded bg-od-bg-hover px-1 text-[0.7rem] text-od-text-dim"
              title={t.turnChanges.writeHint}
            >
              {t.turnChanges.writeBadge}
            </span>
          )}
          <span
            className={`shrink-0 font-mono ${selected.additions ? 'text-od-green' : 'text-od-text-dim'}`}
          >
            +{selected.additions}
          </span>
          <span
            className={`shrink-0 font-mono ${selected.deletions ? 'text-od-red' : 'text-od-text-dim'}`}
          >
            −{selected.deletions}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-od-text-dim">
              <Icon name="spinner" spin className="w-3" />
              {t.turnChanges.reviewLoading}
            </div>
          ) : diff ? (
            <DiffViewer
              filePath={selected.path}
              originalContent={diff.original}
              modifiedContent={diff.modified}
            />
          ) : (
            <DiffViewer filePath={selected.path} patch={selected.patches.join('\n')} />
          )}
        </div>
      </div>
    </div>
  );
}
