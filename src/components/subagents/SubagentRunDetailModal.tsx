/**
 * SubagentRunDetailModal:单个子 agent run 的详情弹窗。
 *
 * 点击 SubagentPanel 的 run 卡片打开,展示:
 * - 头部:agent 名/任务名/状态/耗时/token
 * - Tab 切换:对话(默认,任务 → 助手正文/思考/工具调用内联 → 结果) /
 *   结果(submit 结果全文) / 工具调用(时间线,每项可展开看参数与结果)
 * - 数据源:运行中走内存实时采集(可流式看到正在生成的正文);
 *   终态/重启后走子 agent 会话文件(完整含工具结果,不随内存丢失)
 * - 运行中实时刷新(快照推送驱动,经 store 重新渲染)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SubagentConversationState,
  SubagentRunState,
  SubagentToolCallState,
  SubagentTranscriptItem
} from '../../store/pi-store';
import Icon from '../common/Icon';
import type { IconName } from '../common/icons';
import Markdown from '../common/Markdown';
import ThinkingBlock from '../chat/ThinkingBlock';
import { t } from '../../i18n/zh';

const STATUS_META: Record<string, { icon: IconName; color: string; label: string }> = {
  queued: { icon: 'clock', color: 'text-od-text-dim', label: t.subagents.statusQueued },
  running: { icon: 'spinner', color: 'text-od-accent', label: t.subagents.statusRunning },
  complete: { icon: 'circleCheck', color: 'text-od-green', label: t.subagents.statusComplete },
  failed: { icon: 'circleExclamation', color: 'text-od-red', label: t.subagents.statusFailed },
  stopped: { icon: 'stop', color: 'text-od-text-dim', label: t.subagents.statusStopped }
};

/** 格式化任意值(参数/结果)为可展示文本 */
function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 工具调用的简要标签(对齐 ToolCard 风格: [bash: ls -la]) */
function toolLabel(name: string, args: any): string {
  switch (name) {
    case 'read':
      return args?.path || args?.file || '';
    case 'edit':
    case 'write':
      return args?.path || args?.file || '';
    case 'bash':
      return args?.command?.substring(0, 120) || '';
    case 'grep':
      return args?.pattern || '';
    case 'find':
      return args?.pattern || '';
    case 'ls':
      return args?.path || '';
    case 'submit':
      return '(结果提交)';
    default:
      return '';
  }
}

function formatDuration(ms: number): string {
  return t.subagents.elapsedLabel(ms);
}

function ToolCallItem({ tc }: { tc: SubagentToolCallState }) {
  const [expanded, setExpanded] = useState(false);
  const duration = tc.endedAt != null ? tc.endedAt - tc.startedAt : null;
  const statusIcon: IconName = tc.pending ? 'spinner' : tc.isError ? 'cross' : 'check';
  const statusColor = tc.pending ? 'text-od-accent' : tc.isError ? 'text-od-red' : 'text-od-green';

  return (
    <div className="rounded border border-od-border bg-od-bg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-od-bg-hover"
      >
        <Icon name={statusIcon} className={`w-3 shrink-0 ${statusColor}`} spin={tc.pending} />
        <span className="shrink-0 font-mono text-od-text">{tc.toolName}</span>
        <span className="truncate text-od-text-dim text-left flex-1">
          {toolLabel(tc.toolName, tc.args)}
        </span>
        {duration != null && (
          <span className="shrink-0 text-od-text-dim/70">{formatDuration(duration)}</span>
        )}
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          className="w-3 shrink-0 text-od-text-dim"
        />
      </button>
      {expanded && (
        <div className="space-y-1.5 border-t border-od-border px-2 py-1.5 text-xs">
          {tc.args != null && (
            <div>
              <div className="mb-0.5 text-od-text-dim">{t.subagents.argsLabel}</div>
              <pre className="max-h-40 overflow-auto rounded bg-od-bg-dark p-1.5 font-mono text-xs leading-relaxed text-od-text">
                {formatValue(tc.args)}
              </pre>
            </div>
          )}
          {tc.result != null && (
            <div>
              <div className="mb-0.5 text-od-text-dim">{t.subagents.resultLabel}</div>
              <pre
                className={`max-h-48 overflow-auto rounded bg-od-bg-dark p-1.5 font-mono text-xs leading-relaxed ${
                  tc.isError ? 'text-od-red' : 'text-od-text'
                }`}
              >
                {formatValue(tc.result)}
              </pre>
            </div>
          )}
          {tc.args == null && tc.result == null && (
            <div className="text-od-text-dim">{t.subagents.noOutput}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 对话流单条渲染:正文/思考/工具调用内联(与主对话同款组件与观感) */
function TranscriptItemView({
  item,
  toolCallMap
}: {
  item: SubagentTranscriptItem;
  toolCallMap: Map<string, SubagentToolCallState>;
}) {
  if (item.kind === 'text') {
    return <Markdown content={item.text} openLinksInBrowser />;
  }
  if (item.kind === 'thinking') {
    return <ThinkingBlock text={item.text} />;
  }
  if (item.kind === 'tool') {
    const tc = toolCallMap.get(item.toolCallId);
    // 工具尚未开始执行(tool_execution_start 前)时暂无流水记录,下一条快照补上
    return tc ? <ToolCallItem tc={tc} /> : null;
  }
  // stream:流式占位(正文 + 思考 + 已发起的工具调用)
  return (
    <div className="space-y-2">
      {item.text && <Markdown content={item.text} openLinksInBrowser />}
      {item.thinking && <ThinkingBlock text={item.thinking} showPreview />}
      {item.toolCallIds.map((id) => {
        const tc = toolCallMap.get(id);
        return tc ? <ToolCallItem key={id} tc={tc} /> : null;
      })}
    </div>
  );
}

interface SubagentRunDetailModalProps {
  run: SubagentRunState;
  onClose: () => void;
}

type DetailTab = 'conversation' | 'output' | 'tools';

export default function SubagentRunDetailModal({ run, onClose }: SubagentRunDetailModalProps) {
  const [tab, setTab] = useState<DetailTab>('conversation');
  const meta = STATUS_META[run.status] ?? STATUS_META.queued;
  const isRunning = run.status === 'running' || run.status === 'queued';
  const durationMs =
    run.progress?.durationMs ??
    (run.endedAt != null && run.startedAt != null ? run.endedAt - run.startedAt : 0);
  const tokens = run.usage ? run.usage.input + run.usage.output : 0;

  // 终态 run 的对话从会话文件回放(重启后依然完整);运行中用内存实时采集
  const [fileConversation, setFileConversation] = useState<{
    runId: string;
    conv: SubagentConversationState;
  } | null>(null);
  useEffect(() => {
    if (isRunning || !run.sessionFile) return;
    let cancelled = false;
    window.pi.subagents
      .getSession(run.id)
      .then((conv) => {
        if (!cancelled && conv) setFileConversation({ runId: run.id, conv });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [run.id, run.sessionFile, isRunning, run.endedAt]);

  // 只接受当前 run 的回放结果(切换 run 时不会短暂显示上一条)
  const fileConv = fileConversation?.runId === run.id ? fileConversation.conv : null;
  const sourceToolCalls = isRunning ? run.toolCalls : (fileConv?.toolCalls ?? run.toolCalls);
  const sourceTranscript = isRunning ? run.transcript : (fileConv?.transcript ?? run.transcript);
  const toolCalls = useMemo(() => sourceToolCalls ?? [], [sourceToolCalls]);
  const transcript = useMemo(() => sourceTranscript ?? [], [sourceTranscript]);
  const toolCallMap = useMemo(
    () => new Map(toolCalls.map((tc) => [tc.toolCallId, tc])),
    [toolCalls]
  );

  // 粘底滚动:运行中持续追加内容时自动跟随;用户上滑后不再回拽
  const bodyRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  });
  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 24);
  };

  const tabClass = (active: boolean) =>
    `rounded-t px-3 py-1.5 text-xs transition-colors ${
      active
        ? 'border-b-2 border-od-accent font-medium text-od-text-bright'
        : 'text-od-text-dim hover:text-od-text'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ paddingTop: window.pi?.platform === 'darwin' ? 38 : 32 }}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* 弹窗主体 */}
      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col overflow-hidden rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-od-border px-4 py-2.5">
          <Icon name={meta.icon} className={`w-3.5 shrink-0 ${meta.color}`} spin={isRunning} />
          <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
          <span className="text-sm font-semibold text-od-text-bright">{run.name}</span>
          <span className="text-xs text-od-text-dim">({run.agent})</span>
          <div className="flex-1" />
          <span className="shrink-0 font-mono text-xs text-od-text-dim">
            {formatDuration(durationMs)}
            {tokens > 0 && ` · ${t.subagents.tokensLabel(tokens)}`}
          </span>
          <button
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.subagents.closePanel}
          >
            <Icon name="close" className="w-3" />
          </button>
        </div>

        {/* 任务描述 */}
        <div className="shrink-0 border-b border-od-border px-4 py-2">
          <div className="mb-0.5 text-xs text-od-text-dim">{t.subagents.taskLabel}</div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-od-text">
            {run.task}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-od-border px-3 pt-1.5">
          <button
            onClick={() => setTab('conversation')}
            className={tabClass(tab === 'conversation')}
          >
            {t.subagents.conversationLabel}
          </button>
          <button onClick={() => setTab('output')} className={tabClass(tab === 'output')}>
            {t.subagents.outputLabel}
          </button>
          <button onClick={() => setTab('tools')} className={tabClass(tab === 'tools')}>
            {t.subagents.toolCallsLabel}
            {toolCalls.length > 0 && (
              <span className="ml-1 font-mono text-od-text-dim">{toolCalls.length}</span>
            )}
          </button>
        </div>

        {/* Body */}
        <div ref={bodyRef} onScroll={handleBodyScroll} className="flex-1 overflow-y-auto px-4 py-3">
          {tab === 'conversation' ? (
            <div className="space-y-3">
              {/* 用户(任务) */}
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-od-text-dim">
                  <Icon name="clipboardList" className="w-3" />
                  {t.subagents.taskLabel}
                </div>
                <div className="whitespace-pre-wrap rounded border border-od-border bg-od-bg-dark px-3 py-2 text-xs leading-relaxed text-od-text">
                  {run.task}
                </div>
              </div>

              {/* 助手(正文/思考/工具调用,顺序即模型输出顺序) */}
              {transcript.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-od-text-dim">
                    <Icon name="robot" className="w-3" />
                    {t.subagents.assistantLabel}
                  </div>
                  <div className="space-y-2">
                    {transcript.map((item, i) => (
                      <TranscriptItemView
                        key={`${item.kind}:${item.at}:${i}`}
                        item={item}
                        toolCallMap={toolCallMap}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* 结果(submit 摘要 / 兜底最后回复) */}
              {run.error && (
                <div className="rounded border border-od-red/40 bg-od-bg px-3 py-2 text-xs text-od-red">
                  <div className="mb-0.5 font-medium">{t.subagents.errorLabel}</div>
                  <div className="whitespace-pre-wrap leading-relaxed">{run.error}</div>
                </div>
              )}
              {run.output ? (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-od-text-dim">
                    <Icon name="circleCheck" className="w-3" />
                    {t.subagents.outputLabel}
                  </div>
                  <div className="rounded border border-od-border bg-od-bg px-3 py-2">
                    <Markdown content={run.output} openLinksInBrowser />
                  </div>
                  {run.outputSource === 'fallback' && (
                    <div className="mt-1 text-xs text-od-text-dim">
                      {t.subagents.outputSourceFallback}
                    </div>
                  )}
                </div>
              ) : (
                !run.error &&
                isRunning && (
                  <div className="py-6 text-center text-xs text-od-text-dim">
                    {t.subagents.waitingOutput}
                  </div>
                )
              )}
            </div>
          ) : tab === 'output' ? (
            <div className="space-y-2">
              {run.error && (
                <div className="rounded border border-od-red/40 bg-od-bg px-3 py-2 text-xs text-od-red">
                  <div className="mb-0.5 font-medium">{t.subagents.errorLabel}</div>
                  <div className="whitespace-pre-wrap leading-relaxed">{run.error}</div>
                </div>
              )}
              {run.output ? (
                <div className="rounded border border-od-border bg-od-bg px-3 py-2">
                  <Markdown content={run.output} openLinksInBrowser />
                </div>
              ) : (
                !run.error && (
                  <div className="py-6 text-center text-xs text-od-text-dim">
                    {isRunning ? t.subagents.waitingOutput : t.subagents.noOutput}
                  </div>
                )
              )}
              {run.outputSource === 'fallback' && (
                <div className="text-xs text-od-text-dim">{t.subagents.outputSourceFallback}</div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {toolCalls.length === 0 ? (
                <div className="py-6 text-center text-xs text-od-text-dim">
                  {t.subagents.noToolCalls}
                </div>
              ) : (
                toolCalls.map((tc) => <ToolCallItem key={tc.toolCallId} tc={tc} />)
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
