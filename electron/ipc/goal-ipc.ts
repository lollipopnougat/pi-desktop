/**
 * Goal IPC handler:create/pause/resume/clear/edit/get。
 *
 * 三处同步之一:本文件注册 handler,preload.ts 暴露,pi.d.ts 声明类型。
 * 渲染进程经 window.pi.goal.* 调用。
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';

export function registerGoalIpc(piBridge: PiBridge) {
  const controller = piBridge.goalController!;

  ipcMain.handle('pi:goal:create', async (_e, text: string, tokenBudget?: number) => {
    const ok = controller.createGoal(text, tokenBudget);
    let queued = false;
    if (ok) {
      // 新交互：用户发送的文本就是目标。创建后直接用该文本作为首条 prompt
      // 发送给 agent，启动自治循环。before_agent_start 时 goal 已存在并已持久化。
      try {
        const slot = piBridge.sessionFor();
        // 与普通回合同一道并发闸门：超过「同时 3 个会话」时排队等空位
        queued = (await piBridge.submitPrompt(text, undefined, slot.key)).queued;
      } catch {
        // prompt 失败(如模型未配置)时忽略,目标仍已创建
      }
    }
    return { ok, queued };
  });

  ipcMain.handle('pi:goal:pause', async () => {
    controller.pauseGoal();
    return { ok: true };
  });

  ipcMain.handle('pi:goal:resume', async () => {
    controller.resumeGoal();
    return { ok: true };
  });

  ipcMain.handle('pi:goal:clear', async () => {
    controller.clearGoal();
    return { ok: true };
  });

  ipcMain.handle('pi:goal:edit', async (_e, text?: string, tokenBudget?: number | null) => {
    const ok = controller.editGoal(text, tokenBudget);
    return { ok };
  });

  ipcMain.handle('pi:goal:get', async () => {
    return controller.getSnapshot();
  });
}
