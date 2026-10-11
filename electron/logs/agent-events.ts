/**
 * 把 SDK 的会话事件映射成 `model` / `tools` 两个通道的日志。
 *
 * 在 PiBridge 的事件订阅里调用（`electron/pi-bridge.ts` 的 rebind）——
 * **与渲染无关**：窗口关掉后事件照样落盘，排查「界面没反应」时很有用。
 *
 * 记录范围：
 * - `model`：`prompt`（用户输入规模）、`response`（助手回复的 provider/model/api/stopReason/
 *   usage/耗时/内容规模）、`retry`（SDK 自动重试）、`compaction`（上下文压缩）
 * - `tools`：`exec`（工具执行结果、耗时、是否报错、输出字符数）
 *
 * 正文一律不落（见 channel-logs 的 textSummary 约定），只有规模与结论。
 */
import { describeArgs, logModelEvent, logToolEvent, summarizeContent } from './channel-logs';

/** toolCallId → 起始时间（算工具耗时）与入参（end 事件不带 args）；执行结束后删除 */
const activeTools = new Map<string, { startedAt: number; args: unknown }>();

/** 仅供测试：清空进行中的工具表 */
export function resetAgentEventLogState(): void {
  activeTools.clear();
}

/** 工具结果只统计输出字符数，不落正文 */
function summarizeToolResult(result: unknown): { contentChars: number } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  let chars = 0;
  for (const part of content) {
    if (part && typeof part === 'object') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') chars += text.length;
    }
  }
  return { contentChars: chars };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * 记录一条会话事件（不认识的事件类型直接忽略）。
 * 入参是 SDK 的 AgentSessionEvent，这里刻意用宽类型：事件 union 成员多，
 * 且 SDK 升级会新增成员，用窄类型反而会挡住日志（缺字段只是少一行信息）。
 */
export function logAgentEvent(event: unknown): void {
  const e = asRecord(event);
  const type = e.type;

  if (type === 'message_end') {
    const message = asRecord(e.message);
    if (message.role === 'user') {
      logModelEvent({ phase: 'prompt', role: 'user', content: summarizeContent(message.content) });
      return;
    }
    if (message.role === 'assistant') {
      const startedAt = typeof message.timestamp === 'number' ? message.timestamp : 0;
      logModelEvent(
        {
          phase: 'response',
          provider: message.provider ?? null,
          model: message.model ?? null,
          api: message.api ?? null,
          ...(message.responseModel ? { responseModel: message.responseModel } : {}),
          ...(message.providerThinkingLevel
            ? { thinkingLevel: message.providerThinkingLevel }
            : {}),
          stopReason: message.stopReason ?? null,
          ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
          ...(message.usage ? { usage: message.usage } : {}),
          ...(startedAt ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
          content: summarizeContent(message.content)
        },
        message.stopReason === 'error' ? 'warn' : 'info'
      );
    }
    return;
  }

  if (type === 'tool_execution_start') {
    // SDK 的 tool_execution_end 事件不带 args（只有 result/isError），所以入参必须在这里存下来
    if (e.toolCallId !== undefined) {
      activeTools.set(String(e.toolCallId), { startedAt: Date.now(), args: e.args });
    }
    return;
  }

  if (type === 'tool_execution_end') {
    const id = e.toolCallId === undefined ? '' : String(e.toolCallId);
    const active = activeTools.get(id);
    activeTools.delete(id);
    const isError = e.isError === true;
    const resultSummary = summarizeToolResult(e.result);
    logToolEvent(
      {
        phase: 'exec',
        tool: e.toolName ?? null,
        ...(active ? { durationMs: Date.now() - active.startedAt } : {}),
        isError,
        args: describeArgs(active ? active.args : undefined),
        ...(resultSummary ? { result: resultSummary } : {})
      },
      isError ? 'warn' : 'info'
    );
    return;
  }

  if (type === 'auto_retry_start') {
    logModelEvent(
      {
        phase: 'retry',
        stage: 'start',
        attempt: e.attempt ?? null,
        maxAttempts: e.maxAttempts ?? null,
        delayMs: e.delayMs ?? null,
        errorMessage: e.errorMessage ?? null
      },
      'warn'
    );
    return;
  }

  if (type === 'auto_retry_end') {
    const success = e.success === true;
    logModelEvent(
      {
        phase: 'retry',
        stage: 'end',
        success,
        attempt: e.attempt ?? null,
        ...(e.finalError ? { finalError: e.finalError } : {})
      },
      success ? 'info' : 'warn'
    );
    return;
  }

  if (type === 'compaction_start') {
    logModelEvent({ phase: 'compaction', stage: 'start', reason: e.reason ?? null });
    return;
  }

  if (type === 'compaction_end') {
    const result = asRecord(e.result);
    const aborted = e.aborted === true;
    const errorMessage = typeof e.errorMessage === 'string' ? e.errorMessage : '';
    logModelEvent(
      {
        phase: 'compaction',
        stage: 'end',
        reason: e.reason ?? null,
        aborted,
        willRetry: e.willRetry === true,
        ...(errorMessage ? { errorMessage } : {}),
        ...(Object.keys(result).length > 0 ? { result: Object.keys(result) } : {})
      },
      aborted || errorMessage ? 'warn' : 'info'
    );
  }
}
