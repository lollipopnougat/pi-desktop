import { app, nativeImage, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ExternalApp } from '../src/types/shared';
import { t } from '../src/i18n/zh';
import { EXTERNAL_APP_CATALOG, type ExternalAppDefinition } from './external-app-catalog';

interface InstalledApp extends ExternalApp {
  path?: string;
  iconPath?: string;
}

// AppKit 本地接口不发送 Apple Events，也不启动目标应用。
// macOS 上 getFileIcon(.app) 可能只返回通用应用图标，因此直接使用 NSWorkspace。
const MAC_ICON_SCRIPT = `
ObjC.import('AppKit');
function run(paths) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  return JSON.stringify(paths.map(function (path) {
    try {
      const original = workspace.iconForFile($(path));
      const icon = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      icon.lockFocus;
      original.drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationCopy, 1
      );
      icon.unlockFocus;
      const bitmap = $.NSBitmapImageRep.imageRepWithData(icon.TIFFRepresentation);
      const data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      return 'data:image/png;base64,' + ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    } catch (_) { return null; }
  }));
}`;

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function findMacApp(definition: ExternalAppDefinition): Promise<string | undefined> {
  if (!definition.mac) return undefined;
  const roots = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
    path.join(os.homedir(), 'Applications', 'JetBrains Toolbox')
  ];
  const standardPath = roots
    .flatMap((root) => definition.mac!.names.map((name) => path.join(root, name)))
    .find((candidate) => fs.existsSync(candidate));
  if (standardPath) return standardPath;
  try {
    const output = await runFile('/usr/bin/mdfind', [
      '-0',
      definition.mac.bundleIds.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(' || ')
    ]);
    return output
      .split('\0')
      .find(
        (candidate) =>
          path.isAbsolute(candidate) && candidate.endsWith('.app') && fs.existsSync(candidate)
      );
  } catch {
    return undefined;
  }
}

function directories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function windowsRoots(): string[] {
  const local = process.env.LOCALAPPDATA;
  return [
    ...new Set([
      ...(local ? [path.win32.join(local, 'Programs'), local] : []),
      process.env.ProgramFiles || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    ])
  ];
}

/** 只在已匹配的产品目录中查版本/channel 子目录，不遍历其他软件或整个磁盘。 */
function findToolboxExecutable(root: string, executable: string, depth = 2): string | undefined {
  const candidate = path.win32.join(root, 'bin', executable);
  if (fs.existsSync(candidate)) return candidate;
  if (depth === 0) return undefined;
  for (const directory of directories(root)
    .filter((name) => /^(?:ch-|\d)/.test(name))
    .slice(0, 12)) {
    const nested = findToolboxExecutable(path.win32.join(root, directory), executable, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

async function findVisualStudio(): Promise<string | undefined> {
  const roots = windowsRoots();
  const locator = roots
    .map((root) => path.win32.join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))
    .find((candidate) => fs.existsSync(candidate));
  if (locator) {
    try {
      const result: unknown = JSON.parse(
        await runFile(locator, ['-products', '*', '-format', 'json', '-utf8'])
      );
      if (Array.isArray(result)) {
        const instances = result.filter(
          (item): item is { installationPath: string; installationVersion?: string } =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.installationPath === 'string' &&
            path.win32.isAbsolute(item.installationPath)
        );
        instances.sort((a, b) =>
          String(b.installationVersion ?? '').localeCompare(
            String(a.installationVersion ?? ''),
            undefined,
            { numeric: true }
          )
        );
        // Build Tools 没有 IDE 可执行文件，不能作为“打开方式”。
        for (const instance of instances) {
          const candidate = path.win32.join(
            instance.installationPath,
            'Common7',
            'IDE',
            'devenv.exe'
          );
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      /* 未安装定位工具或其输出不可用时检查常见安装目录。 */
    }
  }
  for (const root of roots) {
    const base = path.win32.join(root, 'Microsoft Visual Studio');
    for (const version of directories(base).filter((name) => /^\d[\d.]*$/.test(name))) {
      for (const edition of ['Enterprise', 'Professional', 'Community', 'Preview']) {
        const candidate = path.win32.join(base, version, edition, 'Common7', 'IDE', 'devenv.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

async function findWindowsApp(definition: ExternalAppDefinition): Promise<string | undefined> {
  const windows = definition.windows;
  if (!windows) return undefined;
  if (windows.visualStudio) return findVisualStudio();
  const roots = windowsRoots();
  const standardPath = roots
    .flatMap((root) => (windows.paths ?? []).map((relative) => path.win32.join(root, relative)))
    .find((candidate) => fs.existsSync(candidate));
  if (standardPath || !windows.directoryPattern || !windows.executable) return standardPath;
  const local = process.env.LOCALAPPDATA;
  const productRoots = [
    ...new Set([
      ...roots.map((root) => path.win32.join(root, 'JetBrains')),
      ...(local
        ? [
            path.win32.join(local, 'Programs'),
            path.win32.join(local, 'JetBrains', 'Toolbox', 'apps')
          ]
        : [])
    ])
  ];
  for (const root of productRoots) {
    for (const directory of directories(root).filter((name) =>
      windows.directoryPattern!.test(name)
    )) {
      const executable = findToolboxExecutable(
        path.win32.join(root, directory),
        windows.executable
      );
      if (executable) return executable;
    }
  }
  return undefined;
}

async function findLinuxApp(
  definition: ExternalAppDefinition
): Promise<Pick<InstalledApp, 'path' | 'iconPath'>> {
  if (!definition.linux) return {};
  const { commands, icons = [], bundledIcon } = definition.linux;
  for (const command of commands) {
    const scripts = [
      path.join(os.homedir(), '.local', 'bin', command),
      path.join(os.homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', command)
    ];
    let executable = scripts.find((candidate) => fs.existsSync(candidate));
    if (!executable) {
      try {
        const candidate = (await runFile('which', [command])).trim();
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) executable = candidate;
      } catch {
        /* 继续检测该软件的其他启动命令。 */
      }
    }
    if (!executable) continue;
    let resolved = executable;
    try {
      resolved = fs.realpathSync(executable);
    } catch {
      /* 保留已检测到的启动路径。 */
    }
    const bundledIcons = bundledIcon
      ? ['png', 'svg'].map((ext) => path.join(path.dirname(resolved), `${bundledIcon}.${ext}`))
      : [];
    return {
      path: executable,
      iconPath: [...icons, ...bundledIcons].find((candidate) => fs.existsSync(candidate))
    };
  }
  return {};
}

async function findInstalledApps(): Promise<InstalledApp[]> {
  const platform = os.platform();
  const detected = await Promise.all(
    EXTERNAL_APP_CATALOG.map(async (definition): Promise<InstalledApp> => ({
      id: definition.id,
      name: definition.name,
      ...(platform === 'darwin'
        ? { path: await findMacApp(definition) }
        : platform === 'win32'
          ? { path: await findWindowsApp(definition) }
          : await findLinuxApp(definition))
    }))
  );
  const installed = detected.filter((candidate) => candidate.path !== undefined);

  const defaultPath =
    platform === 'darwin'
      ? '/System/Library/CoreServices/Finder.app'
      : platform === 'win32'
        ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
        : undefined;
  installed.push({
    id: 'default',
    name: t.defaultApp,
    path: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined
  });
  return installed;
}

async function loadApps(): Promise<InstalledApp[]> {
  const installed = await findInstalledApps();
  const icons = new Map<string, string>();
  if (os.platform() === 'darwin') {
    const targets = installed.filter((candidate) => candidate.path !== undefined);
    if (targets.length > 0) {
      try {
        const result: unknown = JSON.parse(
          await runFile('/usr/bin/osascript', [
            '-l',
            'JavaScript',
            '-e',
            MAC_ICON_SCRIPT,
            '--',
            ...targets.map((candidate) => candidate.path!)
          ])
        );
        if (Array.isArray(result)) {
          targets.forEach((candidate, index) => {
            const icon: unknown = result[index];
            if (typeof icon === 'string' && icon.startsWith('data:image/png;base64,')) {
              icons.set(candidate.id, icon);
            }
          });
        }
      } catch {
        /* 图标不可用不影响应用列表及打开操作。 */
      }
    }
  } else {
    await Promise.all(
      installed.map(async (candidate) => {
        if (!candidate.path) return;
        try {
          const icon = candidate.iconPath
            ? nativeImage.createFromPath(candidate.iconPath)
            : await app.getFileIcon(candidate.path, { size: 'normal' });
          if (!icon.isEmpty()) icons.set(candidate.id, icon.toDataURL());
        } catch {
          /* 单个图标读取失败时使用界面兜底。 */
        }
      })
    );
  }
  return installed.map((candidate) => ({ ...candidate, icon: icons.get(candidate.id) }));
}

let cache:
  | {
      expiresAt: number;
      installed: Promise<InstalledApp[]>;
      public: Promise<ExternalApp[]>;
    }
  | undefined;

/** 合并并发请求并短暂缓存，避免切换文件、展开菜单时反复扫描或启动图标读取进程。 */
function getApps() {
  if (cache && cache.expiresAt > Date.now()) return cache;
  const installed = loadApps();
  // 安装路径只留在主进程，renderer 只收到名称与图标。
  const publicApps = installed.then((apps) =>
    apps.map(({ id, name, icon }) => ({ id, name, icon }))
  );
  cache = { expiresAt: Date.now() + 60_000, installed, public: publicApps };
  void publicApps.catch(() => {
    if (cache?.installed === installed) cache = undefined;
  });
  return cache;
}

export function detectExternalApps(): Promise<ExternalApp[]> {
  return getApps().public;
}

/** 使用检测到的真实安装路径启动，避免显示某个软件却调用另一个同名命令。 */
export async function openExternalApp(filePath: string, appId: string): Promise<void> {
  if (appId === 'default') {
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return;
  }
  const definition = EXTERNAL_APP_CATALOG.find((candidate) => candidate.id === appId);
  if (!definition) throw new Error(t.externalAppUnavailable);
  let installed = (await getApps().installed).find((candidate) => candidate.id === appId);
  if (!installed?.path || !fs.existsSync(installed.path)) {
    cache = undefined;
    installed = (await getApps().installed).find((candidate) => candidate.id === appId);
  }
  if (!installed?.path) throw new Error(t.externalAppUnavailable);
  if (os.platform() === 'darwin') {
    await runFile('/usr/bin/open', ['-a', installed.path, filePath]);
    return;
  }
  const args =
    appId === 'visualstudio' && !/\.(?:slnx?|\w*proj)$/i.test(filePath)
      ? ['/Edit', filePath]
      : [filePath];
  const executable = installed.path;
  // GUI 进程长期运行；以 spawn 成功为完成条件，不等待退出也不设杀进程的超时。
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
