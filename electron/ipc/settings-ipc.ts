/**
 * UI 设置持久化：~/.pi-desktop/ui-config.json
 *
 * 渲染进程的界面偏好（字号/面板宽度/终端字体/模式等）原先存在 Electron
 * localStorage（随用户数据目录走，不易备份/迁移），现在统一落到独立的
 * ui-config.json，与 SDK 的 settings.json（上下文压缩等）区分开。
 *
 * 约定：
 * - 文件名固定为 ui-config.json，与 SDK 的 settings.json（compaction 等）区分
 * - 读写都是整文件合并：setUiSettings 接收部分字段，与现有内容 merge 后原子写回
 * - 文件损坏/不存在时按空配置处理，不抛错
 */
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { getAgentDir } from '../provider-config';
import type { PiBridge } from '../pi-bridge';

type SettingsIpcContext = PiBridge;

/** UI 设置文件路径（懒计算，getAgentDir 在模块加载后才可用） */
const settingPath = () => path.join(getAgentDir(), 'ui-config.json');

export interface UiSettings {
  [key: string]: unknown;
}

function readUiSettings(): UiSettings {
  try {
    const raw = fs.readFileSync(settingPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as UiSettings) : {};
  } catch {
    return {};
  }
}

/** 主进程内部读取（如权限控制器启动恢复策略），非 IPC 暴露 */
export function readUiSettingsForMain(): UiSettings {
  return readUiSettings();
}

/** 主进程内部写入（整文件覆盖，与 IPC setUiSettings 同语义），非 IPC 暴露 */
export function writeUiSettingsForMain(settings: UiSettings): void {
  writeUiSettings(settings);
}

function writeUiSettings(settings: UiSettings): void {
  const fullPath = settingPath();
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  // 原子写：先写临时文件再 rename，避免写一半崩溃导致文件损坏
  const tmp = `${fullPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
  fs.renameSync(tmp, fullPath);
}

export function registerSettingsIpc(_ctx: SettingsIpcContext) {
  ipcMain.handle('pi:getUiSettings', async () => {
    return readUiSettings();
  });

  ipcMain.handle('pi:setUiSettings', async (_e, patch: UiSettings) => {
    try {
      if (!patch || typeof patch !== 'object') {
        return { ok: false, error: 'invalid patch' };
      }
      const current = readUiSettings();
      writeUiSettings({ ...current, ...patch });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // === read_img 图片识别模型配置 ===
  // 返回可用视觉模型列表（已鉴权且 input 含 image）供设置页下拉选择
  ipcMain.handle('pi:getVisionModels', async () => {
    const ctx = _ctx;
    if (!ctx?.modelRuntime) return [];
    try {
      const models = await ctx.modelRuntime.getAvailable();
      return (Array.isArray(models) ? models : [])
        .filter((m: any) => Array.isArray(m?.input) && m.input.includes('image'))
        .map((m: any) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id }));
    } catch {
      return [];
    }
  });

  // 设置/清除 read_img 视觉模型（null = 不配置，任何情况不提供该工具）
  ipcMain.handle(
    'pi:setReadImgModel',
    async (_e, provider: string | null, modelId: string | null) => {
      try {
        const ctx = _ctx;
        // 先校验：配置的模型必须真实存在且支持视觉（清除时跳过校验）
        if (provider && modelId) {
          const model = ctx?.modelRuntime?.getModel?.(provider, modelId);
          if (!model || !Array.isArray(model.input) || !model.input.includes('image')) {
            return { ok: false, error: 'model does not support vision' };
          }
        }
        ctx?.setReadImgModel?.(provider, modelId);
        // 持久化到 ui-config.json
        const current = readUiSettings();
        const config = provider && modelId ? { provider, modelId } : null;
        writeUiSettings({ ...current, readImgModel: config });
        return { ok: true, config };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );
}
