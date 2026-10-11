/**
 * 子 agent 对话流采集单测(纯函数,不依赖 SDK 运行时)。
 * 覆盖:流式占位 → 结束时按内容块顺序落条目 / 非 assistant 消息忽略 /
 * 工具调用兜底 / 文本截断 / 条目上限。
 */
import { describe, it, expect } from 'vitest';
import {
  applyTranscriptEvent,
  clipText,
  extractMessageContent,
  trimTranscript,
  MAX_TRANSCRIPT_ITEMS,
  MAX_TRANSCRIPT_TEXT_CHARS
} from '../../electron/subagents/transcript';
import type { ChildTranscriptItem } from '../../electron/subagents/types';

/** 事件只需 type/message 字段,这里用宽松构造避免耦合 SDK 类型细节 */
const event = (e: Record<string, unknown>) => e as never;

const assistantMessage = (content: unknown[]) => ({ role: 'assistant', content });

describe('对话流采集', () => {
  it('流式消息:start 占位 → update 就地更新 → end 按内容块顺序落最终条目', () => {
    const transcript: ChildTranscriptItem[] = [];

    expect(
      applyTranscriptEvent(
        transcript,
        event({ type: 'message_start', message: assistantMessage([]) })
      )
    ).toBe(true);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      kind: 'stream',
      text: '',
      thinking: '',
      toolCallIds: []
    });

    // 流式增量:正文 + 思考 + 已声明的工具调用
    expect(
      applyTranscriptEvent(
        transcript,
        event({
          type: 'message_update',
          message: assistantMessage([
            { type: 'text', text: '正在读取' },
            { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'thinking', thinking: '先看入口' }
          ])
        })
      )
    ).toBe(true);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      kind: 'stream',
      text: '正在读取',
      thinking: '先看入口',
      toolCallIds: ['tc-1']
    });

    // 消息结束:占位替换为最终条目,顺序 = 内容块顺序
    expect(
      applyTranscriptEvent(
        transcript,
        event({
          type: 'message_end',
          message: assistantMessage([
            { type: 'text', text: '正在读取 a.ts' },
            { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'thinking', thinking: '先看入口' },
            { type: 'toolCall', id: 'tc-2', name: 'grep', arguments: { pattern: 'catch' } }
          ])
        })
      )
    ).toBe(true);
    expect(transcript.map((i) => i.kind)).toEqual(['text', 'tool', 'thinking', 'tool']);
    expect(transcript[0]).toMatchObject({ kind: 'text', text: '正在读取 a.ts' });
    expect(transcript[1]).toMatchObject({ kind: 'tool', toolCallId: 'tc-1' });
    expect(transcript[2]).toMatchObject({ kind: 'thinking', text: '先看入口' });
    expect(transcript[3]).toMatchObject({ kind: 'tool', toolCallId: 'tc-2' });
  });

  it('非 assistant 消息(用户/工具结果)不产生条目', () => {
    const transcript: ChildTranscriptItem[] = [];
    expect(
      applyTranscriptEvent(
        transcript,
        event({
          type: 'message_start',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        })
      )
    ).toBe(false);
    expect(
      applyTranscriptEvent(
        transcript,
        event({
          type: 'message_end',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] }
        })
      )
    ).toBe(false);
    expect(transcript).toEqual([]);
  });

  it('缺少 message_start 时 message_end 仍能落最终条目', () => {
    const transcript: ChildTranscriptItem[] = [];
    applyTranscriptEvent(
      transcript,
      event({ type: 'message_end', message: assistantMessage([{ type: 'text', text: 'done' }]) })
    );
    expect(transcript).toMatchObject([{ kind: 'text', text: 'done' }]);
  });

  it('message_update 没有流式占位时不产生条目', () => {
    const transcript: ChildTranscriptItem[] = [];
    expect(
      applyTranscriptEvent(
        transcript,
        event({ type: 'message_update', message: assistantMessage([{ type: 'text', text: 'x' }]) })
      )
    ).toBe(false);
    expect(transcript).toEqual([]);
  });

  it('工具调用兜底:内容块缺失时补 tool 条目,已存在则不重复', () => {
    const transcript: ChildTranscriptItem[] = [];
    expect(
      applyTranscriptEvent(
        transcript,
        event({ type: 'tool_execution_start', toolCallId: 'tc-9', toolName: 'bash', args: {} })
      )
    ).toBe(true);
    expect(transcript).toMatchObject([{ kind: 'tool', toolCallId: 'tc-9' }]);
    // 第二次(start 重放/end 后的重复事件)不重复追加
    expect(
      applyTranscriptEvent(
        transcript,
        event({ type: 'tool_execution_start', toolCallId: 'tc-9', toolName: 'bash', args: {} })
      )
    ).toBe(false);
    expect(transcript).toHaveLength(1);
  });

  it('extractMessageContent 合并多个同类型块(正文/思考各段以空行分隔)', () => {
    const { text, thinking, toolCallIds } = extractMessageContent(
      assistantMessage([
        { type: 'text', text: 'A' },
        { type: 'thinking', thinking: 'T1' },
        { type: 'text', text: 'B' },
        { type: 'thinking', thinking: 'T2' },
        { type: 'toolCall', id: 'tc-1', name: 'read', arguments: {} }
      ])
    );
    expect(text).toBe('A\n\nB');
    expect(thinking).toBe('T1\n\nT2');
    expect(toolCallIds).toEqual(['tc-1']);
  });

  it('超长文本截断并标注省略量', () => {
    const short = 'x'.repeat(10);
    expect(clipText(short)).toBe(short);
    const long = 'y'.repeat(MAX_TRANSCRIPT_TEXT_CHARS + 25);
    const clipped = clipText(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped).toContain('已省略 25 字符');
  });

  it('条目上限:超出丢弃最旧', () => {
    const transcript: ChildTranscriptItem[] = Array.from(
      { length: MAX_TRANSCRIPT_ITEMS + 5 },
      (_, i) => ({
        kind: 'text' as const,
        at: i,
        text: `t${i}`
      })
    );
    trimTranscript(transcript);
    expect(transcript).toHaveLength(MAX_TRANSCRIPT_ITEMS);
    expect(transcript[0].kind === 'text' && transcript[0].text).toBe('t5');
  });
});
