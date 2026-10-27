/**
 * 搜索编排：选源 → 逐个尝试 → 失败自动降级 → 进程内缓存。
 *
 * 三条硬约定：
 * 1. **每次调用都读配置**（readWebSearchConfig），所以设置页改动即时生效，无需重启；
 *    调用方也可以传 config 覆盖（设置页「测试搜索」用当前表单值）。
 * 2. **空结果算失败**：抓 HTML 的源在「被拦截 / 结构变化」时不会报错，只会解析出 0 条，
 *    必须当作失败继续降级，否则会拿一份空结果骗模型说"没搜到"。
 * 3. **缓存只缓存成功结果**，按 query+count+时效 分键，默认 5 分钟（同一轮里模型
 *    常把同一个查询发两次）。
 */
import { readWebSearchConfig, type WebSearchConfig } from './config';
import { collapseWhitespace } from './http';
import { AUTO_CHAIN, PROVIDERS, providerLabel, type ProviderContext } from './providers';
import {
  WebSearchError,
  type ProviderAttempt,
  type WebSearchOutcome,
  type WebSearchProviderId,
  type WebSearchRequest
} from './types';

export interface RunWebSearchOptions {
  /** 覆盖配置（设置页测试用），不传则读磁盘 */
  config?: WebSearchConfig;
  signal?: AbortSignal;
  /** 默认 true；设置页测试用 false 以便每次真的打网络 */
  useCache?: boolean;
}

interface CacheEntry {
  at: number;
  outcome: WebSearchOutcome;
}

const CACHE_LIMIT = 100;
/** 整条降级链的总时长预算：单个源挂住时不让工具调用等满 N × timeout */
const TOTAL_BUDGET_MS = 30000;
const cache = new Map<string, CacheEntry>();

/** 清空缓存（测试用） */
export function clearWebSearchCache(): void {
  cache.clear();
}

/** 把请求规整成最终查询串：去多余空白 + 追加 site: 过滤 */
export function buildQuery(request: WebSearchRequest): string {
  const query = collapseWhitespace(request.query ?? '');
  const site = typeof request.site === 'string' ? request.site.trim() : '';
  if (!site) return query;
  if (/\bsite:/i.test(query)) return query;
  const host = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '');
  return host ? `${query} site:${host}` : query;
}

/** 按配置解析出要依次尝试的源列表 */
export function resolveChain(config: WebSearchConfig): WebSearchProviderId[] {
  if (config.provider !== 'auto') return [config.provider];
  // SearXNG 只有配置了地址才参与 auto 链（否则每次都会先报一次「未配置」）
  return AUTO_CHAIN.filter((id) => id !== 'searxng' || !!config.searxngBaseUrl);
}

function cacheKey(
  chain: WebSearchProviderId[],
  query: string,
  count: number,
  freshness: string | undefined
): string {
  return `${chain.join(',')}|${count}|${freshness ?? ''}|${query}`;
}

function remember(key: string, outcome: WebSearchOutcome, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  cache.set(key, { at: Date.now(), outcome });
  // 简单的 LRU 上限：超了就删最早插入的一条
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function readCache(key: string, ttlSeconds: number): WebSearchOutcome | null {
  if (ttlSeconds <= 0) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlSeconds * 1000) {
    cache.delete(key);
    return null;
  }
  return { ...hit.outcome, cached: true };
}

/** 单个源的失败原因压缩成一行（模型读得懂，也不会太长） */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return collapseWhitespace(message).slice(0, 200) || '未知错误';
}

/**
 * 执行一次搜索。全部源失败时抛 WebSearchError（带每个源的失败原因）。
 * 成功时返回第一个有结果的源。
 */
export async function runWebSearch(
  request: WebSearchRequest,
  options: RunWebSearchOptions = {}
): Promise<WebSearchOutcome> {
  const config = options.config ?? readWebSearchConfig();
  const query = buildQuery(request);
  if (!query) throw new WebSearchError('搜索关键词为空', []);

  const requested =
    typeof request.count === 'number' ? Math.round(request.count) : config.maxResults;
  const count = Math.min(20, Math.max(1, Math.min(requested, config.maxResults)));
  const freshness = request.freshness;
  const chain = resolveChain(config);
  const useCache = options.useCache !== false;
  const key = cacheKey(chain, query, count, freshness);

  if (useCache) {
    const hit = readCache(key, config.cacheTtlSeconds);
    if (hit) return hit;
  }

  const attempts: ProviderAttempt[] = [];
  const startedAt = Date.now();
  for (const id of chain) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > TOTAL_BUDGET_MS) {
      // 前面的源把总预算耗光了：剩下的直接记一笔跳过，避免工具调用卡住一分钟
      attempts.push({
        provider: id,
        ok: false,
        results: 0,
        ms: 0,
        error: `总时长超过 ${Math.round(TOTAL_BUDGET_MS / 1000)}s，跳过`
      });
      continue;
    }
    const started = Date.now();
    const ctx: ProviderContext = {
      query,
      count,
      freshness,
      // 每个源只能用到剩余预算
      timeoutMs: Math.max(1000, Math.min(config.timeoutMs, TOTAL_BUDGET_MS - elapsed)),
      searxngBaseUrl: config.searxngBaseUrl,
      signal: options.signal
    };
    try {
      const results = await PROVIDERS[id].search(ctx);
      const ms = Date.now() - started;
      if (results.length === 0) {
        attempts.push({
          provider: id,
          ok: false,
          results: 0,
          ms,
          error: '未解析到结果（可能被拦截或页面结构变化）'
        });
        continue;
      }
      attempts.push({ provider: id, ok: true, results: results.length, ms });
      const outcome: WebSearchOutcome = {
        provider: id,
        query,
        results,
        attempts,
        cached: false
      };
      if (useCache) remember(key, outcome, config.cacheTtlSeconds);
      return outcome;
    } catch (error) {
      attempts.push({
        provider: id,
        ok: false,
        results: 0,
        ms: Date.now() - started,
        error: errorText(error)
      });
    }
  }

  const detail = attempts.map((a) => `${providerLabel(a.provider)}：${a.error}`).join('；');
  throw new WebSearchError(
    attempts.length ? `所有搜索源都失败。${detail}` : '没有可用的搜索源',
    attempts
  );
}
