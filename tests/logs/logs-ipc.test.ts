import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const { tmpDir, handlers, uiSettings, shellMock } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-logs-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return {
    tmpDir: dir,
    handlers: new Map<string, (event: unknown, ...args: any[]) => any>(),
    uiSettings: { value: {} as Record<string, unknown> },
    shellMock: { openPath: vi.fn(async () => '') }
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => any) {
      handlers.set(channel, fn);
    }
  },
  shell: shellMock
}));

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

// ui-config 用内存对象替身：验证 logs-ipc 的合并语义 + 真实落盘调用
vi.mock('../../electron/ipc/settings-ipc', () => ({
  readUiSettingsForMain: () => ({ ...uiSettings.value }),
  writeUiSettingsForMain: (next: Record<string, unknown>) => {
    uiSettings.value = { ...next };
  }
}));

import { registerLogsIpc } from '../../electron/ipc/logs-ipc';
import {
  DEFAULT_LOG_CONFIG,
  getLogFilePath,
  getLogsDir,
  listLogFiles,
  logEvent,
  resetLogStateForTest,
  setLogConfig
} from '../../electron/logs/logger';

/** 调用某个已注册的 handler */
function call(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler(null, ...args);
}

describe('ipc/logs', () => {
  beforeEach(() => {
    handlers.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    resetLogStateForTest();
    // 默认不启用（DEFAULT_LOG_CONFIG.enabled === false）：断言写入的用例先手动打开
    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels }
    });
    uiSettings.value = {};
    registerLogsIpc();
  });

  it('注册 7 个通道', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'pi:clearLogs',
      'pi:deleteLogFile',
      'pi:getLogConfig',
      'pi:listLogFiles',
      'pi:openLogFile',
      'pi:readLogTail',
      'pi:setLogConfig'
    ]);
  });

  it('pi:getLogConfig 返回当前配置 + 目录 + 功能清单', async () => {
    const result = await call('pi:getLogConfig');
    expect(result.dir).toBe(getLogsDir());
    expect(result.config).toEqual({
      enabled: true,
      level: 'info',
      channels: { classifier: true, model: true, tools: true, permission: true, app: true },
      retentionDays: 14
    });
    expect(result.channels).toEqual(['classifier', 'model', 'tools', 'permission', 'app']);
  });

  it('未落盘过配置时默认不启用（磁盘缺 logConfig → enabled=false）', async () => {
    // uiSettings 为空 = 用户从没打开过设置页 → 归一化后必须是「不记录」
    const result = await call('pi:setLogConfig', { level: 'debug' });
    expect(result.ok).toBe(true);
    expect(result.config.enabled).toBe(false);
    expect(result.config.level).toBe('debug');
    // 未启用 → 真的不落盘
    logEvent('model', { phase: 'a' }, 'error');
    expect(fs.existsSync(getLogFilePath('model'))).toBe(false);
  });

  it('pi:setLogConfig 归一化后写入 ui-config 并立即生效', async () => {
    const result = await call('pi:setLogConfig', {
      enabled: true,
      level: 'debug',
      retentionDays: 9999
    });
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({ level: 'debug', retentionDays: 365 });
    // 落盘（内存替身）+ 内存配置都更新
    expect(uiSettings.value.logConfig).toMatchObject({ level: 'debug', retentionDays: 365 });

    logEvent('model', { phase: 'a' }, 'debug');
    expect(fs.existsSync(getLogFilePath('model'))).toBe(true);
  });

  it('pi:setLogConfig 与磁盘现有配置合并（只改一个字段不影响其它字段）', async () => {
    uiSettings.value = {
      permissionPolicy: 'classifier-auto',
      logConfig: { enabled: true, level: 'warn', channels: { model: false }, retentionDays: 3 }
    };

    const result = await call('pi:setLogConfig', { level: 'error' });
    expect(result.ok).toBe(true);
    // 合并后：level 变 error，其它字段保持磁盘值
    expect(result.config).toMatchObject({ level: 'error', retentionDays: 3 });
    expect(result.config.channels.model).toBe(false);
    // 无关字段不被清掉
    expect(uiSettings.value.permissionPolicy).toBe('classifier-auto');
  });

  it('pi:setLogConfig 连续关闭多个功能开关时互不影响（channels 深合并）', async () => {
    // 设置页每个开关只发 `channels: { 该功能: false }`，不能把其它功能的磁盘值顶掉
    const first = await call('pi:setLogConfig', { channels: { classifier: false } });
    expect(first.ok).toBe(true);
    expect(first.config.channels.classifier).toBe(false);

    const second = await call('pi:setLogConfig', { channels: { model: false } });
    expect(second.ok).toBe(true);
    // 关键回归：关第二个功能时，第一个必须仍然是 false（而不是回退默认 true）
    expect(second.config.channels).toEqual({
      classifier: false,
      model: false,
      tools: true,
      permission: true,
      app: true
    });
    expect(uiSettings.value.logConfig).toMatchObject({
      channels: { classifier: false, model: false }
    });

    // 再打开其中一个，另一个也不受影响
    const third = await call('pi:setLogConfig', { channels: { classifier: true } });
    expect(third.config.channels).toMatchObject({ classifier: true, model: false });
  });

  it('pi:setLogConfig 拒绝非对象入参', async () => {
    expect(await call('pi:setLogConfig', 'nope')).toEqual({ ok: false, error: 'invalid patch' });
    expect(await call('pi:setLogConfig', null)).toEqual({ ok: false, error: 'invalid patch' });
  });

  it('pi:listLogFiles 列出日志文件', async () => {
    logEvent('model', { phase: 'a' });
    logEvent('tools', { phase: 'b' });
    const result = await call('pi:listLogFiles');
    expect(result.dir).toBe(getLogsDir());
    expect(result.files.map((f: any) => f.channel).sort()).toEqual(['model', 'tools']);
  });

  it('pi:readLogTail 返回最后 n 行；非法入参被拒绝', async () => {
    for (let i = 1; i <= 5; i += 1) logEvent('model', { phase: 'x', i });

    const tail = await call('pi:readLogTail', 'model', 2);
    expect(tail.ok).toBe(true);
    expect(tail.lines).toHaveLength(2);
    expect(JSON.parse(tail.lines[1]).i).toBe(5);

    expect(await call('pi:readLogTail', '', 2)).toEqual({ ok: false, error: 'invalid channel' });
    expect(await call('pi:readLogTail', 42, 2)).toEqual({ ok: false, error: 'invalid channel' });
  });

  it('pi:readLogTail 行数被夹在 1~500 之间', async () => {
    for (let i = 0; i < 520; i += 1) logEvent('model', { i });
    const capped = await call('pi:readLogTail', 'model', 10_000);
    expect(capped.lines).toHaveLength(500);
    const floored = await call('pi:readLogTail', 'model', 0);
    expect(floored.lines).toHaveLength(1);
  });

  it('pi:openLogFile 用系统默认程序打开目录内的日志文件', async () => {
    logEvent('model', { phase: 'a' });
    const name = listLogFiles()[0].name;
    shellMock.openPath.mockClear();

    expect(await call('pi:openLogFile', name)).toEqual({ ok: true });
    expect(shellMock.openPath).toHaveBeenCalledWith(getLogFilePath('model'));
  });

  it('pi:openLogFile 拒绝越界名字与不存在的文件', async () => {
    shellMock.openPath.mockClear();
    expect(await call('pi:openLogFile', '../ui-config.json')).toEqual({
      ok: false,
      error: 'log file not found'
    });
    expect(await call('pi:openLogFile', 'model-2000-01-01.log')).toEqual({
      ok: false,
      error: 'log file not found'
    });
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it('pi:deleteLogFile 只删指定文件', async () => {
    logEvent('model', { phase: 'a' });
    logEvent('tools', { phase: 'b' });
    const modelName = listLogFiles().find((f) => f.channel === 'model')?.name ?? '';
    const toolsName = listLogFiles().find((f) => f.channel === 'tools')?.name ?? '';

    expect(await call('pi:deleteLogFile', modelName)).toEqual({ ok: true });
    expect((await call('pi:listLogFiles')).files.map((f: any) => f.name)).toEqual([toolsName]);
    expect(await call('pi:deleteLogFile', '../ui-config.json')).toEqual({
      ok: false,
      error: 'log file not found'
    });
  });

  it('pi:clearLogs 删除全部日志文件并返回数量', async () => {
    logEvent('model', { phase: 'a' });
    logEvent('tools', { phase: 'b' });
    const result = await call('pi:clearLogs');
    expect(result).toEqual({ ok: true, removed: 2 });
    expect((await call('pi:listLogFiles')).files).toHaveLength(0);
  });
});
