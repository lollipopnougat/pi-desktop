import { memo, useState } from 'react';
import type { TurnChanges, TurnFileChange } from '../../types/shared';
import { relativeToCwd, splitDisplayPath } from '../../lib/turn-changes';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/** 默认列出的文件数；超出折叠，避免长卡片把本轮回复挤出视口 */
const MAX_VISIBLE_FILES = 6;

/** 单个文件行：目录淡化、文件名高亮，右侧 +/- 统计（为 0 的一侧淡出） */
const ChangeFileRow = memo(function ChangeFileRow({
  file,
  cwd,
  onOpen
}: {
  file: TurnFileChange;
  cwd: string | null;
  onOpen: (file: TurnFileChange) => void;
}) {
  const display = relativeToCwd(file.path, cwd);
  const { dir, name } = splitDisplayPath(display);
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      title={display}
      className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors hover:bg-od-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
    >
      <Icon name="file" className="w-3 shrink-0 text-od-text-dim" />
      <span className="min-w-0 flex-1 truncate font-mono">
        <span className="text-od-text-dim">{dir}</span>
        <span className="text-od-text-bright">{name}</span>
      </span>
      {file.kind === 'write' && (
        <span className="shrink-0 rounded bg-od-bg-hover px-1 text-[0.7rem] text-od-text-dim">
          {t.turnChanges.writeBadge}
        </span>
      )}
      <span
        className={`shrink-0 font-mono ${file.additions ? 'text-od-green' : 'text-od-text-dim'}`}
      >
        +{file.additions}
      </span>
      <span className={`shrink-0 font-mono ${file.deletions ? 'text-od-red' : 'text-od-text-dim'}`}>
        −{file.deletions}
      </span>
    </button>
  );
});

/**
 * 一轮对话结束后的「本次改动」卡片：列出 agent 这轮改过/新建的文件，
 * 点文件名在右侧打开该文件 diff，点「审核」打开右侧审核面板（左侧文件列表 + 右侧 diff）。
 */
export default memo(function TurnChangesCard({ changes }: { changes: TurnChanges }) {
  const cwd = usePiStore((s) => s.cwd);
  const setPendingFile = usePiStore((s) => s.setPendingFile);
  const setRightPanelOpen = usePiStore((s) => s.setRightPanelOpen);
  const [expanded, setExpanded] = useState(false);

  const files = changes.files;
  if (files.length === 0) return null;
  const visible = expanded ? files : files.slice(0, MAX_VISIBLE_FILES);
  const hidden = files.length - visible.length;

  const openFile = (file: TurnFileChange) => {
    setRightPanelOpen(true);
    setPendingFile({ path: file.path, mode: 'diff', change: file });
  };
  const openReview = () => {
    setRightPanelOpen(true);
    setPendingFile({ path: files[0].path, mode: 'review', changes: files });
  };

  return (
    <div className="mb-3 min-w-0 overflow-hidden rounded border border-od-border bg-od-bg-alt">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Icon name="pencil" className="w-3 shrink-0 text-od-text-dim" />
        <span className="shrink-0 text-xs text-od-text">{t.turnChanges.title}</span>
        <span className="shrink-0 text-xs text-od-text-dim">
          {t.turnChanges.filesChanged(files.length)}
        </span>
        <span className="shrink-0 font-mono text-xs text-od-green">+{changes.additions}</span>
        <span className="shrink-0 font-mono text-xs text-od-red">−{changes.deletions}</span>
        <button
          type="button"
          onClick={openReview}
          className="ml-auto flex shrink-0 items-center gap-1 rounded border border-od-border-light px-2 py-0.5 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover active:bg-od-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
        >
          <Icon name="diff" className="w-3" />
          {t.turnChanges.review}
        </button>
      </div>
      <div className="border-t border-od-border">
        {visible.map((file) => (
          <ChangeFileRow key={file.path} file={file} cwd={cwd} onOpen={openFile} />
        ))}
        {(hidden > 0 || expanded) && files.length > MAX_VISIBLE_FILES && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text"
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className="w-3" />
            {expanded ? t.turnChanges.collapse : t.turnChanges.expandAll(hidden)}
          </button>
        )}
      </div>
    </div>
  );
});
