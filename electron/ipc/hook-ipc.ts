/**
 * 钩子管理 IPC：设置页对 ~/.pi-desktop/hooks.json 的 CRUD。
 * runner 每次事件实时重读配置文件，因此这些写操作立即生效，无需通知主进程其他模块。
 */
import { ipcMain } from 'electron';
import type { PiBridge } from '../pi-bridge';
import { deleteHook, readHooks, setHookEnabled, upsertHook } from '../hooks/config';

export function registerHookIpc(_ctx: PiBridge) {
  ipcMain.handle('pi:getHooks', async () => {
    return readHooks();
  });

  ipcMain.handle('pi:upsertHook', async (_e, input: unknown) => {
    try {
      return { ok: true, hook: upsertHook(input) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('pi:deleteHook', async (_e, id: string) => {
    return { ok: deleteHook(id) };
  });

  ipcMain.handle('pi:setHookEnabled', async (_e, id: string, enabled: boolean) => {
    const hook = setHookEnabled(id, enabled);
    return hook ? { ok: true, hook } : { ok: false, error: 'hook not found' };
  });
}
