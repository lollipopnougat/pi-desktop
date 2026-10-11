/**
 * git-ai 二进制探测：设置页「检测结果」行的数据来源。
 *
 * 只做只读探测（resolve + `--version`），不写任何配置；
 * 版本探测超时/失败只返回 null，不影响 UI。
 */
import { spawn } from 'child_process';
import { readGitAiConfig, getGitAiConfigPath } from './config';
import {
  installedGitAiPath,
  resolveGitAiBin,
  type GitAiBinSource,
  type ResolvedGitAiBin
} from './paths';

/** 版本探测超时（ms）：git-ai --version 毫秒级返回，3s 兜底 */
const VERSION_TIMEOUT_MS = 3000;

export interface GitAiStatus {
  /** 当前生效的可执行文件 */
  bin: string;
  /** 生效路径来源 */
  source: GitAiBinSource;
  /** 忽略设置页路径后的自动探测结果（用于提示「留空会走哪个」） */
  autoBin: string;
  autoSource: GitAiBinSource;
  /** 官方安装落点（固定值，仅用于提示） */
  installedPath: string;
  /** `PI_DESKTOP_GIT_AI_BIN` 环境变量的值（未设置则 null） */
  envValue: string | null;
  /** `--version` 解析出的版本号（拿不到则 null） */
  version: string | null;
  /** 配置文件路径 */
  configPath: string;
}

/** 探测当前生效的二进制（含版本）；渲染进程在设置页打开/保存后调用 */
export async function detectGitAi(): Promise<GitAiStatus> {
  const config = readGitAiConfig();
  const effective = resolveGitAiBin({ overridePath: config.binPath });
  const auto = resolveGitAiBin({});
  return {
    bin: effective.bin,
    source: effective.source,
    autoBin: auto.bin,
    autoSource: auto.source,
    installedPath: installedGitAiPath(),
    envValue: process.env.PI_DESKTOP_GIT_AI_BIN?.trim() || null,
    version: await readVersion(effective),
    configPath: getGitAiConfigPath()
  };
}

/** 跑一次 `--version`；任何失败（不存在/无权限/超时）都返回 null */
function readVersion(target: ResolvedGitAiBin): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(target.bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Windows 上 GUI 进程 spawn 控制台程序会弹控制台窗口，必须隐藏
        windowsHide: true
      });
    } catch {
      resolvePromise(null);
      return;
    }

    let output = '';
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      done(null);
    }, VERSION_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => done(null));
    child.on('close', () => done(parseVersion(output)));
  });
}

/** `git-ai --version` 输出形如 `1.7.5`；只认 semver，认不出就当未知（不把 --version 之类的原文当版本号显示） */
export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output);
  return match ? match[1] : null;
}
