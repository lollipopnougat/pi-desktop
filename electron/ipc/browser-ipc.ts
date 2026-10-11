import { ipcMain } from 'electron';
import { readUiSettingsForMain, writeUiSettingsForMain } from './settings-ipc';
import type { BrowserController } from '../browser/controller';
import type { BrowserViewport } from '../browser/types';

export function registerBrowserIpc(browser: BrowserController) {
  ipcMain.handle('pi:browser:getState', () => browser.getState());
  ipcMain.handle('pi:browser:setEnabled', async (_event, enabled: boolean) => {
    const state = await browser.setEnabled(!!enabled);
    writeUiSettingsForMain({ ...readUiSettingsForMain(), browserEnabled: !!enabled });
    return state;
  });
  ipcMain.handle('pi:browser:setDevtoolsEnabled', async (_event, enabled: boolean) => {
    const state = await browser.setDevtoolsEnabled(!!enabled);
    writeUiSettingsForMain({ ...readUiSettingsForMain(), browserDevtoolsEnabled: !!enabled });
    return state;
  });
  ipcMain.handle('pi:browser:open', (_event, url?: string) => browser.open(url, true));
  ipcMain.handle('pi:browser:close', (_event, tabId?: string) => browser.close(tabId));
  ipcMain.handle('pi:browser:activate', (_event, tabId: string) => browser.activate(tabId));
  ipcMain.handle('pi:browser:navigate', (_event, tabId: string | undefined, input: string) =>
    browser.navigate(tabId, input)
  );
  ipcMain.handle('pi:browser:back', (_event, tabId?: string) => browser.back(tabId));
  ipcMain.handle('pi:browser:forward', (_event, tabId?: string) => browser.forward(tabId));
  ipcMain.handle('pi:browser:reload', (_event, tabId?: string) => browser.reload(tabId));
  ipcMain.handle('pi:browser:stop', (_event, tabId?: string) => browser.stop(tabId));
  ipcMain.handle('pi:browser:setViewport', (_event, viewport: BrowserViewport) => {
    browser.setViewport(viewport);
    return { ok: true };
  });
  ipcMain.handle('pi:browser:setVisible', (_event, visible: boolean) => {
    browser.setVisible(visible);
    return { ok: true };
  });
  ipcMain.handle('pi:browser:clearData', async () => {
    await browser.clearData();
    return { ok: true };
  });
}
