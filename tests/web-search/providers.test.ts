/**
 * 免 Key 搜索源解析单测（离线，用抓下来的真实结构做 fixture）。
 *
 * 为什么单独测解析器：这些源都是网页抓取，结构一变就静默返回 0 条。
 * 解析器必须是纯函数（输入 HTML/JSON，输出结果数组），这样结构变化能在
 * 单测里第一时间发现，而不是等用户搜不到东西。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBingRedirect,
  decodeEntities,
  stripTags,
  truncate
} from '../../electron/web-search/http';
import {
  AUTO_CHAIN,
  extractJsonRpcPayload,
  parseBing,
  parseBrave,
  parseParallelMcp,
  parseSearxng,
  parseSo360,
  providerLabel
} from '../../electron/web-search/providers';

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a" h="ID=SERP,1.1">Example <strong>A</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">First snippet &amp; more</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/b">Example B</a></h2><p>Second snippet</p></li>
<li class="b_algo"><h2><a href="/relative/path">Relative only</a></h2></li>
</ol></body></html>`;

const BRAVE_HTML = `<div class="snippet abc" data-pos="1" data-type="web"><a href="https://example.com/x"><div class="site-name-content"><span>example.com</span></div><div class="title search-snippet-title line-clamp-1 svelte-x" title="Brave Title">Brave Title</div></a><div class="content desktop-default-regular svelte-y">Brave snippet text</div></div>
<div class="snippet def" data-pos="2" data-type="videos"><a href="https://youtube.com/watch"><div class="title search-snippet-title">Video</div></a></div>`;

const SO360_HTML = `<ul class="result"><li class="res-list" data-res-id="1"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://example.com/c" target="_blank">360 <em>标题</em></a></h3><div class="res-desc"><span class="res-list-summary" data-result-summary>360 摘要文本</span></div></li><li class="res-list"><div class="no-url">聚合卡片</div></li></ul>`;

const SEARXNG_JSON = {
  query: 'x',
  results: [
    { title: 'SX', url: 'https://example.com/sx', content: 'searxng snippet' },
    { title: 'bad', url: 'not-a-url', content: '' }
  ]
};

const PARALLEL_JSON = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          results: [
            {
              url: 'https://example.com/p',
              title: 'Parallel Result',
              excerpts: ['excerpt one', 'excerpt two'],
              publish_date: '2026-01-02'
            }
          ]
        })
      }
    ]
  }
};

describe('HTML 文本工具', () => {
  it('解码命名与数字实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;q&#39; &#x4e2d;')).toBe("a & b <c> 'q' 中");
  });

  it('stripTags 去标签并折叠空白', () => {
    expect(stripTags('<p>Hello   <strong>world</strong>\n</p>')).toBe('Hello world');
  });

  it('truncate 超长加省略号', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('decodeBingRedirect 还原 base64url 跳转链接', () => {
    const real = 'https://example.com/path';
    const encoded = `a1${Buffer.from(real).toString('base64url')}`;
    expect(decodeBingRedirect(`https://www.bing.com/ck/a?!&&u=${encoded}&ntb=1`)).toBe(real);
    // 非跳转链接 / 坏参数原样返回
    expect(decodeBingRedirect('https://example.com/ok')).toBe('https://example.com/ok');
    expect(decodeBingRedirect('https://www.bing.com/ck/a?u=zzz')).toBe(
      'https://www.bing.com/ck/a?u=zzz'
    );
  });
});

describe('parseBing', () => {
  it('取出标题/链接/摘要，跳过相对链接', () => {
    const results = parseBing(BING_HTML, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example A',
      url: 'https://example.com/a',
      snippet: 'First snippet & more'
    });
    expect(results[1].title).toBe('Example B');
  });

  it('limit 生效', () => {
    expect(parseBing(BING_HTML, 1)).toHaveLength(1);
  });

  it('结构变化时返回空数组而不是抛错', () => {
    expect(parseBing('<html><body>验证码</body></html>', 5)).toEqual([]);
  });
});

describe('parseBrave', () => {
  it('只取 data-type="web" 的块，标题取 title 属性', () => {
    const results = parseBrave(BRAVE_HTML, 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Brave Title',
      url: 'https://example.com/x',
      snippet: 'Brave snippet text'
    });
  });

  it('结构变化时返回空数组', () => {
    expect(parseBrave('<div>nothing</div>', 5)).toEqual([]);
  });
});

describe('parseSo360', () => {
  it('取 data-mdurl 作为真实链接，跳过聚合卡', () => {
    const results = parseSo360(SO360_HTML, 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/c');
    expect(results[0].title).toBe('360 标题');
    expect(results[0].snippet).toBe('360 摘要文本');
  });
});

describe('parseSearxng', () => {
  it('映射 results 并过滤非法链接', () => {
    const results = parseSearxng(SEARXNG_JSON, 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'SX',
      url: 'https://example.com/sx',
      snippet: 'searxng snippet',
      publishedAt: null
    });
  });

  it('非预期结构返回空数组', () => {
    expect(parseSearxng({}, 5)).toEqual([]);
    expect(parseSearxng(null, 5)).toEqual([]);
  });
});

describe('parseParallelMcp', () => {
  it('解析 JSON-RPC 里的 content[0].text（JSON 字符串）', () => {
    const results = parseParallelMcp(JSON.stringify(PARALLEL_JSON), 10);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Parallel Result',
      url: 'https://example.com/p',
      snippet: 'excerpt one … excerpt two',
      publishedAt: '2026-01-02'
    });
  });

  it('支持 SSE 的 data: 行', () => {
    const body = `event: message\ndata: ${JSON.stringify(PARALLEL_JSON)}\n\n`;
    expect(parseParallelMcp(body, 10)).toHaveLength(1);
  });

  it('JSON-RPC error 抛可读错误', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } });
    expect(() => parseParallelMcp(body, 10)).toThrow(/rate limited/);
  });

  it('空/坏响应返回空数组', () => {
    expect(parseParallelMcp('', 5)).toEqual([]);
    expect(parseParallelMcp('data: not-json', 5)).toEqual([]);
  });
});

describe('extractJsonRpcPayload', () => {
  it('纯 JSON 直接解析', () => {
    expect(extractJsonRpcPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it('取最后一个可解析的 data 行', () => {
    const body = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(extractJsonRpcPayload(body)).toEqual({ b: 2 });
  });

  it('无法解析返回 null', () => {
    expect(extractJsonRpcPayload('<html>')).toBeNull();
  });
});

describe('provider 元信息', () => {
  it('auto 链覆盖全部免 Key 源（searxng 在末位）', () => {
    expect(AUTO_CHAIN[0]).toBe('parallel-mcp');
    expect(AUTO_CHAIN).toContain('bing');
    expect(AUTO_CHAIN).toContain('brave');
    expect(AUTO_CHAIN).toContain('so360');
    expect(AUTO_CHAIN[AUTO_CHAIN.length - 1]).toBe('searxng');
  });

  it('label 可读', () => {
    expect(providerLabel('bing')).toBe('Bing');
    expect(providerLabel('so360')).toBe('360 搜索');
  });
});
