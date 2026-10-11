import { useId, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import Icon from '../common/Icon';
import type { ToolCallBlock } from './chat-items';
import { ToolResultPreview, ToolStatusIcon, OpenInPanelButton } from './tool-calls/ToolCallParts';
import { getToolLabel, toolIcon } from './tool-calls/tool-presentation';

export default function ToolCard({
  toolCall,
  compact = false
}: {
  toolCall: ToolCallBlock;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const exec = usePiStore((s) => s.toolExecutions[toolCall.id]);
  const args = toolCall.arguments;
  const label = getToolLabel(toolCall.name, args);
  const path = args.path ?? args.file;
  const filePath = typeof path === 'string' ? path : '';
  const isEdit = toolCall.name === 'edit';
  const showOpen = ['read', 'write', 'edit'].includes(toolCall.name) && !!filePath;

  return (
    <div
      className={compact ? 'min-w-0' : 'min-w-0 rounded border border-od-border bg-od-bg-alt'}
      data-tool-call={toolCall.id}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        className={`flex w-full min-w-0 items-center gap-2 rounded py-1.5 text-left transition-colors hover:bg-od-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent ${compact ? 'px-1 text-sm' : 'px-2 text-xs'}`}
      >
        <Icon name={toolIcon(toolCall.name)} className="w-3 shrink-0 text-od-text-dim" />
        <span className="shrink-0 text-od-text">{toolCall.name}</span>
        <span className="min-w-0 flex-1 truncate text-od-text-dim" title={label}>
          {label}
        </span>
        <ToolStatusIcon toolCallId={toolCall.id} />
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          className="w-3 shrink-0 text-od-text-dim"
        />
      </button>
      {expanded && (
        <div
          id={detailsId}
          className="my-1 space-y-3 rounded-lg border border-od-border bg-od-bg-alt px-3 py-3 text-xs"
        >
          <div>
            <div className="mb-1 text-od-text-dim">{t.arguments}</div>
            <pre className="max-h-60 overflow-auto rounded bg-od-bg-dark p-2 text-od-text">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          <ToolResultPreview toolCallId={toolCall.id} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-od-border pt-2">
            {showOpen && (
              <OpenInPanelButton
                filePath={filePath}
                mode={isEdit ? 'diff' : 'file'}
                toolCallId={toolCall.id}
                edits={args.edits}
                label={isEdit ? t.viewDiff : t.openInPanel}
                icon={isEdit ? 'diff' : 'code'}
              />
            )}
            <span
              className={`ml-auto flex items-center gap-1.5 ${exec?.status === 'error' ? 'text-od-red' : 'text-od-text-dim'}`}
            >
              <ToolStatusIcon toolCallId={toolCall.id} showLabel />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
