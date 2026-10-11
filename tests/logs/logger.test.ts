import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import {
  getLogsDir,
  getLogFilePath,
  logEvent,
  readLogTail,
  sanitizeForLog,
  DEFAULT_LOG_CONFIG,
  setLogConfig,
  resetLogStateForTest,
  LOGS_DIR
} from '../../electron/logs/logger';
import { logClassifierCall, CLASSIFIER_LOG_CHANNEL } from '../../electron/logs/classifier-log';

/** 读取当天某个 channel 的全部日志行（parse 成对象） */
function readChannel(channel: string): Record<string, any>[] {
  const file = getLogFilePath(channel);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * 清空日志目录。
 * 注意：logger 模块把「目录已确保存在」缓存在模块作用域，所以每个用例里必须重新 mkdir，
 * 否则 appendFileSync 会因目录缺失而静默失败（真实运行时目录一直在，不受影响）。
 */
function resetLogsDir(): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

describe('logs/logger', () => {
  beforeEach(() => {
    resetLogsDir();
    // 日志默认不启用（DEFAULT_LOG_CONFIG.enabled === false）：要看落盘内容的用例先手动打开
    resetLogStateForTest();
    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels }
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('日志目录固定在 ~/.pi-desktop/logs', () => {
    expect(LOGS_DIR).toBe(path.join(tmpDir, 'logs'));
    expect(getLogsDir()).toBe(path.join(tmpDir, 'logs'));
  });

  it('文件名为 <channel>-YYYY-MM-DD.log（本地日期，两位补零）', () => {
    const file = getLogFilePath('classifier', new Date(2026, 0, 9, 12, 0, 0));
    expect(path.basename(file)).toBe('classifier-2026-01-09.log');
    expect(path.dirname(file)).toBe(path.join(tmpDir, 'logs'));
  });

  it('logEvent 追加一行 JSON：含 ts / channel 与业务字段', () => {
    logEvent('demo', { phase: 'request', n: 1 });
    logEvent('demo', { phase: 'response', n: 2 });

    const lines = readChannel('demo');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ channel: 'demo', phase: 'request', n: 1 });
    expect(lines[1]).toMatchObject({ channel: 'demo', phase: 'response', n: 2 });
    expect(typeof lines[0].ts).toBe('string');
    expect(Number.isNaN(Date.parse(lines[0].ts))).toBe(false);
  });

  it('敏感键名脱敏、长字符串截断（写入磁盘的内容同样脱敏）', () => {
    logEvent('demo', {
      apiKey: 'sk-should-not-appear',
      Authorization: 'Bearer abc',
      nested: { password: 'p', token: 't', safe: 'ok' },
      long: 'x'.repeat(9000)
    });

    const [line] = readChannel('demo');
    expect(line.apiKey).toBe('***');
    expect(line.Authorization).toBe('***');
    expect(line.nested).toEqual({ password: '***', token: '***', safe: 'ok' });
    expect(String(line.long).length).toBeLessThan(9000);
    expect(String(line.long)).toContain('已截断');
    expect(JSON.stringify(line)).not.toContain('sk-should-not-appear');
  });

  it('logEvent 永不抛错：循环引用 / Symbol / 函数 / 含 Error 的负载都能写入', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() =>
      logEvent('demo', {
        cyclic,
        fn: () => 'x',
        big: 10n,
        err: new Error('boom'),
        signal: new AbortController().signal
      })
    ).not.toThrow();

    const [line] = readChannel('demo');
    expect(line.cyclic.name).toBe('loop');
    // 循环引用靠深度上限斩断：序列化后的文本里出现「深度超限」而不是无限展开
    expect(JSON.stringify(line)).toContain('深度超限');
    expect(line.err).toMatchObject({ name: 'Error', message: 'boom' });
    expect(line.signal.aborted).toBe(false);
    expect(String(line.big)).toBe('10n');
  });

  it('目录不存在时自动创建（重新 import 以重置模块内的目录缓存）', async () => {
    fs.rmSync(getLogsDir(), { recursive: true, force: true });
    vi.resetModules();
    const fresh = await import('../../electron/logs/logger');
    // 新模块实例重新回到「默认不启用」，这里先显式打开
    fresh.setLogConfig({ ...fresh.DEFAULT_LOG_CONFIG, enabled: true });

    fresh.logEvent('fresh', { a: 1 });

    expect(fs.existsSync(getLogsDir())).toBe(true);
    const written = fs.readFileSync(fresh.getLogFilePath('fresh'), 'utf-8').trim();
    expect(JSON.parse(written)).toMatchObject({ channel: 'fresh', a: 1 });
  });

  it('超过单文件上限时轮转成 .1（旧内容搬家、新内容写进原文件）', () => {
    const file = getLogFilePath('demo');
    fs.mkdirSync(getLogsDir(), { recursive: true });
    fs.writeFileSync(file, 'y'.repeat(8 * 1024 * 1024 + 1), 'utf-8');

    logEvent('demo', { phase: 'after-rotate' });

    const rotated = `${file}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.statSync(rotated).size).toBeGreaterThan(8 * 1024 * 1024);
    const lines = readChannel('demo');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ channel: 'demo', phase: 'after-rotate' });
  });

  it('token 计数类字段不被脱敏（usage.totalTokens 等，日志核心信息）', () => {
    logEvent('demo', {
      usage: {
        input: 100,
        output: 20,
        totalTokens: 120,
        inputTokens: 100,
        output_tokens: 20,
        cacheReadTokens: 5
      },
      // 名为 token 的字段仍按凭据处理
      token: 'secret-token'
    });

    const [line] = readChannel('demo');
    expect(line.usage).toEqual({
      input: 100,
      output: 20,
      totalTokens: 120,
      inputTokens: 100,
      output_tokens: 20,
      cacheReadTokens: 5
    });
    expect(line.token).toBe('***');
  });

  it('readLogTail 返回最后 n 行；文件不存在返回空数组', () => {
    logEvent('demo', { n: 1 });
    logEvent('demo', { n: 2 });
    logEvent('demo', { n: 3 });

    expect(readLogTail('demo', 2).map((l) => JSON.parse(l).n)).toEqual([2, 3]);
    expect(readLogTail('demo', 10)).toHaveLength(3);
    expect(readLogTail('missing')).toEqual([]);
  });

  it('sanitizeForLog：原始值原样、键名不敏感时保留', () => {
    expect(sanitizeForLog('plain')).toBe('plain');
    expect(sanitizeForLog(3)).toBe(3);
    expect(sanitizeForLog(true)).toBe(true);
    expect(sanitizeForLog(null)).toBeNull();
    expect(sanitizeForLog(undefined)).toBeUndefined();
    expect(sanitizeForLog({ username: 'bob', command: 'ls -la' })).toEqual({
      username: 'bob',
      command: 'ls -la'
    });
  });
});

describe('logs/classifier-log', () => {
  beforeEach(() => {
    resetLogsDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写入 classifier channel 并带 source 标记（区分闸门自动调用与试跑）', () => {
    logClassifierCall('approval-gate', { phase: 'request', providerId: 'local-kev' });
    logClassifierCall('playground', { phase: 'response', elapsedMs: 12 });

    expect(CLASSIFIER_LOG_CHANNEL).toBe('classifier');
    const lines = readChannel(CLASSIFIER_LOG_CHANNEL);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      channel: 'classifier',
      source: 'approval-gate',
      phase: 'request',
      providerId: 'local-kev'
    });
    expect(lines[1]).toMatchObject({ source: 'playground', phase: 'response', elapsedMs: 12 });
  });

  it('决策模型的 state / questions 能完整落盘（默认不截断小负载）', () => {
    logClassifierCall('approval-gate', {
      phase: 'request',
      state: { tool: 'bash', command: 'ls -la' },
      questions: { danger: { type: 'choice', instructions: 'judge' } }
    });

    const [line] = readChannel(CLASSIFIER_LOG_CHANNEL);
    expect(line.state).toEqual({ tool: 'bash', command: 'ls -la' });
    expect(line.questions.danger.type).toBe('choice');
  });
});
