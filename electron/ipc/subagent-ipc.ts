/**
 * Subagent IPC handler:快照查询 / 停止 / 引导 / 开关配置。
 *
 * 三处同步之一:本文件注册 handler,preload.ts 暴露,pi.d.ts 声明类型。
 * 渲染进程经 window.pi.subagents.* 调用;进度推送走 pi:subagentUpdate 事件。
 *
 * 配置落 `~/.pi-desktop/subagents.json`(见 electron/subagents/config.ts)。
 * 写入后必须调 `piBridge.applySubagentConfig()`,把 task 工具的可见性
 * 在所有会话槽上同步一遍(含后台槽),否则改完要等下次建会话才生效。
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';
import {
  getSubagentConfigPath,
  readSubagentConfig,
  writeSubagentConfig,
  type SubagentConfig
} from '../subagents/config';

export function registerSubagentIpc(piBridge: PiBridge) {
  const controller = piBridge.subagentController!;

  ipcMain.handle('pi:subagent:getSnapshot', async () => {
    return controller.getSnapshot();
  });

  ipcMain.handle('pi:subagent:stop', async (_e, runId: string) => {
    return { ok: await controller.stopRun(runId) };
  });

  ipcMain.handle('pi:subagent:steer', async (_e, runId: string, text: string) => {
    return { ok: await controller.steerRun(runId, text) };
  });

  ipcMain.handle('pi:subagent:reload', async () => {
    controller.reloadDefinitions();
    return controller.getSnapshot();
  });

  // 子 agent 会话文件回放(终态/重启后弹窗「对话」Tab 的数据源)
  ipcMain.handle('pi:subagent:getSession', async (_e, runId: string) => {
    return controller.readSessionConversation(runId);
  });

  // 开关配置(设置页):enabled=false → 不向 agent 注入 task 工具
  ipcMain.handle('pi:subagent:getConfig', () => ({
    config: readSubagentConfig(),
    configPath: getSubagentConfigPath()
  }));

  ipcMain.handle('pi:subagent:setConfig', (_e, patch: Partial<SubagentConfig>) => {
    try {
      const config = writeSubagentConfig(patch ?? {});
      // 工具可见性跟着开关变:立即同步所有槽(不重建会话)
      piBridge.applySubagentConfig();
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
