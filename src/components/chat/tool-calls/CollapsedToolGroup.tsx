import { memo, useId, useState } from 'react';
import { usePiStore } from '../../../store/pi-store';
import Icon from '../../common/Icon';
import { t } from '../../../i18n/zh';
import ToolCard from '../ToolCard';
import ThinkingBlock from '../ThinkingBlock';
import type { ToolActivity } from '../chat-items';
import { toolActivityLabel } from './tool-presentation';

/** 连续工具活动的两级展开：摘要 -> 工具列表 -> 单项入参和结果。 */
function CollapsedToolGroup({ activities }: { activities: ToolActivity[] }) {
  const collapseToolCalls = usePiStore((s) => s.collapseToolCalls);
  // 设置变化立即采用新的默认值；流式追加不重置用户在当前组的选择。
  return (
    <ToolGroup
      key={String(collapseToolCalls)}
      activities={activities}
      initiallyExpanded={!collapseToolCalls}
    />
  );
}

function ToolGroup({
  activities,
  initiallyExpanded
}: {
  activities: ToolActivity[];
  initiallyExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const contentId = useId();
  const showThinkingBlocks = usePiStore((s) => s.showThinkingBlocks);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const tools = activities.filter((item) => item.type === 'tool');
  // 摘要只读取状态计数；完整输出与工具详情在展开后才挂载。
  const counts = usePiStore((s) => {
    let running = 0,
      errors = 0,
      pending = 0;
    for (const item of tools) {
      const status = s.toolExecutions[item.toolCall.id]?.status;
      if (status === 'running') running++;
      else if (status === 'error') errors++;
      else if (!status || status === 'pending') pending++;
    }
    return `${running}:${errors}:${pending}`;
  });
  const [running, errors, pending] = counts.split(':').map(Number);
  const summary = [...new Set(tools.map((item) => toolActivityLabel(item.toolCall.name)))].join(
    ' · '
  );
  const active =
    running > 0 ||
    (isStreaming &&
      (pending > 0 || activities.some((item) => item.type === 'thinking' && item.showPreview)));

  return (
    <div className="mb-3 min-w-0" data-tool-group>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        className="flex max-w-full items-center gap-2 rounded py-1.5 text-left text-sm text-od-text-dim transition-colors hover:text-od-text-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
        title={expanded ? t.collapseTools : t.expandTools(tools.length)}
      >
        <Icon
          name={active ? 'spinner' : 'tool'}
          spin={active}
          className={`w-3 shrink-0 ${active ? 'text-od-accent' : ''}`}
        />
        <span className="min-w-0 truncate">{summary}</span>
        <span className="shrink-0 text-xs">{t.toolGroupSummary(tools.length)}</span>
        {running > 0 && (
          <span className="shrink-0 text-xs text-od-accent">{t.toolRunningCount(running)}</span>
        )}
        {errors > 0 && (
          <span className="shrink-0 text-xs text-od-red">{t.toolErrorCount(errors)}</span>
        )}
        {pending > 0 && (
          <span className="shrink-0 text-xs">
            {isStreaming ? t.toolPendingCount(pending) : t.toolUnfinishedCount(pending)}
          </span>
        )}
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className="w-3 shrink-0" />
      </button>
      {expanded && (
        <div id={contentId} className="ml-1.5 mt-1 space-y-1 border-l border-od-border pl-3">
          {activities.map((item) =>
            item.type === 'tool' ? (
              <ToolCard key={item.key} toolCall={item.toolCall} compact />
            ) : (
              showThinkingBlocks && (
                <ThinkingBlock key={item.key} text={item.text} showPreview={item.showPreview} />
              )
            )
          )}
        </div>
      )}
    </div>
  );
}

// memo：activities 引用未变（历史条目跨帧复用）时跳过，流式期间不再逐帧重渲染工具组
export default memo(CollapsedToolGroup);
