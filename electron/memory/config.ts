/**
 * 记忆系统配置：~/.pi-desktop/memory/config.json
 *
 * 纯 node 依赖（fs/path/config-dir），可被 vitest 直接测试。
 * 记忆目录结构：
 *   ~/.pi-desktop/memory/
 *   ├── USER.md              # 用户画像（全量注入）
 *   ├── MEMORY.md            # 全局笔记（检索）
 *   ├── LESSONS.md           # 教训条目（检索）
 *   ├── STANDING.md          # 用户钉选常驻指令（全量注入，管道不可写）
 *   ├── projects/<projectId>/MEMORY.md
 *   ├── extractions/<uuid>.md
 *   ├── config.json
 *   └── state.json
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { DESKTOP_AGENT_DIR } from '../config-dir';

/** 记忆根目录（测试可经 PI_MEMORY_DIR 环境变量重定向） */
export function getMemoryDir(): string {
  return process.env.PI_MEMORY_DIR || path.join(DESKTOP_AGENT_DIR, 'memory');
}

/** 提取模型引用（null 表示跟随当前会话模型） */
export interface MemoryModelRef {
  provider: string;
  modelId: string;
}

export interface MemoryConfig {
  /** 记忆系统总开关（关闭时不注入、不注册工具） */
  enabled: boolean;
  /** 提取/合并模型；null 跟随当前会话模型 */
  extractModel: MemoryModelRef | null;
  /** 未合并 extraction 数达到阈值时提示合并 */
  consolidateThreshold: number;
  /** 注入快照的字符预算（USER.md 截断保护） */
  userProfileCharLimit: number;
  /** 保留已有工具写入授权；可切换为候选审核或仅显式记住 */
  writePolicy: 'automatic' | 'review' | 'explicit';
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  extractModel: null,
  consolidateThreshold: 5,
  userProfileCharLimit: 4000,
  writePolicy: 'automatic'
};

const CONFIG_FILE = 'config.json';

export function readMemoryConfig(): MemoryConfig {
  try {
    const raw = fs.readFileSync(path.join(getMemoryDir(), CONFIG_FILE), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_MEMORY_CONFIG };
    return {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      consolidateThreshold: boundedNumber(parsed.consolidateThreshold, 5, 1, 100),
      userProfileCharLimit: boundedNumber(parsed.userProfileCharLimit, 4000, 200, 12000),
      writePolicy: ['automatic', 'review', 'explicit'].includes(parsed.writePolicy)
        ? parsed.writePolicy
        : 'automatic',
      extractModel:
        parsed.extractModel &&
        typeof parsed.extractModel === 'object' &&
        typeof parsed.extractModel.provider === 'string' &&
        typeof parsed.extractModel.modelId === 'string'
          ? { provider: parsed.extractModel.provider, modelId: parsed.extractModel.modelId }
          : null
    };
  } catch {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
}

export function writeMemoryConfig(patch: Partial<MemoryConfig>): MemoryConfig {
  const current = readMemoryConfig();
  const next: MemoryConfig = {
    ...current,
    ...pick(patch, Object.keys(DEFAULT_MEMORY_CONFIG) as (keyof MemoryConfig)[])
  };
  const dir = getMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, CONFIG_FILE);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, full);
  return readMemoryConfig();
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

export interface MemoryProject {
  id: string;
  name: string;
  root: string;
}
/** realpath 统一符号链接；不同 worktree 保持隔离，不依据 basename 合并。 */
export function projectIdentity(cwd: string): MemoryProject {
  let root = path.resolve(cwd || '.');
  try {
    root = fs.realpathSync.native(root);
  } catch {
    /* 未落盘的项目仍以绝对路径标识 */
  }
  if (process.platform === 'win32') root = root.toLowerCase();
  return {
    id: `p-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
    name: path.basename(root) || 'default',
    root
  };
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

/** 记忆文件清单（UI 展示 + 注入/检索共用） */
export const MEMORY_FILES = ['USER.md', 'MEMORY.md', 'LESSONS.md', 'STANDING.md'] as const;
export type MemoryFileId = (typeof MEMORY_FILES)[number] | 'project';

export function memoryFilePath(id: MemoryFileId, projectName?: string): string {
  if (id === 'project') {
    const safe = sanitizeProjectName(projectName || 'default');
    return path.join(getMemoryDir(), 'projects', safe, 'MEMORY.md');
  }
  if (!MEMORY_FILES.includes(id)) throw new Error('无效的记忆文件');
  return path.join(getMemoryDir(), id);
}

/** 项目名转文件系统安全目录名 */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return !cleaned || /^\.+$/.test(cleaned) ? 'default' : cleaned;
}
