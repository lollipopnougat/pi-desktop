// 必须最先导入：模块加载时设置 PI_CODING_AGENT_DIR 环境变量，
// 将 SDK 内部所有默认路径（getAgentDir/getSessionsDir 等）重定向到 ~/.pi-desktop。
// 必须在任何 SDK 模块被 require 之前执行。
import './config-dir';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  ipcMain,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions
} from 'electron';
import fs from 'fs';
import path from 'path';
import { PiBridge } from './pi-bridge';
import { logAppEvent } from './logs/channel-logs';
import { deleteOrphanSubagentSessions } from './subagents/session-file';

// SDK 的 getPackageDir() / getExportTemplateDir() 基于 __dirname 向上查找 package.json，
// 在 Vite 把 SDK 打包进 dist-electron/main.js 后，__dirname 会解析到项目根，
// 又因项目根存在 src/ 目录，SDK 误判走 "src" 分支，拼出不存在的
// .../piui/src/core/export-html/template.html，导致导出 HTML 时 ENOENT。
// 通过 PI_PACKAGE_DIR 环境变量显式指向 SDK 真实安装目录，让 SDK 正确返回 dist 路径。
// bundle 后 __dirname 指向 dist-electron/，向上一级即为含 node_modules 的根目录
// （开发环境为项目根，打包环境为 app 根）。
//
// 打包环境优先选 app.asar.unpacked 下的真实副本：系统提示词的 <docs> 段由
// getReadmePath()/getDocsPath()/getExamplesPath() 拼出，若指向 asar 内路径，只有走
// Electron fs shim 的 Node 代码（read 工具）能读，bash/rg/fd 这些真实进程读不到。
// package.json 的 asarUnpack 已把 SDK 的 docs/examples/README/CHANGELOG、内置主题、
// HTML 导出模板与 package.json 解包成真实文件，这里优先指向该目录（缺失时回退 asar 内路径）。
try {
  const sdkDirCandidates = [
    ...(app.isPackaged
      ? [
          path.join(
            process.resourcesPath,
            'app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent'
          )
        ]
      : []),
    path.resolve(__dirname, '..', 'node_modules/@earendil-works/pi-coding-agent')
  ];
  for (const sdkDir of sdkDirCandidates) {
    if (fs.existsSync(path.join(sdkDir, 'package.json'))) {
      process.env.PI_PACKAGE_DIR = sdkDir;
      break;
    }
  }
} catch {
  // 解析失败时回退到默认行为（不设置），SDK 内部仍会尝试自行解析
}

const piBridge = new PiBridge();

const isMac = process.platform === 'darwin';

let mainWindow: BrowserWindow | null = null;

// 单实例锁，防止多开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// === 退出 / 关窗确认 ===
// 会话正在运行时，关窗、cmd+Q、菜单退出都要先让用户确认「将停止本轮执行」。
// 确认框是渲染进程的应用内弹窗（与切换会话等复用同一组件），所以主进程只负责拦截
// 并把问题转给渲染进程，拿到回答后再真正退出。
let quitApproved = false;
let quitInProgress = false;
let quitPromptPending = false;

/**
 * 真正退出：先中止当前回合并等待落盘（否则在途的部分回复会随进程消失），
 * 再释放终端/子 agent 等资源、销毁窗口、退出应用。
 */
async function performQuit(): Promise<void> {
  if (quitApproved || quitInProgress) return;
  quitInProgress = true;
  try {
    await piBridge.dispose();
  } catch (error) {
    console.error('Failed to clean up before quit:', error);
  } finally {
    quitApproved = true;
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.quit();
  }
}

/**
 * 请求退出（关窗 / cmd+Q / 菜单退出）：
 * 没有正在执行的回合就直接退；正在执行则交给渲染进程弹应用内确认框。
 * 渲染进程不可用时不再拦截，避免出现关不掉的窗口。
 */
function requestQuit(): void {
  if (quitApproved || quitInProgress) return;
  if (!piBridge.isSessionRunning()) {
    void performQuit();
    return;
  }
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    void performQuit();
    return;
  }
  if (quitPromptPending) return;
  quitPromptPending = true;
  win.webContents.send('pi:quitConfirmRequest');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Pi Desktop',
    // macOS 毛玻璃：只留 vibrancy，不设 backgroundColor。
    // backgroundColor（即使全透明）会初始化纯色 backing 盖住材质层，导致玻璃变灰不透明。
    // transparent: true 同样会破坏 vibrancy（走透明合成路径，不挂材质层）。
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    // Windows 11 22H2+ 亚克力毛玻璃；低版本 Windows 自动回退为普通窗口（无玻璃但不报错）
    backgroundMaterial: !isMac && process.platform === 'win32' ? 'acrylic' : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#abb2bf', height: 32 },
    // Windows/Linux 隐藏原生菜单栏，改用 HTML 自定义菜单
    autoHideMenuBar: !isMac,
    trafficLightPosition: isMac ? { x: 12, y: 14 } : undefined,
    icon: path.join(__dirname, '../build/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // === 外部链接防护（安全关键） ===
  // 应用内 markdown 消息里的链接若不拦截，点击会让 BrowserWindow 直接导航到
  // 外部网页（整个 React 界面被卸载替换，且应用内无“后退”无法返回）。
  // 标准做法：所有 window.open / target=_blank 弹窗一律转给系统默认浏览器，
  // 并阻止 Electron 创建新 BrowserWindow。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行 http(s)，其余（file://、javascript: 等）直接丢弃
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 拦截窗口内直接导航（无 target=_blank 的普通 <a> 点击、重定向等）：
  // 页面自身（dev server / dist/index.html）与内部锚点之外的一律取消，
  // http(s) 转给系统默认浏览器打开。
  const isInternalUrl = (url: string): boolean => {
    if (process.env.NODE_ENV === 'development') {
      return url.startsWith('http://localhost:5173');
    }
    return url.startsWith('file://');
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  // 关窗即退出（含 macOS，语义与 Windows/Linux 统一）：
  // 会话正在运行时由主进程拦下 close，请渲染进程弹应用内确认框后才退出。
  mainWindow.on('close', (event) => {
    if (quitApproved) return;
    event.preventDefault();
    requestQuit();
  });

  // Initialize PiBridge with a default cwd (user's home for now)
  await piBridge.init(mainWindow, app.getPath('home'));
  piBridge.registerHandlers();

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    // DevTools 用 detach（独立窗口）而非 attached：attached 模式会破坏 macOS
    // vibrancy 毛玻璃渲染（材质层失效，窗口变不透明灰，Electron 已知问题）。
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  // 清理孤儿子 agent 会话文件(父主会话已被删/未记录父会话的历史遗留)
  try {
    deleteOrphanSubagentSessions();
  } catch {}
  // macOS: 开发模式下设置 Dock 图标（打包后由 .icns 自动生效）
  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = path.join(__dirname, '../build/icons/icon.png');
    try {
      const iconImage = nativeImage.createFromPath(iconPath);
      if (!iconImage.isEmpty()) {
        app.dock?.setIcon(iconImage);
      }
    } catch {}
  }

  // 应用菜单栏：macOS 显示系统顶部菜单，Windows/Linux 显示窗口内菜单栏
  const menuTemplate: MenuItemConstructorOptions[] = [
    // macOS App 菜单（应用名/关于/退出）
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: `关于 ${app.name}` },
              { type: 'separator' as const },
              {
                label: '设置...',
                accelerator: 'Cmd+,',
                click: () => {
                  mainWindow?.webContents.send('pi:menuOpenSettings');
                }
              },
              { type: 'separator' as const },
              { role: 'quit' as const, label: `退出 ${app.name}` }
            ]
          }
        ]
      : []),
    // File 菜单（打开文件夹）
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件夹...',
          accelerator: isMac ? 'Cmd+O' : 'Ctrl+O',
          click: () => {
            mainWindow?.webContents.send('pi:menuOpenFolder');
          }
        }
      ]
    },
    // Edit 菜单（复制/粘贴/撤销/全选，输入框依赖）
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        { role: 'selectAll' as const, label: '全选' }
      ]
    },
    // View 菜单（开发者工具/重载，开发调试用）
    {
      label: '视图',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '开发者工具' },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: '重置缩放' },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' }
      ]
    },
    // Window 菜单（最小化/关闭）
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'close' as const, label: '关闭' }
      ]
    },
    // Windows/Linux 帮助菜单（关于）
    ...(!isMac
      ? [
          {
            label: '帮助',
            submenu: [
              {
                label: `关于 ${app.name}`,
                click: () => {
                  dialog.showMessageBox(mainWindow!, {
                    type: 'info',
                    title: `关于 ${app.name}`,
                    message: app.name,
                    detail: `版本 ${app.getVersion()}\n基于 pi agent SDK 的桌面端 AI 编码助手`,
                    buttons: ['确定']
                  });
                }
              }
            ]
          }
        ]
      : [])
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // 主题明暗联动窗口材质（渲染进程在 applyTheme 后调用）：
  // - macOS: NSVisualEffectView 材质明暗跟随窗口 appearance，而 Electron 中窗口
  //   appearance 由 <html> 的 CSS color-scheme 驱动（nativeTheme 只影响 Chromium 内部
  //   UI）。因此这里同步设置 documentElement.style.colorScheme，再 flicker 重挂
  //   vibrancy（null → under-window）让材质层立即应用新 appearance。
  // - Windows: titleBarOverlay 符号颜色跟随明暗；亚克力材质随系统主题。
  // 注：应用主题设为“跟随系统”时传 system（不覆盖系统外观）。
  ipcMain.handle('pi:resolveQuitConfirm', async (_e, confirmed: boolean) => {
    quitPromptPending = false;
    if (confirmed) await performQuit();
  });

  ipcMain.handle('pi:setThemeAppearance', (_e, mode: 'dark' | 'light' | 'system') => {
    try {
      if (mode === 'dark' || mode === 'light') {
        nativeTheme.themeSource = mode;
      } else {
        nativeTheme.themeSource = 'system';
      }
      if (mainWindow && process.platform === 'darwin') {
        // under-window 材质明暗跟随系统外观（不跟随 app 内主题 override）。
        // 应用切浅色主题时改用 titlebar 材质（light appearance 下呈亮玻璃），
        // 深色时用 under-window。先置 null 强制重建材质层。
        const material = mode === 'light' ? 'titlebar' : 'under-window';
        mainWindow.setVibrancy(null);
        mainWindow.setVibrancy(material);
      } else if (mainWindow && process.platform === 'win32') {
        const light = nativeTheme.shouldUseDarkColors === false;
        mainWindow.setTitleBarOverlay(
          light
            ? { color: '#00000000', symbolColor: '#5c6370' }
            : { color: '#00000000', symbolColor: '#abb2bf' }
        );
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  logAppEvent({ phase: 'quit', reason: 'window-all-closed' });
  piBridge.detachWindow();
  mainWindow = null;
  // 关窗即退出（含 macOS）。正常路径已由 win.on('close') → requestQuit 处理，这里兜底。
  if (!quitApproved) {
    void performQuit();
  }
});

app.on('before-quit', (event) => {
  if (quitApproved) return;
  // cmd+Q / 菜单「退出」：同样先问一次（会话运行中时）
  event.preventDefault();
  requestQuit();
});

app.on('activate', () => {
  if (quitInProgress || quitApproved) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    // 已有窗口（可能是从 Dock 点开的隐藏窗口），直接聚焦
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// ==== 应用级异常 / 进程崩溃落盘（~/.pi-desktop/logs/app-*.log） ====
// 排查「应用莫名退出」时，没有这些旁听器就什么都不剩（此前只能靠猜）。
process.on('uncaughtException', (err) => {
  logAppEvent({ phase: 'error', kind: 'uncaughtException', error: err, pid: process.pid }, 'error');
  // 与 Node 默认行为一致：主进程未捕获异常 → 退出（先把日志写盘）
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Electron 下未处理的 Promise 拒绝默认不退出进程（与 Node 24 不同），这里只记一行
  logAppEvent({ phase: 'error', kind: 'unhandledRejection', error: reason }, 'warn');
});

app.on('render-process-gone', (_event, _webContents, details) => {
  // reason='killed' 是开发时 vite 重启/用户主动关闭的正常死亡，降为 info，别吓人；崩溃（crashed/oom）才 warn
  const reason = details?.reason ?? null;
  logAppEvent(
    {
      phase: 'error',
      kind: 'render-process-gone',
      reason,
      exitCode: details?.exitCode ?? null
    },
    reason === 'killed' || reason === 'clean-exit' ? 'info' : 'warn'
  );
});

app.on('child-process-gone', (_event, details) => {
  const reason = details?.reason ?? null;
  logAppEvent(
    {
      phase: 'error',
      kind: 'child-process-gone',
      processType: details?.type ?? null,
      reason,
      exitCode: details?.exitCode ?? null
    },
    reason === 'killed' || reason === 'clean-exit' ? 'info' : 'warn'
  );
});
