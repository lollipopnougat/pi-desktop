/**
 * 网络搜索的类型定义（主进程 + 工具 + IPC + 渲染进程共用）。
 *
 * 设计前提：**全部搜索源都是免 Key 的**。pi-desktop 开箱即用，不要求用户
 * 注册任何账号；所以这里没有 apiKey 字段，provider 只是「用哪个免费源」。
 */

/** 可用的搜索源（全部免 Key、免登录） */
export type WebSearchProviderId = 'parallel-mcp' | 'bing' | 'brave' | 'so360' | 'searxng';

/** 配置里的选择：auto = 按固定顺序自动降级 */
export type WebSearchProviderSetting = 'auto' | WebSearchProviderId;

/** 时间范围过滤（各源支持程度不同，不支持的源忽略该参数） */
export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year';

/** 单条搜索结果 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 发布时间（仅部分源提供，如 Parallel） */
  publishedAt?: string | null;
}

/** 一次搜索请求（工具参数 / 设置页测试都走这里） */
export interface WebSearchRequest {
  query: string;
  /** 期望条数（会被配置的 maxResults 夹住） */
  count?: number;
  freshness?: WebSearchFreshness;
  /** 限定站点（拼成 site: 语法） */
  site?: string;
}

/** 单个源的一次尝试记录（用于「为什么降级」的可观测性） */
export interface ProviderAttempt {
  provider: WebSearchProviderId;
  ok: boolean;
  results: number;
  ms: number;
  error?: string;
}

/** 搜索最终结果 */
export interface WebSearchOutcome {
  /** 真正返回结果的那个源 */
  provider: WebSearchProviderId;
  /** 实际发出的查询串（可能已追加 site: 过滤） */
  query: string;
  results: WebSearchResult[];
  /** 依次尝试过的源（最后一个 ok=true 即 provider） */
  attempts: ProviderAttempt[];
  /** 是否命中进程内缓存 */
  cached: boolean;
}

/** 所有源都失败时抛出（携带每个源的失败原因，便于模型向用户解释） */
export class WebSearchError extends Error {
  readonly attempts: ProviderAttempt[];

  constructor(message: string, attempts: ProviderAttempt[]) {
    super(message);
    this.name = 'WebSearchError';
    this.attempts = attempts;
  }
}
