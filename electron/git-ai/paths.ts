/**
 * git-ai 可执行文件路径解析（跨平台）。
 *
 * 家目录一律用 `os.homedir()`，**不要**用 `process.env.HOME`：Windows 默认不设
 * HOME（只设 USERPROFILE），且 HOME 只存在于 Git Bash 等终端环境，GUI 启动的
 * Electron 进程里恒为 undefined —— 用它拼路径会得到 `undefined/.git-ai/bin/git-ai`，
 * spawn 报 ENOENT 后被静默吞掉，表现为 git-ai 全平台静默失效但只在 Windows 暴露。
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

/** 生效路径的来源：设置页指定 / 环境变量 / 官方安装目录 / 系统 PATH */
export type GitAiBinSource = 'config' | 'env' | 'installed' | 'path';

/** git-ai 二进制的解析结果 */
export interface ResolvedGitAiBin {
  /** 传给 spawn 的可执行文件：绝对路径，或 PATH 上的命令名 */
  bin: string;
  /** 该路径来自哪一层（设置页据此展示「生效来源」） */
  source: GitAiBinSource;
  /**
   * 是否「本应可用」：前三层（设置页/环境变量/安装目录）都算明确指定或确实存在，
   * 只有 PATH 兜底为 false —— 表示这台机器没装 git-ai，执行失败保持静默。
   */
  expectAvailable: boolean;
}

/**
 * 官方安装脚本的落点：install.sh 与 install.ps1 都装到 `~/.git-ai/bin`，
 * Windows 下文件名为 `git-ai.exe`。
 */
export function installedGitAiPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  return join(home, '.git-ai', 'bin', platform === 'win32' ? 'git-ai.exe' : 'git-ai');
}

/** 展开 `~`、`~/xxx`、`~\xxx`（`~\` 只在 win32 展开，与 SDK 行为一致）；其余原样返回 */
export function expandUserPath(
  pathValue: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (pathValue === '~') return homedir();
  if (pathValue.startsWith('~/') || (platform === 'win32' && pathValue.startsWith('~\\'))) {
    return resolve(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

/**
 * 归一化为绝对路径：
 * - 展开 `~` 写法（SDK 的 edit/write 工具接受 `~`，见 SDK utils/paths 的 normalizePath；
 *   不展开的话上报的路径与工具真正落盘的位置不一致，git-ai 会认不出这个文件）
 * - 其余相对路径按工具调用的 cwd 解析
 */
export function resolveAbsolutePath(
  cwd: string,
  pathValue: string,
  platform: NodeJS.Platform = process.platform
): string {
  const expanded = expandUserPath(pathValue, platform);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * 解析 git-ai 二进制路径。优先级：
 * 1. 设置页填写的路径（`overridePath`）—— UI 里看得见的值优先，否则「填了不生效」最难排查
 * 2. `PI_DESKTOP_GIT_AI_BIN` 环境变量（原样使用，绝对路径 / PATH 命令名均可）
 * 3. 官方安装脚本的落点 `~/.git-ai/bin/git-ai(.exe)`
 * 4. 裸命令名 `git-ai`，交给系统 PATH 兜底（安装脚本 --env、包管理器安装）
 */
export function resolveGitAiBin(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    fileExists?: (path: string) => boolean;
    /** 设置页指定的路径（支持 `~` 写法） */
    overridePath?: string;
  } = {}
): ResolvedGitAiBin {
  const {
    env = process.env,
    platform = process.platform,
    home = homedir(),
    fileExists = existsSync,
    overridePath
  } = options;

  const fromConfig = overridePath?.trim();
  if (fromConfig) {
    return { bin: expandUserPath(fromConfig, platform), source: 'config', expectAvailable: true };
  }

  const fromEnv = env.PI_DESKTOP_GIT_AI_BIN?.trim();
  if (fromEnv) {
    return { bin: expandUserPath(fromEnv, platform), source: 'env', expectAvailable: true };
  }

  const installed = installedGitAiPath(platform, home);
  if (fileExists(installed)) {
    return { bin: installed, source: 'installed', expectAvailable: true };
  }

  return { bin: 'git-ai', source: 'path', expectAvailable: false };
}
