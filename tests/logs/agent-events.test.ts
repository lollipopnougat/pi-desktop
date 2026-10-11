import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-agent-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import { logAgentEvent, resetAgentEventLogState } from '../../electron/logs/agent-events';
import {
  DEFAULT_LOG_CONFIG,
  getLogFilePath,
  resetLogStateForTest,
  setLogConfig
} from '../../electron/logs/logger';

function readChannel(channel: string): Record<string, any>[] {
  const file = getLogFilePath(channel);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('logs/agent-events', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    resetLogStateForTest();
    resetAgentEventLogState();
    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels }
    });
  });

  it('message_end（用户）→ model channel 的 prompt 行', () => {
    logAgentEvent({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] }
    });
    const lines = readChannel('model');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ phase: 'prompt', role: 'user' });
    expect(lines[0].content).toEqual({ textChars: 2, thinkingChars: 0, images: 0, toolCalls: [] });
  });

  it('message_end（助手）→ response 行：模型、停止原因、用量、耗时', () => {
    const startedAt = Date.now() - 1234;
    logAgentEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        api: 'anthropic-messages',
        stopReason: 'toolUse',
        timestamp: startedAt,
        usage: { input: 100, output: 20, totalTokens: 120 },
        content: [
          { type: 'text', text: 'ok' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }
        ]
      }
    });
    const [line] = readChannel('model');
    expect(line).toMatchObject({
      phase: 'response',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      api: 'anthropic-messages',
      stopReason: 'toolUse',
      level: 'info'
    });
    expect(line.usage.totalTokens).toBe(120);
    expect(line.durationMs).toBeGreaterThanOrEqual(1200);
    expect(line.content.textChars).toBe(2);
    expect(line.content.toolCalls[0].name).toBe('bash');
  });

  it('message_end（助手）stopReason=error → level=warn 且带 errorMessage', () => {
    logAgentEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' }
    });
    const [line] = readChannel('model');
    expect(line).toMatchObject({ phase: 'response', stopReason: 'error', level: 'warn' });
    expect(line.errorMessage).toBe('rate limited');
  });

  it('tool_execution_start/end → tools channel 一行 exec，含耗时与结果字符数', () => {
    logAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'ls' }
    });
    // start 不单独落行，避免每个工具记两条
    expect(readChannel('tools')).toHaveLength(0);

    logAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'file-a\nfile-b\n' }] }
    });
    const [line] = readChannel('tools');
    expect(line).toMatchObject({ phase: 'exec', tool: 'bash', isError: false, level: 'info' });
    expect(line.args.chars).toBe(JSON.stringify({ command: 'ls' }).length);
    expect(line.result).toEqual({ contentChars: 14 });
  });

  it('工具报错 → level=warn；没有 start 事件时不写 durationMs（不抛错）', () => {
    logAgentEvent({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', isError: true });
    const [line] = readChannel('tools');
    expect(line).toMatchObject({ phase: 'exec', tool: 'read', isError: true, level: 'warn' });
    expect(line.durationMs).toBeUndefined();
  });

  it('自动重试事件 → model channel 的 retry 行（start warn / end 按结果）', () => {
    logAgentEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'overloaded'
    });
    logAgentEvent({ type: 'auto_retry_end', success: true, attempt: 1 });
    logAgentEvent({
      type: 'auto_retry_end',
      success: false,
      attempt: 3,
      finalError: 'still failing'
    });

    const lines = readChannel('model');
    expect(lines[0]).toMatchObject({ phase: 'retry', stage: 'start', attempt: 1, level: 'warn' });
    expect(lines[0].errorMessage).toBe('overloaded');
    expect(lines[1]).toMatchObject({ phase: 'retry', stage: 'end', success: true, level: 'info' });
    expect(lines[2]).toMatchObject({ phase: 'retry', stage: 'end', success: false, level: 'warn' });
    expect(lines[2].finalError).toBe('still failing');
  });

  it('上下文压缩事件 → compaction 行；中止或报错记 warn', () => {
    logAgentEvent({ type: 'compaction_start', reason: 'threshold' });
    logAgentEvent({
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: false,
      result: { foo: 1 }
    });
    logAgentEvent({ type: 'compaction_end', reason: 'overflow', aborted: true, willRetry: false });

    const lines = readChannel('model');
    expect(lines[0]).toMatchObject({
      phase: 'compaction',
      stage: 'start',
      reason: 'threshold',
      level: 'info'
    });
    expect(lines[1]).toMatchObject({
      phase: 'compaction',
      stage: 'end',
      willRetry: false,
      level: 'info'
    });
    expect(lines[1].result).toEqual(['foo']);
    expect(lines[2]).toMatchObject({
      phase: 'compaction',
      stage: 'end',
      aborted: true,
      level: 'warn'
    });
  });

  it('无关 / 畸形事件安全忽略（不抛错、不落盘）', () => {
    logAgentEvent(undefined);
    logAgentEvent({});
    logAgentEvent({ type: 'message_start' });
    logAgentEvent({ type: 'unknown_future_event', payload: 1 });
    expect(readChannel('model')).toHaveLength(0);
    expect(readChannel('tools')).toHaveLength(0);
  });

  it('resetAgentEventLogState 清空耗时表（避免跨会话串用耗时）', () => {
    logAgentEvent({ type: 'tool_execution_start', toolCallId: 't9', toolName: 'bash' });
    resetAgentEventLogState();
    logAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 't9',
      toolName: 'bash',
      isError: false
    });
    expect(readChannel('tools')[0].durationMs).toBeUndefined();
  });
});
