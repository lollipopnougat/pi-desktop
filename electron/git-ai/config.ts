/**
 * git-ai 集成配置：`~/.pi-desktop/git-ai.json`
 *
 * 纯 node 依赖（fs/path/config-dir），可被 vitest 直接测试；测试用
 * `PI_GIT_AI_CONFIG` 环境变量把文件路径重定向到临时目录。
 *
 * 与其它配置的分工：这里只放「git-ai 集成」相关开关，不放 UI 偏好
 * （那些走 ui-config.json），也不放 SDK 配置（走 settings.json）。
 * 内联扩展在每次事件处理时读一次本文件，因此设置页改动**即时生效**，无需重启。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from '../config-dir';

/** 上报范围：全部 / 仅文件改动 / 仅 shell 命令 */
export type GitAiScope = 'all' | 'files' | 'shell';

export interface GitAiConfig {
  /** 总开关：关闭后不再上报任何 checkpoint（不影响 agent 执行） */
  enabled: boolean;
  /** 二进制路径覆盖：空串 = 自动探测（环境变量 → 官方安装目录 → PATH），支持 `~` 写法 */
  binPath: string;
  /** 上报范围：文件改动（edit/write）与 shell 命令（bash）可分别关闭 */
  scope: GitAiScope;
}

export const DEFAULT_GIT_AI_CONFIG: GitAiConfig = {
  /** 默认开启：与改造前的行为一致（git-ai 缺失时自然静默跳过） */
  enabled: true,
  binPath: '',
  scope: 'all'
};

/** 配置文件路径（测试可经 PI_GIT_AI_CONFIG 重定向到临时文件） */
export function getGitAiConfigPath(): string {
  return process.env.PI_GIT_AI_CONFIG || path.join(DESKTOP_AGENT_DIR, 'git-ai.json');
}

/** 容错归一化：字段缺失/类型不对/越界一律回退默认值（不抛错） */
export function normalizeGitAiConfig(value: unknown): GitAiConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const scope = raw.scope;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_GIT_AI_CONFIG.enabled,
    binPath: typeof raw.binPath === 'string' ? raw.binPath.trim() : DEFAULT_GIT_AI_CONFIG.binPath,
    scope: scope === 'all' || scope === 'files' || scope === 'shell' ? scope : 'all'
  };
}

/** 读取配置：文件缺失/损坏一律返回默认值 */
export function readGitAiConfig(): GitAiConfig {
  try {
    const raw = fs.readFileSync(getGitAiConfigPath(), 'utf-8');
    return normalizeGitAiConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GIT_AI_CONFIG };
  }
}

/**
 * 写入配置（只接受已知字段的增量 patch），返回落盘后重新读出的结果。
 * 写临时文件再 rename，避免半截文件把配置读成默认值。
 */
export function writeGitAiConfig(patch: Partial<GitAiConfig>): GitAiConfig {
  const current = readGitAiConfig();
  const next: GitAiConfig = normalizeGitAiConfig({
    ...current,
    ...pick(patch, Object.keys(DEFAULT_GIT_AI_CONFIG) as (keyof GitAiConfig)[])
  });
  const file = getGitAiConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return readGitAiConfig();
}

function pick<T extends object>(
  obj: Record<string, unknown>,
  keys: readonly (keyof T)[]
): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (obj[k as string] !== undefined)
      (out as Record<string, unknown>)[k as string] = obj[k as string];
  }
  return out;
}
