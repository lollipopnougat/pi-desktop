import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-log-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import {
  DEFAULT_LOG_CONFIG,
  LOG_RETENTION_MAX_DAYS,
  clearLogs,
  deleteLogFile,
  getLogConfig,
  getLogFilePath,
  getLogsDir,
  listLogFiles,
  logEvent,
  normalizeLogConfig,
  resetLogStateForTest,
  resolveLogFilePath,
  setLogConfig,
  shouldLog,
  textSummary,
  isDebugLogging,
  getLogFilePath
} from '../../electron/logs/logger';

/** 每个用例前重建目录（logger 把「目录已存在」缓存在模块作用域） */
function resetLogsDir(): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  resetLogStateForTest();
}

function readLines(file: string): Record<string, any>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * 显式启用日志（`DEFAULT_LOG_CONFIG.enabled === false`，运行期默认不写盘）。
 * 只有「默认值/归一化」类用例才会直接用 DEFAULT_LOG_CONFIG。
 */
function ENABLED_LOG_CONFIG(): typeof DEFAULT_LOG_CONFIG {
  return {
    ...DEFAULT_LOG_CONFIG,
    enabled: true,
    channels: { ...DEFAULT_LOG_CONFIG.channels }
  };
}

describe('logs/logger 配置', () => {
  beforeEach(() => {
    resetLogsDir();
    // 运行期默认「不启用」，断言落盘内容的用例必须显式打开
    setLogConfig(ENABLED_LOG_CONFIG());
  });

  afterEach(() => {
    setLogConfig(ENABLED_LOG_CONFIG());
  });

  it('normalizeLogConfig：空值 → 默认配置（默认关闭 + info + 全功能就绪 + 14 天）', () => {
    const config = normalizeLogConfig(undefined);
    // 关键：默认不写任何日志，只有用户手动打开后才记录
    expect(config.enabled).toBe(false);
    expect(DEFAULT_LOG_CONFIG.enabled).toBe(false);
    expect(config.level).toBe('info');
    expect(config.retentionDays).toBe(14);
    expect(config.channels.model).toBe(true);
    expect(config.channels.classifier).toBe(true);
  });

  it('normalizeLogConfig：缺省 / 非布尔 enabled 不回退成启用', () => {
    expect(normalizeLogConfig({}).enabled).toBe(false);
    expect(normalizeLogConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(normalizeLogConfig({ enabled: true }).enabled).toBe(true);
  });

  it('normalizeLogConfig：非法等级回退默认，合法等级保留', () => {
    expect(normalizeLogConfig({ level: 'verbose' }).level).toBe('info');
    expect(normalizeLogConfig({ level: 'debug' }).level).toBe('debug');
    expect(normalizeLogConfig({ level: 'warn' }).level).toBe('warn');
  });

  it('normalizeLogConfig：保留天数取整并夹在 1~365', () => {
    expect(normalizeLogConfig({ retentionDays: 0 }).retentionDays).toBe(1);
    expect(normalizeLogConfig({ retentionDays: -5 }).retentionDays).toBe(1);
    expect(normalizeLogConfig({ retentionDays: 9999 }).retentionDays).toBe(LOG_RETENTION_MAX_DAYS);
    expect(normalizeLogConfig({ retentionDays: '7' }).retentionDays).toBe(7);
    expect(normalizeLogConfig({ retentionDays: 3.6 }).retentionDays).toBe(4);
    expect(normalizeLogConfig({ retentionDays: 'abc' }).retentionDays).toBe(14);
  });

  it('normalizeLogConfig：enabled 非布尔回退默认，channels 只接受布尔值', () => {
    const config = normalizeLogConfig({
      enabled: 'yes',
      channels: { model: false, tools: 'off', unknown: true }
    });
    expect(config.enabled).toBe(false);
    expect(config.channels.model).toBe(false); // 显式关闭生效
    expect(config.channels.tools).toBe(true); // 非布尔忽略，保留默认
    expect(config.channels.unknown).toBe(true); // 未登记功能也能存
  });

  it('默认配置下什么都不写（未启用时连日志目录都不创建）', () => {
    setLogConfig({ ...DEFAULT_LOG_CONFIG });
    logEvent('model', { phase: 'x' });
    logEvent('app', { phase: 'error' }, 'error');
    expect(shouldLog('model', 'error')).toBe(false);
    expect(fs.existsSync(getLogsDir())).toBe(false);
    expect(listLogFiles()).toHaveLength(0);
  });

  it('setLogConfig / getLogConfig 独立副本（改返回值不影响内存配置）', () => {
    const config = getLogConfig();
    config.level = 'error';
    config.channels.model = false;
    expect(getLogConfig().level).toBe('info');
    expect(getLogConfig().channels.model).toBe(true);
  });

  it('shouldLog：总开关决定一切', () => {
    setLogConfig({ ...DEFAULT_LOG_CONFIG, enabled: false });
    expect(shouldLog('model', 'error')).toBe(false);
  });

  it('shouldLog：功能开关独立生效，未登记功能默认开启', () => {
    setLogConfig({ ...ENABLED_LOG_CONFIG(), channels: { model: false } });
    expect(shouldLog('model', 'info')).toBe(false);
    expect(shouldLog('tools', 'info')).toBe(true);
    expect(shouldLog('custom-channel', 'info')).toBe(true);
  });

  it('shouldLog：等级门槛丢弃低于配置的记录', () => {
    setLogConfig({ ...ENABLED_LOG_CONFIG(), level: 'warn' });
    expect(shouldLog('model', 'debug')).toBe(false);
    expect(shouldLog('model', 'info')).toBe(false);
    expect(shouldLog('model', 'warn')).toBe(true);
    expect(shouldLog('model', 'error')).toBe(true);
  });

  it('logEvent 受配置过滤：关掉的功能不落盘，等级不够的行也不落盘', () => {
    setLogConfig({ ...ENABLED_LOG_CONFIG(), channels: { model: false }, level: 'warn' });
    logEvent('model', { phase: 'x' }, 'error');
    logEvent('tools', { phase: 'y' }, 'info');
    expect(readLines(getLogFilePath('model'))).toHaveLength(0);
    expect(readLines(getLogFilePath('tools'))).toHaveLength(0);

    logEvent('tools', { phase: 'y' }, 'warn');
    const lines = readLines(getLogFilePath('tools'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ channel: 'tools', level: 'warn', phase: 'y' });
  });

  it('textSummary：info 级只给字符数，debug 级附带预览（并截断到 500 字符）', () => {
    const long = 'x'.repeat(600);
    expect(textSummary(long)).toEqual({ chars: 600 });
    expect(isDebugLogging()).toBe(false);

    setLogConfig({ ...ENABLED_LOG_CONFIG(), level: 'debug' });
    expect(isDebugLogging()).toBe(true);
    const summary = textSummary(long);
    expect(summary.chars).toBe(600);
    expect(summary.preview).toHaveLength(500);
    expect(textSummary('')).toEqual({ chars: 0 });
  });
});

describe('logs/logger 文件管理', () => {
  beforeEach(() => {
    resetLogsDir();
    setLogConfig(ENABLED_LOG_CONFIG());
  });

  it('listLogFiles：列出 .log 与轮转文件，解析功能名与轮转标记，按时间倒序', () => {
    logEvent('model', { phase: 'a' });
    const rotated = `${getLogFilePath('tools')}.1`;
    fs.writeFileSync(rotated, '{"ts":"old"}\n', 'utf-8');
    // 让轮转文件的 mtime 明确早于 model 的日志
    const old = Date.now() - 60_000;
    fs.utimesSync(rotated, new Date(old), new Date(old));

    const files = listLogFiles();
    const names = files.map((f) => f.name);
    expect(names).toContain(path.basename(getLogFilePath('model')));
    expect(names).toContain(path.basename(rotated));

    const modelFile = files.find((f) => f.channel === 'model');
    expect(modelFile?.rotated).toBe(false);
    expect(modelFile?.sizeBytes).toBeGreaterThan(0);

    const toolsFile = files.find((f) => f.channel === 'tools');
    expect(toolsFile?.rotated).toBe(true);

    expect(files[0].channel).toBe('model'); // mtime 更新的排在前面
  });

  it('resolveLogFilePath：只接受日志目录内的 .log / .log.N 名字（防目录穿越）', () => {
    expect(resolveLogFilePath('app-2026-10-12.log')).toBe(
      path.join(getLogsDir(), 'app-2026-10-12.log')
    );
    expect(resolveLogFilePath('tools-2026-10-12.log.1')).toBe(
      path.join(getLogsDir(), 'tools-2026-10-12.log.1')
    );
    expect(resolveLogFilePath('../ui-config.json')).toBeNull();
    expect(resolveLogFilePath('/etc/passwd')).toBeNull();
    expect(resolveLogFilePath('sub/app-2026-10-12.log')).toBeNull();
    expect(resolveLogFilePath('app-2026-10-12.txt')).toBeNull();
    expect(resolveLogFilePath('')).toBeNull();
  });

  it('deleteLogFile：只删指定文件，越界名字直接拒绝', () => {
    logEvent('model', { phase: 'a' });
    logEvent('tools', { phase: 'b' });
    const modelName = path.basename(getLogFilePath('model'));
    const toolsName = path.basename(getLogFilePath('tools'));

    expect(deleteLogFile('../ui-config.json')).toBe(false);
    expect(deleteLogFile(modelName)).toBe(true);
    expect(listLogFiles().map((f) => f.name)).toEqual([toolsName]);
    // 已删掉的文件再删一次：fs.rmSync(force) 不报错，返回 true（幂等）
    expect(deleteLogFile(modelName)).toBe(true);
  });

  it('clearLogs：删除所有日志文件（含轮转）并返回数量', () => {
    logEvent('model', { phase: 'a' });
    logEvent('tools', { phase: 'b' });
    fs.writeFileSync(`${getLogFilePath('tools')}.1`, '{}\n', 'utf-8');
    // 非日志文件不受影响
    fs.mkdirSync(getLogsDir(), { recursive: true });
    const keep = path.join(getLogsDir(), 'notes.txt');
    fs.writeFileSync(keep, 'keep', 'utf-8');

    expect(clearLogs()).toBe(3);
    expect(listLogFiles()).toHaveLength(0);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('写入时清理超过保留天数的旧文件', () => {
    fs.mkdirSync(getLogsDir(), { recursive: true });
    const staleFile = path.join(getLogsDir(), 'classifier-2020-01-01.log');
    fs.writeFileSync(staleFile, '{}\n', 'utf-8');
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, new Date(old), new Date(old));

    setLogConfig({ ...ENABLED_LOG_CONFIG(), retentionDays: 7 });
    resetLogStateForTest();
    logEvent('model', { phase: 'a' });

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(getLogFilePath('model'))).toBe(true);
  });

  it('保留天数内的旧文件不会被清理', () => {
    fs.mkdirSync(getLogsDir(), { recursive: true });
    const recentFile = path.join(getLogsDir(), 'classifier-2020-01-02.log');
    fs.writeFileSync(recentFile, '{}\n', 'utf-8');
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(recentFile, new Date(twoDaysAgo), new Date(twoDaysAgo));

    setLogConfig({ ...ENABLED_LOG_CONFIG(), retentionDays: 14 });
    logEvent('model', { phase: 'a' });

    expect(fs.existsSync(recentFile)).toBe(true);
  });
});
