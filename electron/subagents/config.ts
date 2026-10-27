/**
 * 子智能体配置：`~/.pi-desktop/subagents.json`
 *
 * 纯 node 依赖（fs/path/config-dir），可被 vitest 直接测试；测试用
 * `PI_SUBAGENT_CONFIG` 环境变量把文件路径重定向到临时文件。
 *
 * 与其它配置的分工：这里只放「子智能体」相关开关，不放 UI 偏好（走 ui-config.json），
 * 也不放 SDK 配置（走 settings.json）。工具可见性由 PiBridge 每次现读本文件
 * （见 `syncSubagentTools`），所以设置页改完即时生效，无需重启会话。
 *
 * 关闭语义：只是把 `task` 工具从活跃工具里移除（模型看不到、系统提示词也不列），
 * 子智能体面板 / 历史 run 的查看不受影响。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from '../config-dir';

export interface SubagentConfig {
  /** 总开关：关闭后不向 agent 注入 task 工具（模型无法再委派子任务） */
  enabled: boolean;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  /** 默认开启：与改造前的行为一致 */
  enabled: true
};

/** 配置文件路径（测试可经 PI_SUBAGENT_CONFIG 重定向到临时文件） */
export function getSubagentConfigPath(): string {
  return process.env.PI_SUBAGENT_CONFIG || path.join(DESKTOP_AGENT_DIR, 'subagents.json');
}

/** 容错归一化：字段缺失/类型不对一律回退默认值（不抛错） */
export function normalizeSubagentConfig(value: unknown): SubagentConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SUBAGENT_CONFIG.enabled
  };
}

/** 读取配置：文件缺失/损坏一律返回默认值 */
export function readSubagentConfig(): SubagentConfig {
  try {
    const raw = fs.readFileSync(getSubagentConfigPath(), 'utf-8');
    return normalizeSubagentConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SUBAGENT_CONFIG };
  }
}

/**
 * 写入配置（只接受已知字段的增量 patch），返回落盘后重新读出的结果。
 * 写临时文件再 rename，避免半截文件把配置读成默认值。
 */
export function writeSubagentConfig(patch: Partial<SubagentConfig>): SubagentConfig {
  const current = readSubagentConfig();
  const next = normalizeSubagentConfig({
    ...current,
    ...pick(patch, Object.keys(DEFAULT_SUBAGENT_CONFIG) as (keyof SubagentConfig)[])
  });
  const file = getSubagentConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return readSubagentConfig();
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
