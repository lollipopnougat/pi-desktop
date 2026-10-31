/**
 * 记忆检索的纯函数层：查询归一化、FTS5 查询构造、打分与摘要。
 *
 * 与索引层（`search-index.ts`）解耦：这一层不摸文件与数据库，便于单测，
 * 也便于将来把检索后端从 FTS5 换成别的实现（接口不变）。
 *
 * 设计参考 pi-hermes-memory 的检索边界：
 * - 中文/英文都按「词」切分，≥3 字符才进 FTS5 trigram，<3 字符走 LIKE 兜底
 *   （trigram 索引无法匹配 1–2 字符，这是分词器本身的限制）；
 * - 排序 = BM25 相关度为主 + 项目作用域 / 新近度 / 使用度 / 纠正类别的加权。
 */

export interface QueryTerms {
  /** 去重后的全部检索词（含停用词过滤后的顺序） */
  all: string[];
  /** 长度 ≥3、可进 FTS5 trigram 的词 */
  fts: string[];
  /** 长度 <3、需要 LIKE 兜底的词（中文两字/单字、短英文缩写） */
  short: string[];
}

/** 极短且无区分度的词不参与检索（避免 "的" 命中所有条目） */
const STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '是',
  '在',
  '与',
  '及',
  '或',
  '有',
  '我',
  '你',
  '他',
  '它',
  '这',
  '那',
  '不',
  '也',
  '就',
  '都',
  'a',
  'an',
  'the',
  'of',
  'to',
  'and',
  'or',
  'for',
  'is',
  'are',
  'was',
  'be',
  'it',
  'this',
  'that',
  'with',
  'in',
  'on'
]);

/** 中英文标点统一当分隔符（保留 `-+_.:/` 这类有语义的字符） */
const SEPARATORS = /[\s，。、；：！？“”‘’（）【】《》〈〉…—～·\u3000]+/g;

/** 码点长度（CJK / emoji 都按一个字符计） */
export function termLength(term: string): number {
  return [...term].length;
}

export function splitQueryTerms(query: string): QueryTerms {
  const tokens = String(query ?? '')
    .toLowerCase()
    .replace(SEPARATORS, ' ')
    .split(' ')
    .map((token) => token.replace(/^[,.;:!?"'()[\]{}<>]+|[,.;:!?"'()[\]{}<>]+$/g, ''))
    .filter(Boolean);

  const all: string[] = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    if (!all.includes(token)) all.push(token);
  }
  return {
    all,
    fts: all.filter((token) => termLength(token) >= 3),
    short: all.filter((token) => termLength(token) < 3)
  };
}

/** FTS5 查询串：每个词加引号（避免 `-` `:` 等被当成运算符），用 AND 连接。 */
export function buildFtsMatch(terms: string[]): string {
  return terms
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

export const SCORE_WEIGHTS = {
  relevance: 0.6,
  project: 0.15,
  recency: 0.15,
  usage: 0.1,
  correction: 0.1
} as const;

/** BM25 的 rank 是「越小越相关」，按结果集的 min/max 归一化到 0..1。 */
export function bm25ToUnit(rank: number, min: number, max: number): number {
  if (!Number.isFinite(rank)) return 0;
  if (!(max > min)) return 1;
  return Math.min(1, Math.max(0, (max - rank) / (max - min)));
}

/** 新近度：最后引用（或创建）到现在的指数衰减，30 天半衰期量级。 */
export function recencyUnit(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const ts = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (!Number.isFinite(ts)) return 0;
  const days = Math.max(0, (now - ts) / 86_400_000);
  return Math.exp(-days / 30);
}

export interface ScoreInput {
  /** 0..1 相关度（BM25 归一化，或 LIKE 通道的命中词占比） */
  relevance: number;
  scope: 'project' | 'global';
  lastReferenced?: string | null;
  created?: string | null;
  hitCount?: number;
  text: string;
  now?: number;
}

/** 权重之和（打分前归一化，保证结果落在 0..100） */
const WEIGHT_SUM = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);

/** 综合分（0..100，保留一位小数），只用于排序与排查，不展示给模型。 */
export function computeScore(input: ScoreInput): number {
  const now = input.now ?? Date.now();
  const recency = recencyUnit(input.lastReferenced || input.created, now);
  const usage = Math.min(1, Math.max(0, (input.hitCount ?? 0) / 5));
  const correction = /\[correction\]/.test(input.text) ? 1 : 0;
  const total =
    SCORE_WEIGHTS.relevance * input.relevance +
    SCORE_WEIGHTS.project * (input.scope === 'project' ? 1 : 0) +
    SCORE_WEIGHTS.recency * recency +
    SCORE_WEIGHTS.usage * usage +
    SCORE_WEIGHTS.correction * correction;
  return Math.round((total / WEIGHT_SUM) * 1000) / 10;
}

/** LIKE 通道的相关度：命中词数 / 总词数（没有 BM25 可用时的替代）。 */
export function matchRatio(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

/**
 * 结果摘要：命中词附近 ±60 字的窗口，长条目不再整段塞给模型。
 * 无命中词时退化为开头截断。
 */
export function snippet(text: string, terms: string[], max = 120): string {
  const body = text.replace(/\s+/g, ' ').trim();
  if (body.length <= max) return body;
  const lower = body.toLowerCase();
  const at = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined) return `${body.slice(0, max)}…`;
  const half = Math.max(0, Math.floor((max - (terms[0]?.length ?? 0)) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(body.length, start + max);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}
