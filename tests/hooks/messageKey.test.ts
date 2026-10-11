/**
 * messageKey 逻辑测试
 *
 * messageKey 是 usePiEvent.ts 中的核心去重函数,用于生成消息的稳定唯一键。
 * SDK 的消息没有全局唯一 id,timestamp 是毫秒精度,多个 toolResult 可能在
 * 同一毫秒产生。messageKey 用复合键策略避免误杀。
 */
import { describe, it, expect } from 'vitest';

import { messageKey } from '../../src/utils/session-messages';

describe('messageKey', () => {
  it('uses toolCallId for toolResult messages', () => {
    const msg = { role: 'toolResult', toolCallId: 'call_abc123', timestamp: 1700000000000 };
    expect(messageKey(msg)).toBe('toolResult:call_abc123');
  });

  it('uses role:timestamp for user messages', () => {
    const msg = { role: 'user', timestamp: 1700000000000 };
    expect(messageKey(msg)).toBe('user:1700000000000');
  });

  it('uses role:timestamp for assistant messages', () => {
    const msg = { role: 'assistant', timestamp: 1700000000000 };
    expect(messageKey(msg)).toBe('assistant:1700000000000');
  });

  it('differentiates toolResults with same timestamp but different toolCallId', () => {
    const ts = 1700000000000;
    const msg1 = { role: 'toolResult', toolCallId: 'call_a', timestamp: ts };
    const msg2 = { role: 'toolResult', toolCallId: 'call_b', timestamp: ts };
    expect(messageKey(msg1)).not.toBe(messageKey(msg2));
  });

  it('differentiates user and assistant with same timestamp', () => {
    const ts = 1700000000000;
    const userMsg = { role: 'user', timestamp: ts };
    const assistantMsg = { role: 'assistant', timestamp: ts };
    expect(messageKey(userMsg)).not.toBe(messageKey(assistantMsg));
  });

  it('falls back to role:timestamp for toolResult without toolCallId', () => {
    const msg = { role: 'toolResult', timestamp: 1700000000000 };
    expect(messageKey(msg)).toBe('toolResult:1700000000000');
  });

  it('handles same-timestamp toolResult and user message without collision', () => {
    const ts = 1700000000000;
    const toolResult = { role: 'toolResult', toolCallId: 'call_x', timestamp: ts };
    const userMsg = { role: 'user', timestamp: ts };
    expect(messageKey(toolResult)).not.toBe(messageKey(userMsg));
  });

  it('produces consistent keys for identical messages', () => {
    const msg = { role: 'assistant', timestamp: 1700000000000 };
    expect(messageKey(msg)).toBe(messageKey(msg));
  });
});
