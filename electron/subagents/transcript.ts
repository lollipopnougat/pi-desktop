/**
 * 子 agent 对话流采集:把子 session 的 AgentEvent 折算成详情弹窗「对话」Tab 的条目序列。
 *
 * 设计:
 * - 每条 assistant 消息在流式期间先占一个 `stream` 条目(message_start 创建、
 *   message_update 就地更新),消息结束时(message_end)替换为按内容块顺序排列的
 *   text/thinking/tool 条目 —— 保证最终顺序与模型实际输出一致
 *   (正文 → 工具调用 → 思考 → 正文 …),与主对话的渲染粒度对齐。
 * - tool 条目只存 toolCallId:参数/结果仍由 `ChildRun.toolCalls` 流水提供(单一数据源)。
 * - 纯函数 + 无副作用:调用方(executor)整体 try/catch,采集失败绝不影响子 agent 执行。
 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChildTranscriptItem } from './types';

/** 对话流条目上限(超出丢弃最旧,防长任务快照膨胀) */
export const MAX_TRANSCRIPT_ITEMS = 300;
/** 单条正文/思考文本上限(超长截断,防单条撑爆快照) */
export const MAX_TRANSCRIPT_TEXT_CHARS = 8000;

/** 从消息内容块提取正文/思考/工具调用 id(流式与结束时通用) */
export function extractMessageContent(message: unknown): {
  text: string;
  thinking: string;
  toolCallIds: string[];
} {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return { text: '', thinking: '', toolCallIds: [] };
  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCallIds: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; thinking?: string; id?: string } | null;
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b?.type === 'thinking' && typeof b.thinking === 'string') thinkings.push(b.thinking);
    else if (b?.type === 'toolCall' && typeof b.id === 'string') toolCallIds.push(b.id);
  }
  return {
    text: clipText(texts.join('\n\n')),
    thinking: clipText(thinkings.join('\n\n')),
    toolCallIds
  };
}

/** 超长文本截断(保留头部,尾部标注省略量) */
export function clipText(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_TEXT_CHARS) return text;
  const omitted = text.length - MAX_TRANSCRIPT_TEXT_CHARS;
  return `${text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS)}…(已省略 ${omitted} 字符)`;
}

function isAssistant(message: unknown): boolean {
  return (message as { role?: string } | null)?.role === 'assistant';
}

function isStreamItem(
  item: ChildTranscriptItem | undefined
): item is Extract<ChildTranscriptItem, { kind: 'stream' }> {
  return item?.kind === 'stream';
}

/** 按内容块顺序把一条 assistant 消息折算成最终条目 */
function appendFinalItems(transcript: ChildTranscriptItem[], message: unknown, at: number): void {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = block as { type?: string; text?: string; thinking?: string; id?: string } | null;
    if (b?.type === 'text' && b.text) {
      transcript.push({ kind: 'text', at, text: clipText(b.text) });
    } else if (b?.type === 'thinking' && b.thinking) {
      transcript.push({ kind: 'thinking', at, text: clipText(b.thinking) });
    } else if (b?.type === 'toolCall' && b.id) {
      transcript.push({ kind: 'tool', at, toolCallId: b.id });
    }
  }
}

/**
 * 应用一个事件到对话流;返回是否有变化(调用方据此决定是否推送快照)。
 * 只关心 assistant 消息与工具调用,其余事件(用户消息/agent 生命周期)返回 false。
 */
export function applyTranscriptEvent(
  transcript: ChildTranscriptItem[],
  event: AgentSessionEvent
): boolean {
  switch (event.type) {
    case 'message_start': {
      if (!isAssistant(event.message)) return false;
      transcript.push({ kind: 'stream', at: Date.now(), text: '', thinking: '', toolCallIds: [] });
      return true;
    }
    case 'message_update': {
      if (!isAssistant(event.message)) return false;
      const last = transcript[transcript.length - 1];
      if (!isStreamItem(last)) return false;
      const { text, thinking, toolCallIds } = extractMessageContent(event.message);
      last.text = text;
      last.thinking = thinking;
      last.toolCallIds = toolCallIds;
      return true;
    }
    case 'message_end': {
      if (!isAssistant(event.message)) return false;
      if (isStreamItem(transcript[transcript.length - 1])) transcript.pop();
      appendFinalItems(transcript, event.message, Date.now());
      return true;
    }
    case 'tool_execution_start': {
      // 兜底:message_end 未捕获或内容块缺失时,工具调用也要出现在对话里
      if (!transcript.some((i) => i.kind === 'tool' && i.toolCallId === event.toolCallId)) {
        transcript.push({ kind: 'tool', at: Date.now(), toolCallId: event.toolCallId });
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** 采集后统一裁剪(条目上限,丢弃最旧) */
export function trimTranscript(transcript: ChildTranscriptItem[]): void {
  if (transcript.length > MAX_TRANSCRIPT_ITEMS) {
    transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ITEMS);
  }
}
