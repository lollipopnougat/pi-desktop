/**
 * web_search 工具的端到端单测（不联网）：配置读取 → 搜索降级 → 文本格式化。
 *
 * 这里特意用「写临时配置文件 + stub fetch」的方式跑 `execute`，
 * 因为工具真正容易出错的地方在组合层：配置读错、失败被抛成异常、结果没格式化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { webSearchTool } from '../../electron/tools/web-search-tool';
import { clearWebSearchCache } from '../../electron/web-search/search';
import { writeWebSearchConfig } from '../../electron/web-search/config';

const BING_HTML = `<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">Example A</a></h2><p>Snippet A</p></li></ol>`;

let dir: string;

function stubFetch(status: number, body: string) {
  const spy = vi.fn(
    async () => ({ status, ok: status < 300, text: async () => body }) as unknown as Response
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-tool-'));
  process.env.PI_WEB_SEARCH_CONFIG = path.join(dir, 'web-search.json');
  clearWebSearchCache();
});

afterEach(() => {
  delete process.env.PI_WEB_SEARCH_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('webSearchTool', () => {
  it('暴露给模型的元信息齐全', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.label).toBeTruthy();
    expect(webSearchTool.description).toContain('搜索');
    expect(webSearchTool.promptGuidelines?.length ?? 0).toBeGreaterThan(0);
  });

  it('默认配置（开箱即用）下执行并格式化结果', async () => {
    // auto 链里第一个源失败，降级到 Bing 成功
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const status = url.includes('mcp.parallel.ai') ? 500 : 200;
        const body = url.includes('mcp.parallel.ai') ? 'boom' : BING_HTML;
        return { status, ok: status < 300, text: async () => body } as unknown as Response;
      })
    );

    const result = await webSearchTool.execute(
      'call-1',
      { query: 'pi agent' },
      undefined,
      undefined,
      undefined as never
    );
    const text = result.content[0].text as string;
    expect(text).toContain('Example A');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('Snippet A');
    // 降级链路要写出来，模型才知道首选源不可用
    expect(text).toContain('自动降级');
    const details = result.details as { results: unknown[]; provider: string };
    expect(details.provider).toBe('bing');
    expect(details.results).toHaveLength(1);
  });

  it('设置页关闭后不再打网络，只回一句说明', async () => {
    writeWebSearchConfig({ enabled: false });
    const spy = stubFetch(200, BING_HTML);
    const result = await webSearchTool.execute(
      'call-2',
      { query: 'pi agent' },
      undefined,
      undefined,
      undefined as never
    );
    expect(result.content[0].text).toContain('已在设置页关闭');
    expect(spy).not.toHaveBeenCalled();
  });

  it('全部源失败时返回可读错误而不是抛异常', async () => {
    stubFetch(503, 'blocked');
    const result = await webSearchTool.execute(
      'call-3',
      { query: 'pi agent' },
      undefined,
      undefined,
      undefined as never
    );
    const text = result.content[0].text as string;
    expect(text).toContain('搜索失败');
    expect(text).toContain('SearXNG');
    const details = result.details as { attempts: unknown[]; error?: string };
    expect(details.attempts).toHaveLength(4);
    expect(details.error).toBeTruthy();
  });
});
