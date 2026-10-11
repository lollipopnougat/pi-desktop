/**
 * git-ai 集成 IPC handler：配置读写 + 二进制探测。
 *
 * 三处同步之一：本文件注册 handler，preload.ts 暴露，pi.d.ts 声明类型。
 * 渲染进程经 window.pi.gitAi.* 调用（设置页「智能体配置 → git-ai 改动溯源」）。
 * 无 runtime 依赖：配置落 ~/.pi-desktop/git-ai.json，内联扩展每次事件自行读取。
 */
import { ipcMain } from 'electron';
import { readGitAiConfig, writeGitAiConfig, type GitAiConfig } from '../git-ai/config';
import { detectGitAi } from '../git-ai/status';

export function registerGitAiIpc() {
  ipcMain.handle('pi:gitAi:getConfig', () => readGitAiConfig());

  ipcMain.handle('pi:gitAi:setConfig', (_e, patch: Record<string, unknown>) => {
    try {
      return { ok: true, config: writeGitAiConfig(sanitize(patch)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // 探测当前生效的二进制（路径来源 + 版本），设置页打开/保存后调用
  ipcMain.handle('pi:gitAi:detect', () => detectGitAi());
}

/** 白名单过滤：只放行已知字段且类型正确的值（越界值由 normalizeGitAiConfig 兜底） */
function sanitize(patch: Record<string, unknown> | undefined): Partial<GitAiConfig> {
  const out: Partial<GitAiConfig> = {};
  if (typeof patch?.enabled === 'boolean') out.enabled = patch.enabled;
  if (typeof patch?.binPath === 'string') out.binPath = patch.binPath;
  const scope = patch?.scope;
  if (scope === 'all' || scope === 'files' || scope === 'shell') out.scope = scope;
  return out;
}
