import { usePiStore } from '../../../store/pi-store';
import Icon from '../../common/Icon';
import { t } from '../../../i18n/zh';
import { formatToolResult } from './tool-presentation';

/** 仅在单项详情展开时挂载，完整文本通过滚动查看，避免把大输出铺满对话。 */
export function ToolResultPreview({ toolCallId }: { toolCallId: string }) {
  const exec = usePiStore((s) => s.toolExecutions[toolCallId]);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const result = formatToolResult(exec?.result);
  const images: { data: string; mimeType: string }[] = Array.isArray(exec?.result?.content)
    ? exec.result.content.filter(
        (block: { type?: string; data?: string; mimeType?: string }) =>
          block.type === 'image' &&
          typeof block.data === 'string' &&
          /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '')
      )
    : [];
  const waiting =
    exec?.status === 'running' || exec?.status === 'pending' || (!exec && isStreaming);
  return (
    <div>
      <div className="mb-1 text-od-text-dim">{t.result}</div>
      {(result || images.length === 0) && (
        <pre className="max-h-60 overflow-auto rounded bg-od-bg-dark p-2 text-od-text">
          {result || (waiting ? t.toolWaitingOutput : t.toolNoOutput)}
        </pre>
      )}
      {images.map((image, index) => (
        <img
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={t.toolImageOutput}
          className="mt-2 max-h-60 max-w-full rounded object-contain"
        />
      ))}
    </div>
  );
}

/** 图标和文字来自同一执行状态，历史中缺失结果不误报成功。 */
export function ToolStatusIcon({
  toolCallId,
  showLabel = false
}: {
  toolCallId: string;
  showLabel?: boolean;
}) {
  const status = usePiStore((s) => s.toolExecutions[toolCallId]?.status ?? 'pending');
  const isStreaming = usePiStore((s) => s.isStreaming);
  const icon =
    status === 'success'
      ? 'check'
      : status === 'error'
        ? 'cross'
        : status === 'running'
          ? 'spinner'
          : 'circle';
  const color =
    status === 'success'
      ? 'text-od-green'
      : status === 'error'
        ? 'text-od-red'
        : status === 'running'
          ? 'text-od-accent'
          : 'text-od-text-dim';
  const label =
    status === 'success'
      ? t.toolStatusSuccess
      : status === 'error'
        ? t.toolStatusError
        : status === 'running'
          ? t.toolStatusRunning
          : isStreaming
            ? t.toolStatusPending
            : t.toolStatusUnfinished;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${color}`}
      title={label}
      aria-label={showLabel ? undefined : label}
    >
      <Icon name={icon} className="w-3 shrink-0" spin={status === 'running'} />
      {showLabel && label}
    </span>
  );
}

/** 在代码面板打开按钮（read/write 看文件、edit 看 diff） */
export function OpenInPanelButton({
  filePath,
  mode,
  toolCallId,
  edits,
  label,
  icon
}: {
  filePath: string;
  mode: 'file' | 'diff';
  toolCallId?: string;
  edits?: any;
  label: string;
  icon: 'diff' | 'code';
}) {
  const setRightPanelOpen = usePiStore((s) => s.setRightPanelOpen);
  const setPendingFile = usePiStore((s) => s.setPendingFile);
  const handleClick = () => {
    setRightPanelOpen(true);
    setPendingFile({ path: filePath, mode, toolCallId, edits });
  };
  const isDiff = mode === 'diff';
  return (
    <button
      onClick={handleClick}
      className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
        isDiff
          ? 'bg-od-accent/20 text-od-accent hover:bg-od-accent/30'
          : 'bg-od-bg-hover text-od-text-bright hover:bg-od-border-light'
      }`}
    >
      <Icon name={icon} className="w-3" />
      {label}
    </button>
  );
}
