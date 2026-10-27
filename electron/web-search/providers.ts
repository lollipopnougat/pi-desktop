/**
 * 免 Key 搜索源实现（全部无需注册/登录/API Key）。
 *
 * 分两类：
 * 1. **结构化 JSON**：Parallel 的免 Key MCP（`mcp.parallel.ai/mcp`）、自建 SearXNG 的
 *    `format=json`。解析稳定，优先使用。
 * 2. **网页 HTML 抓取**：Bing / Brave / 360。这类源没有官方免费 API，只能抓结果页，
 *    因此解析器写成「分块 + 取链接/标题/摘要」，并对结构变化保持宽容（解析不到就
 *    返回空数组，由上层降级到下一个源，绝不抛解析异常）。
 *
 * 已知**不可用**的源（2026-10 实测，别再往里加）：
 * - DuckDuckGo html/lite：返回 202 + anomaly-modal，纯 HTTP 需要 vqd + JS 挑战
 * - Mojeek：返回验证码页
 * - Google：结果页纯 JS 渲染，HTML 里没有结果
 * - SearXNG 公共实例：全部关闭 `format=json`，且普遍超时/反爬（只有自建可用）
 * - Ecosia / Startpage / Yahoo / Sogou：403 / 超时 / 500 / 反爬
 * - Firecrawl keyless、Exa 免 Key MCP：共享 IP 额度，经常 429
 *
 * 抓取网页结果页在多数站点的 ToS 里是不允许的，这里只在「用户自己的桌面客户端、
 * 低频、给 agent 补充事实」的场景使用；要产品化请换成官方 API。
 */
import {
  decodeBingRedirect,
  decodeEntities,
  fetchOk,
  firstGroup,
  stripTags,
  truncate
} from './http';
import type { WebSearchFreshness, WebSearchProviderId, WebSearchResult } from './types';

/** 单次搜索的上下文（由 search.ts 组装） */
export interface ProviderContext {
  query: string;
  count: number;
  freshness?: WebSearchFreshness;
  timeoutMs: number;
  searxngBaseUrl: string;
  signal?: AbortSignal;
}

export interface SearchProvider {
  id: WebSearchProviderId;
  label: string;
  search(ctx: ProviderContext): Promise<WebSearchResult[]>;
}

/** auto 模式的降级顺序：结构化优先，中文场景兜底 360 */
export const AUTO_CHAIN: WebSearchProviderId[] = [
  'parallel-mcp',
  'bing',
  'brave',
  'so360',
  'searxng'
];

/** 摘要最长字符数（超长摘要会挤占模型上下文） */
const SNIPPET_MAX = 320;

// ---------------------------------------------------------------- 解析器

/**
 * Bing 结果页：`<li class="b_algo">` 分块，块内 `<h2><a href>` + 第一个 `<p>`。
 * 注意结果页是压缩过的单行 HTML，不能用行数判断条数。
 */
export function parseBing(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = decodeBingRedirect(decodeEntities(anchor[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(anchor[2]);
    if (!title) continue;
    out.push({
      title,
      url,
      snippet: truncate(stripTags(firstGroup(block, /<p[^>]*>([\s\S]*?)<\/p>/i)), SNIPPET_MAX)
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Brave 结果页：`<div class="snippet ..." data-type="web">` 分块，
 * 块内锚点包住 `<div class="title ..." title="...">`，摘要取 `<div class="content ...">`。
 */
export function parseBrave(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const blocks = html
    .split(/<div class="snippet\s/i)
    .slice(1)
    .filter((block) => /data-type="web"/i.test(block.slice(0, 240)));
  for (const block of blocks) {
    // 锚点必须包住标题节点（页面里还有 favicon/站点名等无关锚点）
    const anchor =
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<div class="title/i.exec(block);
    if (!anchor) continue;
    const titleAttr = firstGroup(block, /<div class="title[^"]*"[^>]*title="([^"]*)"/i);
    const titleText =
      titleAttr || stripTags(firstGroup(block, /<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i));
    const title = stripTags(titleText);
    if (!title) continue;
    out.push({
      title,
      url: decodeEntities(anchor[1]),
      snippet: truncate(
        stripTags(firstGroup(block, /<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)),
        SNIPPET_MAX
      )
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 360 搜索：`<li class="res-list">` 分块，真实链接在 `data-mdurl`（href 是跳转包装），
 * 摘要取 `data-result-summary` 或 `<p class="res-desc">`。
 * 前几块是「其他人还搜了」等聚合卡，没有 data-mdurl，直接跳过。
 */
export function parseSo360(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const blocks = html.split(/<li class="res-list"/i).slice(1);
  for (const block of blocks) {
    const url = firstGroup(block, /data-mdurl="([^"]+)"/i);
    if (!url) continue;
    const title = stripTags(firstGroup(block, /data-mdurl="[^"]*"[^>]*>([\s\S]*?)<\/a>/i));
    if (!title) continue;
    const snippet =
      firstGroup(block, /data-result-summary[^>]*>([\s\S]*?)<\/span>/i) ||
      firstGroup(block, /<p class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({
      title,
      url: decodeEntities(url),
      snippet: truncate(stripTags(snippet), SNIPPET_MAX)
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** SearXNG 的 `format=json` 响应 */
export function parseSearxng(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult[] = [];
  for (const item of results) {
    const row = item as {
      title?: unknown;
      url?: unknown;
      content?: unknown;
      publishedDate?: unknown;
    };
    const url = typeof row.url === 'string' ? row.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: typeof row.title === 'string' && row.title ? row.title : url,
      url,
      snippet: truncate(typeof row.content === 'string' ? row.content : '', SNIPPET_MAX),
      publishedAt: typeof row.publishedDate === 'string' ? row.publishedDate : null
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parallel 免 Key MCP 的响应：JSON-RPC（可能是 SSE 的 `data: {...}` 流）。
 * 结果藏在 `result.content[0].text` 里的 JSON 字符串（`results[].excerpts`）。
 */
export function parseParallelMcp(body: string, limit: number): WebSearchResult[] {
  const payload = extractJsonRpcPayload(body);
  if (!payload) return [];
  const error = (payload as { error?: { message?: string } }).error;
  if (error) throw new Error(`Parallel MCP 返回错误：${error.message || '未知错误'}`);
  const content = (payload as { result?: { content?: Array<{ text?: unknown }> } }).result?.content;
  const text =
    Array.isArray(content) && typeof content[0]?.text === 'string' ? content[0].text : '';
  if (!text) return [];

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (data as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult[] = [];
  for (const item of results) {
    const row = item as {
      url?: unknown;
      title?: unknown;
      excerpts?: unknown;
      publish_date?: unknown;
    };
    const url = typeof row.url === 'string' ? row.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const excerpts = Array.isArray(row.excerpts)
      ? row.excerpts.filter((e): e is string => typeof e === 'string')
      : [];
    out.push({
      title: typeof row.title === 'string' && row.title ? row.title : url,
      url,
      snippet: truncate(excerpts.slice(0, 2).join(' … '), SNIPPET_MAX),
      publishedAt: typeof row.publish_date === 'string' ? row.publish_date : null
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 从 JSON 或 SSE 响应体里取出 JSON-RPC 载荷（取最后一个可解析的 data 行） */
export function extractJsonRpcPayload(body: string): unknown | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const lines = body.split(/\r?\n/);
  let last: unknown | null = null;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (!json.startsWith('{')) continue;
    try {
      last = JSON.parse(json);
    } catch {
      // 跳过解析不了的行（心跳/注释）
    }
  }
  return last;
}

// ---------------------------------------------------------------- 搜索源

const FRESHNESS_DAYS: Record<WebSearchFreshness, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365
};

const BRAVE_FRESHNESS: Record<WebSearchFreshness, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py'
};

/** Parallel 免 Key MCP：返回带 excerpt 的结构化结果，质量最好 */
const parallelProvider: SearchProvider = {
  id: 'parallel-mcp',
  label: 'Parallel MCP',
  async search(ctx) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search',
        arguments: { objective: ctx.query, search_queries: [ctx.query] }
      }
    });
    const text = await fetchOk('https://mcp.parallel.ai/mcp', {
      timeoutMs: ctx.timeoutMs,
      method: 'POST',
      body,
      signal: ctx.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      }
    });
    return parseParallelMcp(text, ctx.count);
  }
};

const bingProvider: SearchProvider = {
  id: 'bing',
  label: 'Bing',
  async search(ctx) {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', ctx.query);
    url.searchParams.set('count', String(Math.min(50, Math.max(10, ctx.count))));
    if (ctx.freshness) {
      // Bing 的时效过滤是 qft=+filterui:age-lt<分钟>
      url.searchParams.set('qft', `+filterui:age-lt${FRESHNESS_DAYS[ctx.freshness] * 24 * 60}`);
    }
    const html = await fetchOk(url.toString(), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    return parseBing(html, ctx.count);
  }
};

const braveProvider: SearchProvider = {
  id: 'brave',
  label: 'Brave',
  async search(ctx) {
    const url = new URL('https://search.brave.com/search');
    url.searchParams.set('q', ctx.query);
    url.searchParams.set('source', 'web');
    if (ctx.freshness) url.searchParams.set('tf', BRAVE_FRESHNESS[ctx.freshness]);
    const html = await fetchOk(url.toString(), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    return parseBrave(html, ctx.count);
  }
};

const so360Provider: SearchProvider = {
  id: 'so360',
  label: '360 搜索',
  async search(ctx) {
    const url = new URL('https://www.so.com/s');
    url.searchParams.set('q', ctx.query);
    const html = await fetchOk(url.toString(), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    return parseSo360(html, ctx.count);
  }
};

const searxngProvider: SearchProvider = {
  id: 'searxng',
  label: 'SearXNG',
  async search(ctx) {
    const base = ctx.searxngBaseUrl.replace(/\/+$/, '');
    if (!base) throw new Error('未配置 SearXNG 地址（设置页「网络搜索」里填写）');
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', ctx.query);
    url.searchParams.set('format', 'json');
    if (ctx.freshness) url.searchParams.set('time_range', ctx.freshness);
    const text = await fetchOk(url.toString(), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('SearXNG 返回的不是 JSON：请确认实例配置里开启了 json 输出格式');
    }
    return parseSearxng(payload, ctx.count);
  }
};

export const PROVIDERS: Record<WebSearchProviderId, SearchProvider> = {
  'parallel-mcp': parallelProvider,
  bing: bingProvider,
  brave: braveProvider,
  so360: so360Provider,
  searxng: searxngProvider
};

/** provider id → 展示名（设置页/工具结果/日志共用） */
export function providerLabel(id: WebSearchProviderId): string {
  return PROVIDERS[id]?.label ?? id;
}
