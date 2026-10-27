/**
 * 用户钩子内联扩展工厂：把 SDK 扩展事件桥接到 hooks.json 的 shell 钩子。
 *
 * 事件与能力映射（事件 JSON 一律经 stdin 传入，PI_HOOK_EVENT 环境变量同名字符串）：
 * - 可阻止（退出码 2 → 阻止/取消）：
 *   tool_call / input / session_before_compact / session_before_switch / session_before_fork
 * - 可改写（stdout 非空 → 替换文本）：
 *   input（替换用户输入文本）
 * - 观察：其余全部
 *
 * 与 goal/plan/memory 扩展同级，经 extensionFactories 无条件注入，
 * noExtensions: true 只关闭 pi CLI 用户扩展目录，不影响本扩展。
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { runHooksForEvent } from './runner';
import type { HookEvent } from './config';

const MAX_TEXT = 4000;

function truncate(s: string, n = MAX_TEXT): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 从 assistant 消息提取纯文本（跳过 thinking/toolCall） */
function assistantText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as { role?: unknown; content?: unknown };
  if (m.role !== 'assistant' || !Array.isArray(m.content)) return '';
  return m.content
    .filter((c): c is { type: 'text'; text: string } => !!c && (c as any).type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** 从任意消息提取文本预览（图片占位） */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as { content?: unknown };
  // custom message 的 content 可能是字符串（不是内容数组）
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content
    .map((c) =>
      c && typeof c === 'object' && (c as any).type === 'text'
        ? String((c as any).text ?? '')
        : '[非文本]'
    )
    .join('\n');
}

/** 从 tool_result content 提取文本预览（图片占位） */
function contentText(content: unknown): string {
  return messageText({ content });
}

/** 通用观察型事件：跑钩子、丢弃返回值 */
async function observe(event: HookEvent, payload: Record<string, unknown>, cwd: string) {
  await runHooksForEvent(event, { timestamp: Date.now(), ...payload }, cwd);
}

export function hookExtensionFactory(): InlineExtension {
  return {
    name: 'user-hooks',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // ─── 可阻止：tool_call（block 工具执行） ───
      pi.on('tool_call', async (event, ctx) => {
        const summary = await runHooksForEvent(
          'tool_call',
          {
            hookEvent: 'tool_call',
            timestamp: Date.now(),
            cwd: ctx.cwd,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.input
          },
          ctx.cwd
        );
        if (summary.blocked) {
          return { block: true, reason: summary.reason };
        }
      });

      // ─── 可阻止 + 可改写：input（拦截/替换用户输入） ───
      pi.on('input', async (event, ctx) => {
        const summary = await runHooksForEvent(
          'input',
          {
            hookEvent: 'input',
            timestamp: Date.now(),
            cwd: ctx.cwd,
            text: event.text,
            source: event.source,
            streamingBehavior: event.streamingBehavior
          },
          ctx.cwd
        );
        if (summary.blocked) {
          return { action: 'handled' };
        }
        if (summary.transformed !== undefined && summary.transformed !== event.text) {
          return { action: 'transform', text: summary.transformed };
        }
      });

      // ─── 可阻止：session_before_compact（取消压缩） ───
      pi.on('session_before_compact', async (event, ctx) => {
        const summary = await runHooksForEvent(
          'session_before_compact',
          {
            hookEvent: 'session_before_compact',
            timestamp: Date.now(),
            cwd: ctx.cwd,
            reason: event.reason,
            willRetry: event.willRetry,
            entryCount: event.branchEntries?.length
          },
          ctx.cwd
        );
        if (summary.blocked) {
          return { cancel: true };
        }
      });

      // ─── 可阻止：session_before_switch（取消切换） ───
      pi.on('session_before_switch', async (event, ctx) => {
        const summary = await runHooksForEvent(
          'session_before_switch',
          {
            hookEvent: 'session_before_switch',
            timestamp: Date.now(),
            cwd: ctx.cwd,
            reason: event.reason,
            targetSessionFile: event.targetSessionFile
          },
          ctx.cwd
        );
        if (summary.blocked) {
          return { cancel: true };
        }
      });

      // ─── 可阻止：session_before_fork（取消分叉） ───
      pi.on('session_before_fork', async (event, ctx) => {
        const summary = await runHooksForEvent(
          'session_before_fork',
          {
            hookEvent: 'session_before_fork',
            timestamp: Date.now(),
            cwd: ctx.cwd,
            entryId: event.entryId,
            position: event.position
          },
          ctx.cwd
        );
        if (summary.blocked) {
          return { cancel: true };
        }
      });

      // ─── 观察：before_agent_start（本轮提示词/system prompt） ───
      // 注意：SDK 1.2.0 起本事件是 user | custom 联合事件——
      // 只有 user run 带 prompt，pi.sendMessage({ triggerTurn: true }) 起的 custom run 只有 message。
      pi.on('before_agent_start', async (event, ctx) => {
        await observe(
          'before_agent_start',
          {
            hookEvent: 'before_agent_start',
            messageType: event.messageType,
            cwd: ctx.cwd,
            prompt: truncate(
              event.messageType === 'user' ? event.prompt : messageText(event.message)
            ),
            systemPrompt: truncate(event.systemPrompt)
          },
          ctx.cwd
        );
      });

      // ─── 观察：message_end（任意消息结束） ───
      pi.on('message_end', async (event, ctx) => {
        await observe(
          'message_end',
          {
            hookEvent: 'message_end',
            cwd: ctx.cwd,
            role: (event.message as any)?.role,
            text: truncate(messageText(event.message))
          },
          ctx.cwd
        );
      });

      // ─── 观察：agent_start / agent_end / agent_settled ───
      pi.on('agent_start', async (_event, ctx) => {
        await observe('agent_start', { hookEvent: 'agent_start', cwd: ctx.cwd }, ctx.cwd);
      });

      pi.on('agent_end', async (event, ctx) => {
        const lastAssistant = [...event.messages]
          .reverse()
          .find((m) => (m as any)?.role === 'assistant');
        await observe(
          'agent_end',
          {
            hookEvent: 'agent_end',
            cwd: ctx.cwd,
            messageCount: event.messages.length,
            lastAssistantText: truncate(assistantText(lastAssistant))
          },
          ctx.cwd
        );
      });

      pi.on('agent_settled', async (_event, ctx) => {
        await observe('agent_settled', { hookEvent: 'agent_settled', cwd: ctx.cwd }, ctx.cwd);
      });

      // ─── 观察：tool_result ───
      pi.on('tool_result', async (event, ctx) => {
        await observe(
          'tool_result',
          {
            hookEvent: 'tool_result',
            cwd: ctx.cwd,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.input,
            isError: event.isError,
            output: truncate(contentText(event.content))
          },
          ctx.cwd
        );
      });

      // ─── 观察：session_start / session_compact / session_shutdown ───
      pi.on('session_start', async (event, ctx) => {
        await observe(
          'session_start',
          {
            hookEvent: 'session_start',
            cwd: ctx.cwd,
            reason: event.reason,
            previousSessionFile: event.previousSessionFile
          },
          ctx.cwd
        );
      });

      pi.on('session_compact', async (event, ctx) => {
        await observe(
          'session_compact',
          {
            hookEvent: 'session_compact',
            cwd: ctx.cwd,
            reason: event.reason,
            willRetry: event.willRetry
          },
          ctx.cwd
        );
      });

      pi.on('session_shutdown', async (event, ctx) => {
        await observe(
          'session_shutdown',
          {
            hookEvent: 'session_shutdown',
            cwd: ctx.cwd,
            reason: event.reason,
            targetSessionFile: event.targetSessionFile
          },
          ctx.cwd
        );
      });

      // ─── 观察：provider 请求/响应 ───
      pi.on('before_provider_request', async (_event, ctx) => {
        await observe(
          'before_provider_request',
          { hookEvent: 'before_provider_request', cwd: ctx.cwd },
          ctx.cwd
        );
      });

      pi.on('after_provider_response', async (event, ctx) => {
        await observe(
          'after_provider_response',
          { hookEvent: 'after_provider_response', cwd: ctx.cwd, status: event.status },
          ctx.cwd
        );
      });

      // ─── 观察：model_select / thinking_level_select ───
      pi.on('model_select', async (event, ctx) => {
        await observe(
          'model_select',
          {
            hookEvent: 'model_select',
            cwd: ctx.cwd,
            provider: (event.model as any)?.provider,
            model: (event.model as any)?.id,
            previousModel: (event.previousModel as any)?.id,
            source: event.source
          },
          ctx.cwd
        );
      });

      pi.on('thinking_level_select', async (event, ctx) => {
        await observe(
          'thinking_level_select',
          {
            hookEvent: 'thinking_level_select',
            cwd: ctx.cwd,
            level: event.level,
            previousLevel: event.previousLevel
          },
          ctx.cwd
        );
      });
    }
  };
}
