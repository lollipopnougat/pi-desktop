/**
 * 搜索编排单测：选源顺序 / 失败降级 / 缓存。
 *
 * 全部用 stub 掉的 global fetch，不联网（CI 里也不该打真实搜索页）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WEB_SEARCH_CONFIG, type WebSearchConfig } from '../../electron/web-search/config';
import {
  buildQuery,
  clearWebSearchCache,
  resolveChain,
  runWebSearch
} from '../../electron/web-search/search';
import { WebSearchError } from '../../electron/web-search/types';

const BING_HTML = `<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">Example A</a></h2><p>Snippet A</p></li></ol>`;

function config(patch: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return { ...DEFAULT_WEB_SEARCH_CONFIG, ...patch };
}

interface StubResponse {
  status: number;
  body: string;
}

/** 按 URL 关键字返回不同响应；返回调用计数便于断言缓存 */
function stubFetch(handler: (url: string) => StubResponse) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const { status, body } = handler(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  clearWebSearchCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildQuery', () => {
  it('折叠空白', () => {
    expect(buildQuery({ query: '  pi   agent  ' })).toBe('pi agent');
  });

  it('追加 site: 过滤（去掉协议与路径）', () => {
    expect(buildQuery({ query: 'hooks', site: 'https://github.com/foo/bar' })).toBe(
      'hooks site:github.com'
    );
  });

  it('查询里已有 site: 时不重复追加', () => {
    expect(buildQuery({ query: 'hooks site:github.com', site: 'npmjs.com' })).toBe(
      'hooks site:github.com'
    );
  });
});

describe('resolveChain', () => {
  it('auto 模式按内置顺序，未配置 SearXNG 时跳过它', () => {
    expect(resolveChain(config())).toEqual(['parallel-mcp', 'bing', 'brave', 'so360']);
  });

  it('配置了 SearXNG 地址才把它加进 auto 链', () => {
    expect(resolveChain(config({ searxngBaseUrl: 'http://localhost:8080' }))).toEqual([
      'parallel-mcp',
      'bing',
      'brave',
      'so360',
      'searxng'
    ]);
  });

  it('指定源时只试它', () => {
    expect(resolveChain(config({ provider: 'brave' }))).toEqual(['brave']);
  });
});

describe('runWebSearch', () => {
  it('首选源失败时自动降级到下一个源', async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes('mcp.parallel.ai')) return { status: 500, body: 'boom' };
      if (url.includes('bing.com/search')) return { status: 200, body: BING_HTML };
      return { status: 500, body: 'unexpected' };
    });

    const outcome = await runWebSearch({ query: 'pi agent' }, { config: config() });
    expect(outcome.provider).toBe('bing');
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].url).toBe('https://example.com/a');
    expect(outcome.cached).toBe(false);
    // 第一次尝试失败也要留痕（设置页/工具用它解释降级）
    expect(outcome.attempts[0]).toMatchObject({ provider: 'parallel-mcp', ok: false });
    expect(outcome.attempts[1]).toMatchObject({ provider: 'bing', ok: true, results: 1 });
    expect(calls.some((url) => url.includes('bing.com/search'))).toBe(true);
  });

  it('空结果也算失败，继续降级（抓 HTML 的源不会报错）', async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes('mcp.parallel.ai')) {
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', result: { content: [] } }) };
      }
      if (url.includes('bing.com/search')) return { status: 200, body: '<html>验证码</html>' };
      if (url.includes('search.brave.com')) return { status: 200, body: BING_HTML };
      return { status: 500, body: 'nope' };
    });

    // Brave 的解析器认不出 Bing 的 HTML → 继续降级到 360
    await expect(runWebSearch({ query: 'x' }, { config: config() })).rejects.toBeInstanceOf(
      WebSearchError
    );
    expect(calls.some((url) => url.includes('so.com/s'))).toBe(true);
  });

  it('同一查询命中缓存（5 分钟内不重复打网络）', async () => {
    const { calls } = stubFetch(() => ({ status: 200, body: BING_HTML }));
    const cfg = config({ provider: 'bing' });

    const first = await runWebSearch({ query: 'cached query' }, { config: cfg });
    const second = await runWebSearch({ query: 'cached query' }, { config: cfg });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(calls).toHaveLength(1);
  });

  it('cacheTtlSeconds=0 时不缓存', async () => {
    const { calls } = stubFetch(() => ({ status: 200, body: BING_HTML }));
    const cfg = config({ provider: 'bing', cacheTtlSeconds: 0 });

    await runWebSearch({ query: 'no cache' }, { config: cfg });
    await runWebSearch({ query: 'no cache' }, { config: cfg });
    expect(calls).toHaveLength(2);
  });

  it('useCache=false 时强制打网络（设置页测试用）', async () => {
    const { calls } = stubFetch(() => ({ status: 200, body: BING_HTML }));
    const cfg = config({ provider: 'bing' });

    await runWebSearch({ query: 'force' }, { config: cfg });
    await runWebSearch({ query: 'force' }, { config: cfg, useCache: false });
    expect(calls).toHaveLength(2);
  });

  it('全部失败时抛 WebSearchError 并带每个源的原因', async () => {
    stubFetch(() => ({ status: 503, body: 'blocked' }));
    try {
      await runWebSearch({ query: 'all fail' }, { config: config() });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WebSearchError);
      const failure = error as WebSearchError;
      expect(failure.attempts).toHaveLength(4);
      expect(failure.attempts.every((a) => !a.ok)).toBe(true);
      expect(failure.message).toContain('503');
    }
  });

  it('空查询直接拒绝（不打网络）', async () => {
    const { calls } = stubFetch(() => ({ status: 200, body: BING_HTML }));
    await expect(runWebSearch({ query: '   ' }, { config: config() })).rejects.toBeInstanceOf(
      WebSearchError
    );
    expect(calls).toHaveLength(0);
  });

  it('指定 SearXNG 但没填地址时给出可读错误', async () => {
    stubFetch(() => ({ status: 200, body: '{}' }));
    try {
      await runWebSearch({ query: 'q' }, { config: config({ provider: 'searxng' }) });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as WebSearchError).attempts[0].error).toContain('SearXNG 地址');
    }
  });
});
