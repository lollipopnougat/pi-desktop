/**
 * git-ai 内联扩展的路径解析单测。
 *
 * 回归背景：旧实现用 `process.env.HOME` 拼 `~/.git-ai/bin/git-ai`。Windows 默认
 * 不设 HOME（只设 USERPROFILE），GUI 启动的 Electron 进程里 HOME 恒为 undefined，
 * 于是拼出字面量 `undefined/.git-ai/bin/git-ai`，spawn 报 ENOENT 又被 catch 静默
 * 吞掉 —— 表现为 git-ai 在 Windows 上完全失效却没有任何提示。这里锁定跨平台行为。
 */
import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  expandUserPath,
  installedGitAiPath,
  resolveAbsolutePath,
  resolveGitAiBin
} from '../../electron/git-ai/paths';

const HOME = join('/Users', 'test');
const neverExists = () => false;
const alwaysExists = () => true;

describe('resolveGitAiBin', () => {
  it('未安装时退化为 PATH 兜底，并保持静默（expectAvailable=false）', () => {
    expect(
      resolveGitAiBin({ env: {}, platform: 'darwin', home: HOME, fileExists: neverExists })
    ).toEqual({ bin: 'git-ai', source: 'path', expectAvailable: false });
  });

  it('macOS/Linux：命中官方安装落点 ~/.git-ai/bin/git-ai', () => {
    const installed = installedGitAiPath('linux', HOME);
    expect(
      resolveGitAiBin({
        env: {},
        platform: 'linux',
        home: HOME,
        fileExists: (p) => p === installed
      })
    ).toEqual({ bin: installed, source: 'installed', expectAvailable: true });
  });

  it('Windows：可执行文件名带 .exe（安装脚本装的是 git-ai.exe）', () => {
    const home = join('C:\\Users', 'lolli');
    const installed = installedGitAiPath('win32', home);
    const resolved = resolveGitAiBin({
      env: {},
      platform: 'win32',
      home,
      fileExists: (p) => p === installed
    });

    expect(resolved.bin.endsWith('git-ai.exe')).toBe(true);
    expect(resolved.source).toBe('installed');
    expect(resolved.expectAvailable).toBe(true);
  });

  it('HOME 缺失不得污染路径（回归：曾拼出 undefined/.git-ai/bin/git-ai）', () => {
    // Windows 只有 USERPROFILE：用 os.homedir() 时路径不含 undefined
    const home = join('C:\\Users', 'lolli');
    const resolved = resolveGitAiBin({
      env: { USERPROFILE: home },
      platform: 'win32',
      home,
      fileExists: alwaysExists
    });

    expect(resolved.bin).not.toContain('undefined');
    expect(resolved.bin).toContain('.git-ai');
  });

  it('PI_DESKTOP_GIT_AI_BIN 覆盖优先于安装目录，且视为「本应可用」', () => {
    expect(
      resolveGitAiBin({
        env: { PI_DESKTOP_GIT_AI_BIN: '  /opt/git-ai/bin/git-ai  ' },
        platform: 'darwin',
        home: HOME,
        fileExists: alwaysExists
      })
    ).toEqual({ bin: '/opt/git-ai/bin/git-ai', source: 'env', expectAvailable: true });
  });

  it('设置页路径（overridePath）优先于环境变量与安装目录', () => {
    expect(
      resolveGitAiBin({
        overridePath: '  /custom/git-ai  ',
        env: { PI_DESKTOP_GIT_AI_BIN: '/opt/git-ai/bin/git-ai' },
        platform: 'darwin',
        home: HOME,
        fileExists: alwaysExists
      })
    ).toEqual({ bin: '/custom/git-ai', source: 'config', expectAvailable: true });
  });

  it('设置页路径支持 ~ 写法；空白串等于未填写', () => {
    expect(
      resolveGitAiBin({
        overridePath: '~/.local/bin/git-ai',
        env: {},
        platform: 'darwin',
        home: HOME,
        fileExists: neverExists
      })
    ).toEqual({
      bin: join(homedir(), '.local/bin/git-ai'),
      source: 'config',
      expectAvailable: true
    });

    expect(
      resolveGitAiBin({
        overridePath: '   ',
        env: {},
        platform: 'darwin',
        home: HOME,
        fileExists: neverExists
      })
    ).toEqual({ bin: 'git-ai', source: 'path', expectAvailable: false });
  });
});

describe('resolveAbsolutePath', () => {
  it('展开 ~ 与 ~/xxx（SDK 的 edit/write 接受 ~ 写法）', () => {
    expect(resolveAbsolutePath('/proj', '~', 'darwin')).toBe(homedir());
    expect(resolveAbsolutePath('/proj', '~/notes.md', 'darwin')).toBe(join(homedir(), 'notes.md'));
  });

  it('win32 额外展开 ~\\xxx；POSIX 不展开（与 SDK normalizePath 一致）', () => {
    expect(resolveAbsolutePath('C:\\proj', '~\\notes.md', 'win32')).toBe(
      join(homedir(), 'notes.md')
    );
    expect(resolveAbsolutePath('/proj', '~\\notes.md', 'darwin')).toBe(
      join('/proj', '~\\notes.md')
    );
  });

  it('相对路径按 cwd 解析，绝对路径原样返回', () => {
    expect(resolveAbsolutePath('/proj', 'src/a.ts', 'darwin')).toBe(join('/proj', 'src/a.ts'));
    expect(resolveAbsolutePath('/proj', '/etc/hosts', 'darwin')).toBe('/etc/hosts');
  });
});

describe('expandUserPath', () => {
  it('只展开开头的 ~，不碰中间的 ~', () => {
    expect(expandUserPath('~/a/~/b', 'darwin')).toBe(join(homedir(), 'a/~/b'));
    expect(expandUserPath('a/~/b', 'darwin')).toBe('a/~/b');
  });
});
