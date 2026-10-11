import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-channel-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import {
  APP_LOG_CHANNEL,
  MODEL_LOG_CHANNEL,
  PERMISSION_LOG_CHANNEL,
  TOOL_LOG_CHANNEL,
  describeArgs,
  logAppEvent,
  logModelEvent,
  logPermissionEvent,
  logToolEvent,
  summarizeContent
} from '../../electron/logs/channel-logs';
import {
  DEFAULT_LOG_CONFIG,
  getLogFilePath,
  getLogsDir,
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

describe('logs/channel-logs', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    resetLogStateForTest();
    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels }
    });
  });

  it('channel 名称为 model / tools / permission / app（与设置页开关一致）', () => {
    expect([MODEL_LOG_CHANNEL, TOOL_LOG_CHANNEL, PERMISSION_LOG_CHANNEL, APP_LOG_CHANNEL]).toEqual([
      'model',
      'tools',
      'permission',
      'app'
    ]);
  });

  it('四个写入函数分别落到各自 channel，并带 level', () => {
    logModelEvent({ phase: 'response', model: 'gpt-5' });
    logToolEvent({ phase: 'exec', tool: 'bash' }, 'warn');
    logPermissionEvent({ phase: 'request', id: 'p1' });
    logAppEvent({ phase: 'start', version: '1.0.0' });

    const model = readChannel('model');
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ channel: 'model', level: 'info', phase: 'response' });

    const tools = readChannel('tools');
    expect(tools[0]).toMatchObject({ channel: 'tools', level: 'warn', tool: 'bash' });

    const permission = readChannel('permission');
    expect(permission[0]).toMatchObject({ channel: 'permission', id: 'p1' });

    const app = readChannel('app');
    expect(app[0]).toMatchObject({ channel: 'app', version: '1.0.0' });
  });

  it('关闭某个功能后该 channel 不再写入，其它 channel 不受影响', () => {
    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels, model: false }
    });
    logModelEvent({ phase: 'response' });
    logToolEvent({ phase: 'exec' });
    expect(readChannel('model')).toHaveLength(0);
    expect(readChannel('tools')).toHaveLength(1);
  });

  it('总开关关闭后任何 channel 都不写入', () => {
    setLogConfig({ ...DEFAULT_LOG_CONFIG, enabled: false });
    logModelEvent({ phase: 'response' });
    logToolEvent({ phase: 'exec' });
    logPermissionEvent({ phase: 'request' });
    logAppEvent({ phase: 'quit' });
    expect(readChannel('model')).toHaveLength(0);
    expect(readChannel('tools')).toHaveLength(0);
    expect(readChannel('permission')).toHaveLength(0);
    expect(readChannel('app')).toHaveLength(0);
  });

  /**
   * 「关闭日志后即使崩溃也不记录」是明确的语义选择：不保留任何崩溃例外。
   * main.ts 的 uncaughtException / unhandledRejection / render-process-gone /
   * child-process-gone 监听器只能走 logAppEvent，所以这里钉住它们也必须被总开关挡掉；
   * 否则「关了日志还是有东西落盘」会让用户对开关的信任直接崩掉。
   */
  it('总开关关闭后崩溃 / 未捕获异常也不落盘（无任何例外）', () => {
    setLogConfig({ ...DEFAULT_LOG_CONFIG }); // 默认配置：enabled=false
    logAppEvent(
      { phase: 'error', kind: 'uncaughtException', error: new Error('boom'), pid: process.pid },
      'error'
    );
    logAppEvent({ phase: 'error', kind: 'unhandledRejection', error: 'boom' }, 'warn');
    logAppEvent({ phase: 'error', kind: 'render-process-gone', reason: 'crashed' }, 'warn');
    logAppEvent({ phase: 'error', kind: 'child-process-gone', reason: 'crashed' }, 'warn');

    // 不仅 app-*.log 为空：连目录 / 任何文件都不应出现
    expect(readChannel('app')).toHaveLength(0);
    expect(fs.existsSync(getLogsDir())).toBe(false);
  });

  it('summarizeContent：统计正文 / 思考 / 图片 / 工具调用，不落内容本体', () => {
    const summary = summarizeContent([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'considering' },
      { type: 'image' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'ls -la' } }
    ]);
    expect(summary).toEqual({
      textChars: 5,
      thinkingChars: 11,
      images: 1,
      toolCalls: [{ name: 'bash', argChars: JSON.stringify({ command: 'ls -la' }).length }]
    });
    // 不存在的输入不抛错
    expect(summarizeContent(undefined)).toEqual({
      textChars: 0,
      thinkingChars: 0,
      images: 0,
      toolCalls: []
    });
  });

  it('summarizeContent：字符串形式的 arguments 也能计入长度', () => {
    const summary = summarizeContent([{ type: 'toolCall', name: 'read', arguments: 'abcd' }]);
    expect(summary.toolCalls).toEqual([{ name: 'read', argChars: 4 }]);
  });

  it('describeArgs：info 级只给字符数，debug 级附带预览', () => {
    const args = { command: 'rm -rf build' };
    expect(describeArgs(args)).toEqual({ chars: JSON.stringify(args).length });

    setLogConfig({ ...DEFAULT_LOG_CONFIG, enabled: true, level: 'debug' });
    const debugSummary = describeArgs(args);
    expect(debugSummary.chars).toBe(JSON.stringify(args).length);
    expect(debugSummary.preview).toBe(JSON.stringify(args));
  });

  it('describeArgs：无法序列化的入参退化为 String() 且不抛错', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const summary = describeArgs(cyclic);
    expect(summary.chars).toBeGreaterThan(0);
    expect(describeArgs(undefined).chars).toBe(0);
  });
});
