import { ipcMain } from 'electron';
import type { BackgroundTaskController } from '../background-tasks/controller';

export interface BackgroundTaskIpcContext {
  readonly backgroundTaskController: BackgroundTaskController;
}

export function registerBackgroundTaskIpc(ctx: BackgroundTaskIpcContext): void {
  ipcMain.handle('pi:backgroundTasks:getSnapshot', async () => {
    return ctx.backgroundTaskController.getSnapshot();
  });

  ipcMain.handle('pi:backgroundTasks:kill', async (_event, taskId: string) => {
    try {
      const task = await ctx.backgroundTaskController.stop(taskId);
      return { ok: true, task };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('pi:backgroundTasks:remove', async (_event, taskIds: unknown) => {
    const ids = Array.isArray(taskIds)
      ? taskIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (ids.length === 0) {
      return { ok: false, removed: [], failed: [], error: '未指定要清理的后台任务' };
    }
    try {
      const result = await ctx.backgroundTaskController.remove(ids);
      const error =
        result.failed.length > 0
          ? result.failed.map((item) => `${item.id}: ${item.error}`).join('; ')
          : undefined;
      return { ok: result.failed.length === 0, ...result, error };
    } catch (error) {
      return {
        ok: false,
        removed: [],
        failed: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle(
    'pi:backgroundTasks:readLogs',
    async (_event, taskId: string, options?: { tail?: boolean; maxBytes?: number }) => {
      return ctx.backgroundTaskController.readLogs(taskId, options);
    }
  );
}
