import { describe, it, expect } from 'vitest';
import {
  bm25ToUnit,
  buildFtsMatch,
  computeScore,
  matchRatio,
  recencyUnit,
  snippet,
  splitQueryTerms,
  termLength
} from '../../electron/memory/search';

describe('splitQueryTerms', () => {
  it('拆出中文 ≥3 字词进 FTS、1–2 字词进 LIKE 通道', () => {
    const terms = splitQueryTerms('体素 引擎 体素');
    expect(terms.all).toEqual(['体素', '引擎']);
    expect(terms.fts).toEqual([]);
    expect(terms.short).toEqual(['体素', '引擎']);
  });

  it('三字以上中文与长英文走 FTS', () => {
    const terms = splitQueryTerms('会话槽 ChatStream');
    expect(terms.fts).toEqual(['会话槽', 'chatstream']);
    expect(terms.short).toEqual([]);
  });

  it('混排时两路都有词', () => {
    const terms = splitQueryTerms('记忆 系统 FTS5');
    expect(terms.fts).toEqual(['系统', 'fts5'].filter((t) => termLength(t) >= 3));
    expect(terms.short.length + terms.fts.length).toBe(terms.all.length);
  });

  it('中文标点与全角空格都当分隔符', () => {
    expect(splitQueryTerms('记忆，系统。约定；').all).toEqual(['记忆', '系统', '约定']);
    expect(splitQueryTerms('体素\u3000引擎').all).toEqual(['体素', '引擎']);
  });

  it('过滤停用词与空串', () => {
    expect(splitQueryTerms('的 了 记忆 系统').all).toEqual(['记忆', '系统']);
    expect(splitQueryTerms('   ').all).toEqual([]);
  });

  it('同一词去重且保持顺序', () => {
    expect(splitQueryTerms('alpha beta alpha alpha').all).toEqual(['alpha', 'beta']);
  });
});

describe('buildFtsMatch', () => {
  it('每个词加引号并用 AND 连接', () => {
    expect(buildFtsMatch(['会话槽', 'chatstream'])).toBe('"会话槽" AND "chatstream"');
  });

  it('引号转义（双引号写成两个）', () => {
    expect(buildFtsMatch(['a"b'])).toBe('"a""b"');
  });

  it('空输入返回空串', () => {
    expect(buildFtsMatch([])).toBe('');
  });
});

describe('bm25ToUnit', () => {
  it('rank 越小相关度越高', () => {
    expect(bm25ToUnit(-3, -3, -1)).toBe(1);
    expect(bm25ToUnit(-1, -3, -1)).toBe(0);
    expect(bm25ToUnit(-2, -3, -1)).toBeCloseTo(0.5, 5);
  });

  it('只有一条结果时视为最相关', () => {
    expect(bm25ToUnit(-0.5, -0.5, -0.5)).toBe(1);
  });

  it('非有限值返回 0', () => {
    expect(bm25ToUnit(Number.NaN, 0, 1)).toBe(0);
  });
});

describe('recencyUnit', () => {
  it('今天 = 1，30 天前 ≈ 1/e', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    expect(recencyUnit('2026-10-30', now)).toBeCloseTo(1, 5);
    expect(recencyUnit('2026-09-30', now)).toBeCloseTo(Math.exp(-1), 3);
  });

  it('缺失或非法日期返回 0', () => {
    expect(recencyUnit(null)).toBe(0);
    expect(recencyUnit('not-a-date')).toBe(0);
  });
});

describe('computeScore', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');

  it('相关度主导排序', () => {
    const high = computeScore({ relevance: 1, scope: 'global', text: 'x', now });
    const low = computeScore({ relevance: 0, scope: 'global', text: 'x', now });
    expect(high).toBeGreaterThan(low);
  });

  it('项目作用域、使用度、纠正类别加分', () => {
    const base = computeScore({ relevance: 0.5, scope: 'global', text: 'x', now });
    expect(computeScore({ relevance: 0.5, scope: 'project', text: 'x', now })).toBeGreaterThan(
      base
    );
    expect(
      computeScore({ relevance: 0.5, scope: 'global', text: 'x', hitCount: 5, now })
    ).toBeGreaterThan(base);
    expect(
      computeScore({ relevance: 0.5, scope: 'global', text: '[correction] x', now })
    ).toBeGreaterThan(base);
  });

  it('新近度衰减：今天比一年前高', () => {
    const fresh = computeScore({
      relevance: 0.5,
      scope: 'global',
      text: 'x',
      lastReferenced: '2026-10-30',
      now
    });
    const old = computeScore({
      relevance: 0.5,
      scope: 'global',
      text: 'x',
      lastReferenced: '2025-10-30',
      now
    });
    expect(fresh).toBeGreaterThan(old);
  });

  it('分数落在 0..100', () => {
    const max = computeScore({
      relevance: 1,
      scope: 'project',
      text: '[correction] x',
      hitCount: 10,
      lastReferenced: '2026-10-30',
      now
    });
    expect(max).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThan(90);
  });
});

describe('matchRatio', () => {
  it('按命中词占比计算', () => {
    expect(matchRatio(['a', 'b'], 'a b c')).toBe(1);
    expect(matchRatio(['a', 'z'], 'a b c')).toBe(0.5);
    expect(matchRatio([], 'a')).toBe(0);
  });
});

describe('snippet', () => {
  it('短文本原样返回', () => {
    expect(snippet('短条目', ['短'])).toBe('短条目');
  });

  it('长文本以命中词为中心截断并加省略号', () => {
    const text = `${'x'.repeat(200)}关键词${'y'.repeat(200)}`;
    const out = snippet(text, ['关键词'], 40);
    expect(out).toContain('关键词');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(42);
  });

  it('无命中词时退化为开头截断', () => {
    const out = snippet('a'.repeat(50), ['zzz'], 10);
    expect(out).toBe(`${'a'.repeat(10)}…`);
  });
});
