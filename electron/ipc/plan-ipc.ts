/**
 * Plan IPC handler:enter/exit/get/submit-response(回灌审批决策)。
 *
 * 三处同步之一:本文件注册 handler,preload.ts 暴露,pi.d.ts 声明类型。
 * 渲染进程经 window.pi.plan.* 调用。
 *
 * 注意:plan 提案的"提出 → 渲染进程弹面板 → 回灌"这一段是 ask 工具 round-trip
 * 的翻版;差异在于 propose_plan 工具 execute 内 await 的不是 ask 的 pendingAsk,
 * 而是 controller.startProposal() 返回的 promise。
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';
import type { PlanDecision } from '../plan/controller';

export function registerPlanIpc(piBridge: PiBridge) {
  const controller = piBridge.planController!;

  // 渲染进程审批后回灌(批准/驳回 + 编译好的反馈串)
  ipcMain.handle('pi:plan:submitResponse', async (_e, id: string, decision: PlanDecision) => {
    controller.resolveProposal(id, decision);
    return { ok: true };
  });

  // 拉取当前 plan 状态快照
  ipcMain.handle('pi:plan:get', async () => {
    return controller.getSnapshot();
  });

  // 进入 / 退出 plan(skip=true 进入,false 退出)— 供 ChatInput applyMode 直接调
  // (与 pi:setPlanMode 等效,这里做语义化入口)
  ipcMain.handle('pi:plan:enter', async () => {
    piBridge.setPlanMode(true);
    return { ok: true };
  });

  ipcMain.handle('pi:plan:exit', async () => {
    piBridge.setPlanMode(false);
    return { ok: true };
  });
}
