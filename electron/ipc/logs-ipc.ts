/**
 * 日志设置与日志文件管理的 IPC。
 *
 * 配置存在 `~/.pi-desktop/ui-config.json` 的 `logConfig`（与权限策略、read_img 同处），
 * 保存后立即刷新主进程内存副本（setLogConfig），无需重启。
 *
 * 通道：
 * - `pi:getLogConfig`      读配置 + 日志目录 + 当前文件清单
 * - `pi:setLogConfig`      保存配置（先归一化，成功才落盘）
 * - `pi:listLogFiles`      列出日志文件（名称/大小/时间）
 * - `pi:readLogTail`       读某功能当天最后 n 行（设置页预览）
 * - `pi:openLogFile`       用系统默认程序打开单个日志文件
 * - `pi:deleteLogFile`     删除单个日志文件
 * - `pi:clearLogs`         删除所有日志文件
 */
import { ipcMain, shell } from 'electron';
import fs from 'fs';
import { readUiSettingsForMain, writeUiSettingsForMain } from './settings-ipc';
import {
  LOG_CHANNELS,
  clearLogs,
  deleteLogFile,
  getLogConfig,
  getLogsDir,
  listLogFiles,
  normalizeLogConfig,
  readLogTail,
  resolveLogFilePath,
  setLogConfig,
  type LogConfig
} from '../logs/logger';

/** 预览最多返回多少行 */
const MAX_PREVIEW_LINES = 500;

export function registerLogsIpc() {
  ipcMain.handle('pi:getLogConfig', async () => {
    return { config: getLogConfig(), dir: getLogsDir(), channels: [...LOG_CHANNELS] };
  });

  ipcMain.handle('pi:setLogConfig', async (_e, patch: unknown) => {
    try {
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid patch' };
      const current = readUiSettingsForMain();
      const base = (
        typeof current.logConfig === 'object' && current.logConfig ? current.logConfig : {}
      ) as Record<string, unknown>;
      const incoming = patch as Record<string, unknown>;
      // channels 必须**深合并**：设置页每个开关只传 `channels: { 某个功能: 布尔值 }`，
      // 浅合并会把整个 channels 对象替换成单键对象，归一化时其余功能回退默认值（true），
      // 表现为「关掉一个功能，之前关掉的功能又自己打开了」。
      const channels =
        incoming.channels && typeof incoming.channels === 'object'
          ? {
              ...(typeof base.channels === 'object' && base.channels ? base.channels : {}),
              ...(incoming.channels as Record<string, unknown>)
            }
          : base.channels;
      // 只接受已知字段：渲染进程传来的对象先与现有配置合并再归一化
      const merged = normalizeLogConfig({ ...base, ...incoming, channels });
      setLogConfig(merged);
      writeUiSettingsForMain({ ...current, logConfig: merged });
      return { ok: true, config: merged as LogConfig };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('pi:listLogFiles', async () => {
    return { dir: getLogsDir(), files: listLogFiles() };
  });

  ipcMain.handle('pi:readLogTail', async (_e, channel: unknown, maxLines: unknown) => {
    try {
      if (typeof channel !== 'string' || !channel) return { ok: false, error: 'invalid channel' };
      const count = Number(maxLines);
      const lines = readLogTail(
        channel,
        Number.isFinite(count) ? Math.min(MAX_PREVIEW_LINES, Math.max(1, Math.round(count))) : 200
      );
      return { ok: true, lines };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // 用系统默认程序打开单个日志文件（设置页「打开」按钮）
  ipcMain.handle('pi:openLogFile', async (_e, name: unknown) => {
    try {
      const full = typeof name === 'string' ? resolveLogFilePath(name) : null;
      if (!full || !fs.existsSync(full)) return { ok: false, error: 'log file not found' };
      // shell.openPath 返回空串表示成功，否则是错误描述
      const err = await shell.openPath(full);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('pi:deleteLogFile', async (_e, name: unknown) => {
    try {
      if (typeof name !== 'string' || !deleteLogFile(name)) {
        return { ok: false, error: 'log file not found' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('pi:clearLogs', async () => {
    try {
      return { ok: true, removed: clearLogs() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
