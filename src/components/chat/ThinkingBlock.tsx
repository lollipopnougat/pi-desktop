import { useId, useState } from 'react';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

function ThinkingBlock({ text, showPreview = false }: { text: string; showPreview?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  // 折叠 + 本块仍在流式输出时，把最新一行「正在输出」内容放在标题右侧空隙。
  // 取最后非空一行（多为模型当前正输出的那一句）；为空不显示。
  // 本块输出完毕（外部由「后面是否还有块」推得）或用户展开后，预览消失。
  const previewLine =
    showPreview && !expanded
      ? text
          .split('\n')
          .filter((l) => l.trim())
          .pop() || ''
      : '';

  return (
    <div className="min-w-0" data-thinking-block>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1.5 text-left text-sm transition-colors hover:bg-od-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
      >
        <Icon name="lightbulb" className="w-3 shrink-0 text-od-text-dim" />
        <span className="shrink-0 text-od-text">{t.thinking}</span>
        {/* 折叠 + 流式：在标题右侧空隙预览最新一行（truncate、左对齐） */}
        <span className="min-w-0 flex-1 truncate text-od-text-dim">{previewLine}</span>
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          className="w-3 shrink-0 text-od-text-dim"
        />
      </button>
      {expanded && (
        <div
          id={detailsId}
          className="my-1 rounded-lg border border-od-border bg-od-bg-alt px-3 py-3 text-xs"
        >
          <div className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-od-bg-dark p-2 text-od-text">
            {text}
          </div>
        </div>
      )}
    </div>
  );
}

export default ThinkingBlock;
