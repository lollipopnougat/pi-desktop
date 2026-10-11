/**
 * 权限沙箱 IPC：
 * - pi:getPermissionPolicy / pi:setPermissionPolicy：查询/设置策略（立即生效）
 * - pi:getAutoSafeConfig / pi:setAutoSafeConfig：查询/设置 auto-safe 自定义白名单
 * - pi:getClassifierApprovalConfig / pi:setClassifierApprovalConfig：查询/设置决策模型自动审批配置
 * - pi:permissionResponse：渲染进程回传审批决策（allow / deny / allow-session）
 * - pi:getSessionAllowedTools / pi:clearSessionAllowedTools：查询/清空「本次会话允许」工具列表
 * - pi:permissionRequest（事件）：主进程 → 渲染进程推送审批请求
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';
import { isPermissionPolicy } from '../permission/policy';

export function registerPermissionIpc(ctx: PiBridge) {
  ipcMain.handle('pi:getPermissionPolicy', async () => {
    return ctx.permissionController.getPolicy();
  });

  ipcMain.handle('pi:setPermissionPolicy', async (_e, policy: unknown) => {
    if (!isPermissionPolicy(policy)) {
      return { ok: false, error: 'invalid policy' };
    }
    ctx.permissionController.setPolicy(policy);
    return { ok: true, policy };
  });

  ipcMain.handle('pi:getAutoSafeConfig', async () => {
    return ctx.permissionController.getAutoSafeConfig();
  });

  ipcMain.handle('pi:setAutoSafeConfig', async (_e, config: unknown) => {
    try {
      const saved = ctx.permissionController.setAutoSafeConfig(config);
      // 同步持久化到 ui-config.json（策略字段之外的白名单字段）
      const { readUiSettingsForMain, writeUiSettingsForMain } = await import('./settings-ipc');
      const current = readUiSettingsForMain();
      writeUiSettingsForMain({ ...current, permissionAutoSafeConfig: saved });
      return { ok: true, config: saved };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('pi:getClassifierApprovalConfig', async () => {
    return ctx.permissionController.getClassifierConfig();
  });

  ipcMain.handle('pi:setClassifierApprovalConfig', async (_e, config: unknown) => {
    try {
      const saved = ctx.permissionController.setClassifierConfig(config);
      // 同步持久化到 ui-config.json（与 permissionAutoSafeConfig 同一条路径）
      const { readUiSettingsForMain, writeUiSettingsForMain } = await import('./settings-ipc');
      const current = readUiSettingsForMain();
      writeUiSettingsForMain({ ...current, permissionClassifierConfig: saved });
      return { ok: true, config: saved };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    'pi:permissionResponse',
    async (_e, payload: { id?: string; decision?: string } | null) => {
      const id = payload?.id;
      const decision = payload?.decision;
      if (
        typeof id !== 'string' ||
        (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-session')
      ) {
        return { ok: false, error: 'invalid payload' };
      }
      const ok = ctx.permissionController.resolvePermission(id, decision);
      return { ok };
    }
  );

  // 本会话内已选择「本次会话允许」的工具名列表（切换会话后自动清空）
  ipcMain.handle('pi:getSessionAllowedTools', async () => {
    return ctx.permissionController.getSessionAllowedTools();
  });

  // 手动撤销「本次会话允许」状态（恢复逐次审批）
  ipcMain.handle('pi:clearSessionAllowedTools', async () => {
    ctx.permissionController.clearSessionAllowedTools();
    return { ok: true };
  });
}
