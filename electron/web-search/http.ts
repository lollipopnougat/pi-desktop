/**
 * 搜索用的 HTTP 小工具：带超时/取消的 fetch + 轻量 HTML 文本处理。
 *
 * 为什么不用第三方 HTML 解析器：这些搜索页都是「结构稳定、只需取三条信息
 * （链接/标题/摘要）」的场景，正则 + 分块足够；引入 cheerio 这类依赖会让
 * 主进程 bundle 变大，且对结构变化同样没有免疫力。
 *
 * 所有源都是**网页抓取**（免 Key 的代价）：因此必须
 * 1. 带浏览器 UA（裸 fetch 的 UA 会被直接判成爬虫）
 * 2. 每次请求都设超时（搜索页偶尔会挂住十几秒）
 * 3. 失败时抛出可读错误（调用方据此降级到下一个源）
 */

/** 浏览器 UA：抓取搜索页时必带（Node 默认 UA 会被 403 / 验证码拦） */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchTextOptions {
  timeoutMs: number;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** 上层取消（工具调用被中止时透传） */
  signal?: AbortSignal;
}

export interface FetchTextResult {
  status: number;
  text: string;
}

/** HTTP 状态非 2xx 时抛出（message 里带状态码与响应片段，便于定位被封/被限流） */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status}（${url}）：${body.slice(0, 160).replace(/\s+/g, ' ')}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * 取文本：超时 + 上层取消都会中止请求。
 * 默认跟随重定向（Bing/360 会跳到地区站点）。
 */
export async function fetchText(url: string, opts: FetchTextOptions): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, opts.timeoutMs));
  const forwardAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', forwardAbort);
  }
  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...opts.headers
      }
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new Error(`请求超时（${Math.round(opts.timeoutMs / 1000)}s）：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', forwardAbort);
  }
}

/** 取文本并要求 2xx；非 2xx 抛 HttpStatusError */
export async function fetchOk(url: string, opts: FetchTextOptions): Promise<string> {
  const { status, text } = await fetchText(url, opts);
  if (status < 200 || status >= 300) throw new HttpStatusError(url, status, text);
  return text;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×'
};

/** HTML 实体解码（命名实体走白名单，其余按数字实体处理） */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 去掉标签 + 解码实体 + 折叠空白（搜索结果文本一律走这里） */
export function stripTags(input: string): string {
  const withoutTags = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return collapseWhitespace(decodeEntities(withoutTags));
}

export function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00a0]+/g, ' ').trim();
}

/** 截断到 n 个字符（超出加省略号），避免超长摘要挤爆上下文 */
export function truncate(input: string, n: number): string {
  const text = collapseWhitespace(input);
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/**
 * 还原 Bing 的跳转链接：`https://www.bing.com/ck/a?...&u=a1<base64url>`
 * 其中 u 参数以 "a1" 前缀 + URL 的 base64url 编码。解析失败原样返回。
 */
export function decodeBingRedirect(url: string): string {
  if (!/bing\.com\/ck\/a/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get('u');
    if (!raw || !raw.startsWith('a1')) return url;
    const base64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** 第一个捕获组；没有匹配返回空串 */
export function firstGroup(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  return match?.[1] ? match[1] : '';
}
