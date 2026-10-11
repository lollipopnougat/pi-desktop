import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({
  platform: 'darwin',
  paths: new Set<string>(),
  directories: new Map<string, string[]>(),
  execFile: vi.fn(),
  spawn: vi.fn(),
  openPath: vi.fn(),
  getFileIcon: vi.fn(),
  createFromPath: vi.fn()
}));

vi.mock('electron', () => ({
  app: { getFileIcon: mocks.getFileIcon },
  nativeImage: { createFromPath: mocks.createFromPath },
  shell: { openPath: mocks.openPath }
}));
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }));
vi.mock('fs', () => ({
  default: {
    existsSync: (file: string) => mocks.paths.has(file),
    readdirSync: (root: string) =>
      (mocks.directories.get(root) ?? []).map((name) => ({ name, isDirectory: () => true })),
    realpathSync: (file: string) => file
  }
}));
vi.mock('os', () => ({
  default: { platform: () => mocks.platform, homedir: () => '/Users/test' }
}));

const vscode = '/Applications/Visual Studio Code.app';
const finder = '/System/Library/CoreServices/Finder.app';
const image = (value: string) => ({
  isEmpty: () => false,
  toDataURL: () => `data:image/png;base64,${value}`
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.platform = 'darwin';
  mocks.paths = new Set([vscode, finder]);
  mocks.directories = new Map();
  mocks.openPath.mockResolvedValue('');
  mocks.getFileIcon.mockResolvedValue(image('native'));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  mocks.execFile.mockImplementation((file, args, _options, callback) => {
    if (file === '/usr/bin/osascript') {
      const paths = args.slice(args.indexOf('--') + 1);
      callback(
        null,
        JSON.stringify(paths.map((_: string, index: number) => image(`icon${index}`).toDataURL()))
      );
    } else callback(null, '');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('本机外部应用图标', () => {
  it('保留标准目录和 Spotlight 检测到的真实安装路径，批量读取系统图标', async () => {
    const customPath = "/Volumes/Apps/iTerm custom's.app";
    mocks.paths.add(customPath);
    const originalExec = mocks.execFile.getMockImplementation()!;
    mocks.execFile.mockImplementation((file, args, options, callback) => {
      if (file === '/usr/bin/mdfind' && args[1].includes('com.googlecode.iterm2')) {
        callback(null, `/missing/iTerm.app\0${customPath}\0`);
      } else originalExec(file, args, options, callback);
    });
    const { detectExternalApps } = await import('../electron/external-apps');
    const apps = await detectExternalApps();

    expect(apps.map((candidate) => candidate.id)).toEqual(['vscode', 'iterm', 'default']);
    expect(apps.every((candidate) => candidate.icon?.startsWith('data:image/png;base64,'))).toBe(
      true
    );
    expect(apps.every((candidate) => !('path' in candidate))).toBe(true);
    const iconCall = mocks.execFile.mock.calls.find(([file]) => file === '/usr/bin/osascript')!;
    expect(iconCall[1].slice(-3)).toEqual([vscode, customPath, finder]);
    expect(iconCall[1][3]).not.toContain(customPath);
    expect(mocks.getFileIcon).not.toHaveBeenCalled();
  });

  it('原生读取失败时保留已安装程序和默认程序，允许界面使用兜底图标', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('系统图标读取失败'), '');
    });
    const { detectExternalApps } = await import('../electron/external-apps');
    const apps = await detectExternalApps();

    expect(apps.map((candidate) => candidate.id)).toEqual(['vscode', 'default']);
    expect(apps.every((candidate) => candidate.icon === undefined)).toBe(true);
  });

  it('单个图标缺失或格式无效不影响其他图标', async () => {
    mocks.execFile.mockImplementation((file, _args, _options, callback) => {
      callback(
        null,
        file === '/usr/bin/osascript'
          ? JSON.stringify(['file:///invalid.png', image('finder').toDataURL()])
          : ''
      );
    });
    const { detectExternalApps } = await import('../electron/external-apps');
    const apps = await detectExternalApps();

    expect(apps[0].icon).toBeUndefined();
    expect(apps[1].icon).toBe(image('finder').toDataURL());
  });

  it('并发请求共用缓存，过期后重新检测安装状态', async () => {
    vi.useFakeTimers();
    const { detectExternalApps } = await import('../electron/external-apps');
    const first = detectExternalApps();
    expect(detectExternalApps()).toBe(first);
    await first;
    mocks.paths.delete(vscode);
    expect(await detectExternalApps()).toHaveLength(2);
    vi.setSystemTime(Date.now() + 60_001);
    const refreshed = await detectExternalApps();

    expect(refreshed.map((candidate) => candidate.id)).toEqual(['default']);
    expect(
      mocks.execFile.mock.calls.filter(([file]) => file === '/usr/bin/osascript')
    ).toHaveLength(2);
  });

  it('Windows 从已安装的可执行文件读取图标，单项失败不影响列表', async () => {
    mocks.platform = 'win32';
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\test\\AppData\\Local');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const executable = 'C:\\Users\\test\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
    mocks.paths = new Set([executable, 'C:\\Windows\\explorer.exe']);
    mocks.getFileIcon.mockImplementation(async (file) => {
      if (file === executable) return image('vscode');
      throw new Error('图标不可用');
    });
    const { detectExternalApps } = await import('../electron/external-apps');
    const apps = await detectExternalApps();

    expect(apps[0]).toMatchObject({ id: 'vscode', icon: image('vscode').toDataURL() });
    expect(apps[1]).toMatchObject({ id: 'default', icon: undefined });
    expect(mocks.getFileIcon).toHaveBeenCalledWith(executable, { size: 'normal' });
  });

  it('Linux 优先读取软件安装包的图标资源', async () => {
    mocks.platform = 'linux';
    const iconPath = '/usr/share/code/resources/app/resources/linux/code.png';
    mocks.paths = new Set(['/usr/bin/code', iconPath]);
    mocks.execFile.mockImplementation((_file, args, _options, callback) =>
      args[0] === 'code' ? callback(null, '/usr/bin/code\n') : callback(new Error('未安装'), '')
    );
    mocks.createFromPath.mockReturnValue(image('code-linux'));
    const { detectExternalApps } = await import('../electron/external-apps');
    const apps = await detectExternalApps();

    expect(apps[0]).toMatchObject({ id: 'vscode', icon: image('code-linux').toDataURL() });
    expect(mocks.createFromPath).toHaveBeenCalledWith(iconPath);
    expect(mocks.getFileIcon).not.toHaveBeenCalled();
  });

  it('macOS 同时识别 IDEA、社区版、Visual Studio 及 Toolbox 安装的软件', async () => {
    mocks.paths = new Set([
      finder,
      '/Applications/IntelliJ IDEA.app',
      '/Users/test/Applications/IntelliJ IDEA CE.app',
      '/Applications/Visual Studio.app',
      '/Users/test/Applications/JetBrains Toolbox/WebStorm.app'
    ]);
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    const apps = await detectExternalApps();
    expect(apps.map((candidate) => candidate.id)).toEqual([
      'idea',
      'idea-ce',
      'visualstudio',
      'webstorm',
      'default'
    ]);

    await openExternalApp('/project/source.ts', 'idea-ce');
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', '/Users/test/Applications/IntelliJ IDEA CE.app', '/project/source.ts'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('Windows 定位自定义目录的 Visual Studio，排除 Build Tools 并选择最新 IDE', async () => {
    mocks.platform = 'win32';
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    vi.stubEnv('ProgramFiles(x86)', 'C:\\Program Files (x86)');
    const locator = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
    const executable = 'D:\\Development\\Visual Studio\\Common7\\IDE\\devenv.exe';
    mocks.paths = new Set([locator, executable, 'D:\\VS-old\\Common7\\IDE\\devenv.exe']);
    mocks.execFile.mockImplementation((file, args, _options, callback) => {
      expect(file).toBe(locator);
      expect(args).toEqual(['-products', '*', '-format', 'json', '-utf8']);
      callback(
        null,
        JSON.stringify([
          { installationPath: 'D:\\VS-old', installationVersion: '17.0.0' },
          { installationPath: 'D:\\BuildTools', installationVersion: '20.0.0' },
          { installationPath: 'D:\\Development\\Visual Studio', installationVersion: '18.0.0' }
        ])
      );
    });
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    expect((await detectExternalApps()).map((candidate) => candidate.id)).toEqual([
      'visualstudio',
      'default'
    ]);
    const file = 'D:\\source folder\\one & two.cs';
    await openExternalApp(file, 'visualstudio');
    expect(mocks.spawn).toHaveBeenLastCalledWith(executable, ['/Edit', file], {
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    expect(mocks.spawn.mock.results[0].value.unref).toHaveBeenCalledOnce();
    await openExternalApp('D:\\source\\app.sln', 'visualstudio');
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      executable,
      ['D:\\source\\app.sln'],
      expect.any(Object)
    );
  });

  it('Visual Studio 定位器不可用时检测版本和版本类型目录', async () => {
    mocks.platform = 'win32';
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    const root = 'C:\\Program Files\\Microsoft Visual Studio';
    const executable = root + '\\2022\\Community\\Common7\\IDE\\devenv.exe';
    mocks.directories.set(root, ['Installer', '2022']);
    mocks.paths = new Set([executable]);
    const { openExternalApp } = await import('../electron/external-apps');
    await openExternalApp('C:\\a.cs', 'visualstudio');
    expect(mocks.spawn).toHaveBeenCalledWith(executable, ['/Edit', 'C:\\a.cs'], expect.any(Object));
  });

  it('Windows 识别 JetBrains 版本目录和 Toolbox 旧版布局，社区版单独启动', async () => {
    mocks.platform = 'win32';
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Local');
    const root = 'C:\\Program Files\\JetBrains';
    const toolbox = 'C:\\Local\\JetBrains\\Toolbox\\apps';
    const idea = root + '\\IntelliJ IDEA 2026.1\\bin\\idea64.exe';
    const community = toolbox + '\\IDEA-C\\ch-0\\251.42\\bin\\idea64.exe';
    mocks.directories.set(root, ['IntelliJ IDEA 2024.3', 'IntelliJ IDEA 2026.1']);
    mocks.directories.set(toolbox, ['IDEA-C']);
    mocks.directories.set(toolbox + '\\IDEA-C', ['ch-0']);
    mocks.directories.set(toolbox + '\\IDEA-C\\ch-0', ['251.42']);
    mocks.paths = new Set([idea, community, root + '\\IntelliJ IDEA 2024.3\\bin\\idea64.exe']);
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    expect((await detectExternalApps()).map((candidate) => candidate.id)).toEqual([
      'idea',
      'idea-ce',
      'default'
    ]);
    await openExternalApp('C:\\code.java', 'idea');
    expect(mocks.spawn).toHaveBeenLastCalledWith(idea, ['C:\\code.java'], expect.any(Object));
    await openExternalApp('C:\\code.java', 'idea-ce');
    expect(mocks.spawn).toHaveBeenLastCalledWith(community, ['C:\\code.java'], expect.any(Object));
  });

  it('Linux 识别 Toolbox 启动脚本并直接启动该脚本，不依赖全局命令', async () => {
    mocks.platform = 'linux';
    const executable = '/Users/test/.local/share/JetBrains/Toolbox/scripts/idea';
    mocks.paths = new Set([executable]);
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    expect((await detectExternalApps()).map((candidate) => candidate.id)).toEqual([
      'idea',
      'default'
    ]);
    await openExternalApp('/project/main.java', 'idea');
    expect(mocks.spawn).toHaveBeenCalledWith(
      executable,
      ['/project/main.java'],
      expect.any(Object)
    );
  });

  it('应用移动后重新定位，使用新路径打开而非旧缓存', async () => {
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    await detectExternalApps();
    mocks.paths.delete(vscode);
    const moved = '/Volumes/Apps/VS Code.app';
    mocks.paths.add(moved);
    const originalExec = mocks.execFile.getMockImplementation()!;
    mocks.execFile.mockImplementation((file, args, options, callback) => {
      if (
        file === '/usr/bin/mdfind' &&
        args[1] === "kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'"
      ) {
        callback(null, moved + '\0');
      } else originalExec(file, args, options, callback);
    });
    await openExternalApp('/project/test.ts', 'vscode');
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      ['-a', moved, '/project/test.ts'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('未知应用和已卸载应用报告错误，不静默切换为默认程序', async () => {
    const { detectExternalApps, openExternalApp } = await import('../electron/external-apps');
    await detectExternalApps();
    mocks.paths.delete(vscode);
    await expect(openExternalApp('/project/file', 'vscode')).rejects.toThrow('未找到所选程序');
    await expect(openExternalApp('/project/file', '/tmp/unknown-app')).rejects.toThrow(
      '未找到所选程序'
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls.some(([file]) => file === '/usr/bin/open')).toBe(false);
  });

  it('默认程序或进程启动失败时向界面返回错误', async () => {
    mocks.platform = 'win32';
    vi.stubEnv('ProgramFiles', 'C:\\Program Files');
    mocks.paths = new Set(['C:\\Program Files\\Microsoft VS Code\\Code.exe']);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('启动失败')));
      return child;
    });
    mocks.openPath.mockResolvedValue('默认程序不可用');
    const { openExternalApp } = await import('../electron/external-apps');
    await expect(openExternalApp('C:\\file.txt', 'vscode')).rejects.toThrow('启动失败');
    await expect(openExternalApp('C:\\file.txt', 'default')).rejects.toThrow('默认程序不可用');
  });
});
