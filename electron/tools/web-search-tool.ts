/**
 * web_search 工具：内置的免 Key 网络搜索。
 *
 * 为什么自带一个而不是让用户配 API Key：搜索是 agent 最基础的能力之一，
 * 但 Tavily/Brave/Exa 全都要注册账号；pi-desktop 的做法是默认用免 Key 的免费源
 * （Parallel 免 Key MCP / Bing / Brave / 360 / 自建 SearXNG），开箱即可用，
 * 想更稳的用户可以在设置页填自己的 SearXNG 地址。
 *
 * 注入规则（PiBridge 管理，见 syncWebSearchTool）：
 * - 配置 `enabled === false` → 从活跃工具里移除（模型看不到这个工具）
 * - 否则注入
 * 每次 execute 都重新读配置，因此设置页改动无需重启。
 *
 * 失败处理：runWebSearch 会逐个源降级；全部失败时抛 WebSearchError，
 * 这里把它转成**正常工具结果**（而不是异常），让模型能向用户解释
 * "搜索源都被拦截了，可以换关键词或稍后再试"，而不是把整个回合打成 error。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readWebSearchConfig } from '../web-search/config';
import { runWebSearch } from '../web-search/search';
import { providerLabel } from '../web-search/providers';
import {
  WebSearchError,
  type ProviderAttempt,
  type WebSearchProviderId,
  type WebSearchRequest,
  type WebSearchResult
} from '../web-search/types';

/** 工具结果 details：渲染进程/日志可用（当前 UI 未单独渲染，保留可观测性） */
export interface WebSearchDetails {
  query: string;
  provider?: string;
  cached?: boolean;
  results: WebSearchResult[];
  attempts: ProviderAttempt[];
  error?: string;
}

const MAX_SNIPPET = 300;

function formatSuccess(
  query: string,
  provider: WebSearchProviderId,
  results: WebSearchResult[],
  cached: boolean,
  fallbacks: string[]
): string {
  const head = `搜索「${query}」：${results.length} 条结果（来源：${providerLabel(provider)}${cached ? '，缓存' : ''}）`;
  const lines = results.map((result, index) => {
    const snippet = result.snippet ? `\n   ${result.snippet.slice(0, MAX_SNIPPET)}` : '';
    return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
  });
  const fallbackNote = fallbacks.length ? `\n\n（自动降级：${fallbacks.join(' → ')}）` : '';
  return `${head}\n\n${lines.join('\n\n')}${fallbackNote}`;
}

/** 把「尝试过但失败的源」压成一行，便于模型/用户判断是不是全被拦了 */
function describeFallbacks(attempts: ProviderAttempt[]): string[] {
  return attempts
    .filter((attempt) => !attempt.ok)
    .map(
      (attempt) =>
        `${providerLabel(attempt.provider)}${attempt.error ? `（${attempt.error}）` : ''}`
    );
}

export const webSearchTool = defineTool({
  name: 'web_search',
  label: '网络搜索',
  description: `搜索互联网（内置免 Key 搜索源，无需任何配置）。
适用：需要最新信息、外部文档、库/版本细节、报错排查、事实核实时。
不适用：读某个已知 URL 的全文（直接用 read/fetch）、纯本地代码问题（用 grep/read）。
返回标题 + 链接 + 摘要；摘要通常够判断是否相关，需要细节时再读具体 URL。
若结果里出现 "自动降级"，说明首选源不可用，结果来自备用源，仍然可用。`,
  promptSnippet: '搜索互联网获取最新信息（免 Key，自动在多个免费搜索源间降级）',
  promptGuidelines: [
    '需要外部/最新事实时先 web_search，不要凭记忆回答版本号、API 细节、新闻类问题',
    'query 用关键词而不是整句问题；中文问题用中文关键词，英文资料用英文关键词',
    '同一个关键词不要重复搜索（结果有 5 分钟缓存）；换角度时改关键词而不是原样重试',
    '引用搜索结果时给出 URL；摘要不足时再读取具体链接',
    '搜索全部失败时如实告诉用户"搜索源被拦截"，不要编造结果'
  ],
  parameters: Type.Object({
    query: Type.String({
      description: '搜索关键词（2-6 个词最佳；不要写整句问题，不要加引号）'
    }),
    count: Type.Optional(Type.Number({ description: '返回条数，1-20，默认取设置页配置（8）' })),
    freshness: Type.Optional(
      Type.Union(
        [Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')],
        { description: '只要最近一天/一周/一月/一年的结果（部分源不支持则忽略）' }
      )
    ),
    site: Type.Optional(
      Type.String({ description: '只搜某个站点，如 github.com 或 docs.python.org' })
    )
  }),
  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const request = params as WebSearchRequest;
    const config = readWebSearchConfig();
    if (!config.enabled) {
      return {
        content: [{ type: 'text', text: '网络搜索已在设置页关闭（智能体配置 → 网络搜索）。' }],
        details: { query: request.query, results: [], attempts: [], error: 'disabled' }
      } satisfies AgentToolResult<WebSearchDetails>;
    }

    try {
      const outcome = await runWebSearch(request, { config, signal });
      const details: WebSearchDetails = {
        query: outcome.query,
        provider: outcome.provider,
        cached: outcome.cached,
        results: outcome.results,
        attempts: outcome.attempts
      };
      return {
        content: [
          {
            type: 'text',
            text: formatSuccess(
              outcome.query,
              outcome.provider,
              outcome.results,
              outcome.cached,
              describeFallbacks(outcome.attempts)
            )
          }
        ],
        details
      } satisfies AgentToolResult<WebSearchDetails>;
    } catch (error) {
      const attempts = error instanceof WebSearchError ? error.attempts : [];
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `搜索失败：${message}\n可以稍后重试、换关键词，或在设置页「智能体配置 → 网络搜索」里改用自建 SearXNG。`
          }
        ],
        details: {
          query: request.query,
          results: [],
          attempts,
          error: message
        }
      } satisfies AgentToolResult<WebSearchDetails>;
    }
  }
});
