/**
 * 开源许可查看窗口：展示随包分发的第三方许可清单 THIRD-PARTY-NOTICES.txt。
 *
 * 清单由 scripts/generate-third-party-notices.mjs 在构建期生成（npm run notices），
 * electron-builder 经 extraResources 把它拷到安装目录根部，随安装包一起分发。
 *
 * 为什么用独立 BrowserWindow 直接 loadFile：
 * - 清单约 2 MB 纯文本，交给 Chromium 的原生文本渲染即可（自带 Ctrl/Cmd+F 查找、可选中复制），
 *   不必把文本经 IPC 送进渲染进程，也不占用 React 状态；
 * - 窗口读的就是安装目录里的那份文件，与构建产物始终一致，没有第二份副本会漂移。
 *
 * 入口：菜单「帮助 → 开源许可」（macOS 在 App 菜单）、关于对话框的「开源许可」按钮、
 * 渲染进程 IPC pi:openThirdPartyNotices（Windows/Linux 自绘标题栏菜单）。
 */
import { app, BrowserWindow, dialog, nativeTheme } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * 清单文件路径：
 * - 打包后：process.resourcesPath/THIRD-PARTY-NOTICES.txt（extraResources 的 to 目标）
 * - 开发模式：仓库 resources/THIRD-PARTY-NOTICES.txt（生成物、不入版本库，需先跑 npm run notices）
 * 与 pi-bridge 的 getBuiltinSkillsDir / getBuiltinDocsDir 同一套解析规则。
 */
export function getThirdPartyNoticesPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')
    : path.resolve(__dirname, '..', 'resources', 'THIRD-PARTY-NOTICES.txt');
}

/** 当前打开的许可窗口（单例：重复触发只聚焦，不叠窗口） */
let noticesWindow: BrowserWindow | null = null;

/** 给纯文本页注入的样式：跟随应用主题（Chromium 默认白底黑字），等宽字体 + 自动折行 */
function viewerCss(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  return [
    `html, body { background: ${dark ? '#1e2227' : '#ffffff'}; color: ${dark ? '#abb2bf' : '#383a42'}; }`,
    'body { margin: 0; }',
    'pre { margin: 0; padding: 16px 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace; font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: break-word; }'
  ].join('\n');
}

/**
 * 打开（或聚焦）开源许可窗口。
 * 清单不存在时只弹提示、不建窗口：开发模式下忘跑 npm run notices 的常见情形。
 */
export async function openThirdPartyNoticesWindow(
  parent?: BrowserWindow | null
): Promise<{ ok: boolean; error?: string }> {
  const file = getThirdPartyNoticesPath();
  if (!fs.existsSync(file)) {
    const options = {
      type: 'info' as const,
      title: '开源许可',
      message: '许可清单尚未生成',
      detail: `未找到 ${file}\n\n开发模式下请先执行 npm run notices 生成清单；打包版应随安装目录分发该文件。`,
      buttons: ['确定']
    };
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
    return { ok: false, error: 'notices-file-missing' };
  }

  if (noticesWindow && !noticesWindow.isDestroyed()) {
    if (noticesWindow.isMinimized()) noticesWindow.restore();
    noticesWindow.focus();
    return { ok: true };
  }

  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 560,
    minHeight: 360,
    title: '开源许可',
    show: false,
    backgroundColor: dark ? '#1e2227' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { spellcheck: false }
  });
  noticesWindow = win;
  // 纯文本页会把文档标题设成文件名，别让它盖掉窗口标题
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    if (noticesWindow === win) noticesWindow = null;
  });

  try {
    await win.loadFile(file);
    await win.webContents.insertCSS(viewerCss());
    if (!win.isDestroyed()) win.show();
    return { ok: true };
  } catch (err) {
    if (!win.isDestroyed()) win.destroy();
    noticesWindow = null;
    return { ok: false, error: String(err) };
  }
}
