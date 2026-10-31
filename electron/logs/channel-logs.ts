/**
 * 除决策模型之外的日志通道（模型 / 工具 / 审批 / 应用）。
 *
 * 输出：`~/.pi-desktop/logs/<channel>-YYYY-MM-DD.log`，一行一个 JSON。
 * 各通道的 `phase` 语义：
 * - model：`prompt`（用户/系统输入摘要）、`response`（助手回复 + 用量 + 耗时）、
 *   `retry`（SDK 自动重试）、`compaction`（上下文压缩）、`error`
 * - tools：`gate`（权限闸门判定结论）、`exec`（工具执行结果与耗时）
 * - permission：`request`（弹出的人工审批请求）、`decision`（用户的允许/拒绝）
 * - app：`start`（启动）、`quit`（退出）、`error`（未捕获异常）、`config`（日志配置变更）、
 *   `slots`（会话槽生命周期：焦点切换 / 槽释放 / 中止 / MCP 重指）、
 *   `images`（丢弃会话历史里的非法图片块，见 docs/report2.md）
 *
 * **默认不落正文**：文本一律经 textSummary —— info 级只给字符数，debug 级才带开头预览。
 * 需要完整内容时由调用方自己补充字段（例如决策模型的 state/questions）。
 */
import { logEvent, textSummary, type LogLevel } from './logger';

export const MODEL_LOG_CHANNEL = 'model';
export const TOOL_LOG_CHANNEL = 'tools';
export const PERMISSION_LOG_CHANNEL = 'permission';
export const APP_LOG_CHANNEL = 'app';

export function logModelEvent(entry: Record<string, unknown>, level: LogLevel = 'info'): void {
  logEvent(MODEL_LOG_CHANNEL, entry, level);
}

export function logToolEvent(entry: Record<string, unknown>, level: LogLevel = 'info'): void {
  logEvent(TOOL_LOG_CHANNEL, entry, level);
}

export function logPermissionEvent(entry: Record<string, unknown>, level: LogLevel = 'info'): void {
  logEvent(PERMISSION_LOG_CHANNEL, entry, level);
}

export function logAppEvent(entry: Record<string, unknown>, level: LogLevel = 'info'): void {
  logEvent(APP_LOG_CHANNEL, entry, level);
}

/** 助手消息内容摘要：只统计规模 + 工具调用名，不落正文 */
export interface ContentSummary {
  textChars: number;
  thinkingChars: number;
  images: number;
  toolCalls: { name: string; argChars: number }[];
}

export function summarizeContent(content: unknown): ContentSummary {
  const summary: ContentSummary = { textChars: 0, thinkingChars: 0, images: 0, toolCalls: [] };
  if (!Array.isArray(content)) return summary;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (item.type === 'text' && typeof item.text === 'string') {
      summary.textChars += item.text.length;
    } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
      summary.thinkingChars += item.thinking.length;
    } else if (item.type === 'image') {
      summary.images += 1;
    } else if (item.type === 'toolCall') {
      const args =
        typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      summary.toolCalls.push({
        name: typeof item.name === 'string' ? item.name : 'unknown',
        argChars: args.length
      });
    }
  }
  return summary;
}

/** 工具入参摘要：字符数 +（debug 时）预览 */
export function describeArgs(input: unknown): { chars: number; preview?: string } {
  // 无入参（读类工具的常见情形）：直接 0，不要报成 "{}" 的 2 字符
  if (input === null || input === undefined) return { chars: 0 };
  let text: string;
  try {
    text = typeof input === 'string' ? input : (JSON.stringify(input ?? {}) ?? '');
  } catch {
    text = '[无法序列化]';
  }
  return textSummary(text);
}
