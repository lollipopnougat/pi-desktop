/**
 * 网络搜索配置：`~/.pi-desktop/web-search.json`
 *
 * 纯 node 依赖（fs/path/config-dir），可被 vitest 直接测试；测试用
 * `PI_WEB_SEARCH_CONFIG` 环境变量把文件路径重定向到临时目录。
 *
 * 与其它配置的分工：这里只放「内置网络搜索工具」相关开关，不放 UI 偏好
 * （走 ui-config.json），也不放 SDK 配置（走 settings.json）。
 * 工具每次 execute 前读一次本文件，因此设置页改动**即时生效**，无需重启。
 *
 * 默认值刻意是「开箱即用」：enabled=true + provider='auto' + 免 Key 源，
 * 用户装完就能让 agent 搜网，不需要任何配置。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from '../config-dir';
import type { WebSearchProviderSetting } from './types';

export interface WebSearchConfig {
  /** 总开关：关闭后不向 agent 注入 web_search 工具 */
  enabled: boolean;
  /** 搜索源：auto = 按内置顺序自动降级 */
  provider: WebSearchProviderSetting;
  /** 自建 SearXNG 地址（空串 = 不使用；auto 链里配置了才会尝试） */
  searxngBaseUrl: string;
  /** 每次返回给模型的条数上限 */
  maxResults: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 进程内结果缓存 TTL（秒），0 = 不缓存 */
  cacheTtlSeconds: number;
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  enabled: true,
  provider: 'auto',
  searxngBaseUrl: '',
  maxResults: 8,
  timeoutMs: 15000,
  cacheTtlSeconds: 300
};

/** 允许的 provider 取值（含 auto） */
export const WEB_SEARCH_PROVIDERS: WebSearchProviderSetting[] = [
  'auto',
  'parallel-mcp',
  'bing',
  'brave',
  'so360',
  'searxng'
];

export const MAX_RESULTS_MIN = 1;
export const MAX_RESULTS_MAX = 20;
export const TIMEOUT_MIN = 3000;
export const TIMEOUT_MAX = 60000;
export const CACHE_TTL_MAX = 3600;

/** 配置文件路径（测试可经 PI_WEB_SEARCH_CONFIG 重定向到临时文件） */
export function getWebSearchConfigPath(): string {
  return process.env.PI_WEB_SEARCH_CONFIG || path.join(DESKTOP_AGENT_DIR, 'web-search.json');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 容错归一化：字段缺失/类型不对/越界一律回退默认值（不抛错） */
export function normalizeWebSearchConfig(value: unknown): WebSearchConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const provider = raw.provider;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_WEB_SEARCH_CONFIG.enabled,
    provider:
      typeof provider === 'string' && (WEB_SEARCH_PROVIDERS as string[]).includes(provider)
        ? (provider as WebSearchProviderSetting)
        : DEFAULT_WEB_SEARCH_CONFIG.provider,
    searxngBaseUrl: normalizeBaseUrl(raw.searxngBaseUrl),
    maxResults: clampInt(
      raw.maxResults,
      DEFAULT_WEB_SEARCH_CONFIG.maxResults,
      MAX_RESULTS_MIN,
      MAX_RESULTS_MAX
    ),
    timeoutMs: clampInt(
      raw.timeoutMs,
      DEFAULT_WEB_SEARCH_CONFIG.timeoutMs,
      TIMEOUT_MIN,
      TIMEOUT_MAX
    ),
    cacheTtlSeconds: clampInt(
      raw.cacheTtlSeconds,
      DEFAULT_WEB_SEARCH_CONFIG.cacheTtlSeconds,
      0,
      CACHE_TTL_MAX
    )
  };
}

/** SearXNG 地址归一化：去空白与结尾斜杠，非 http(s) 一律视为未配置 */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

/** 读取配置：文件缺失/损坏一律返回默认值 */
export function readWebSearchConfig(): WebSearchConfig {
  try {
    const raw = fs.readFileSync(getWebSearchConfigPath(), 'utf-8');
    return normalizeWebSearchConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WEB_SEARCH_CONFIG };
  }
}

/**
 * 写入配置（只接受已知字段的增量 patch），返回落盘后重新读出的结果。
 * 写临时文件再 rename，避免半截文件把配置读成默认值。
 */
export function writeWebSearchConfig(patch: Partial<WebSearchConfig>): WebSearchConfig {
  const current = readWebSearchConfig();
  const next = normalizeWebSearchConfig({
    ...current,
    ...pick(patch, Object.keys(DEFAULT_WEB_SEARCH_CONFIG) as (keyof WebSearchConfig)[])
  });
  const file = getWebSearchConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return readWebSearchConfig();
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
