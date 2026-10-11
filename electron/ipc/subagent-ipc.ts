/**
 * Subagent IPC handler:快照查询 / 停止 / 引导。
 *
 * 三处同步之一:本文件注册 handler,preload.ts 暴露,pi.d.ts 声明类型。
 * 渲染进程经 window.pi.subagents.* 调用;进度推送走 pi:subagentUpdate 事件。
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';

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
}
