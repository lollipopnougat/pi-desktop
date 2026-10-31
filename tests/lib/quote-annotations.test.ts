import { describe, expect, it } from 'vitest';
import {
  MAX_QUOTE_CHARS,
  buildQuotePrompt,
  createQuoteAnnotation,
  quoteSummary,
  withQuotePrompt,
  type QuoteAnnotation
} from '../../src/lib/quote-annotations';

function quote(overrides: Partial<QuoteAnnotation> = {}): QuoteAnnotation {
  return {
    id: 'quote-1',
    createdAt: 1,
    quote: '8 种植物：向日葵、豌豆射手、坚果墙',
    comment: '',
    ...overrides
  };
}

describe('createQuoteAnnotation', () => {
  it('returns null for an empty or whitespace-only selection', () => {
    expect(createQuoteAnnotation('')).toBeNull();
    expect(createQuoteAnnotation('   \n\t ')).toBeNull();
  });

  it('collapses whitespace and starts with an empty comment', () => {
    const created = createQuoteAnnotation('  第一行\n\n  第二行  ');
    expect(created).not.toBeNull();
    expect(created!.quote).toBe('第一行 第二行');
    expect(created!.comment).toBe('');
    expect(created!.id).toMatch(/^quote-/);
  });

  it('truncates oversized selections instead of shipping the whole block', () => {
    const created = createQuoteAnnotation('x'.repeat(MAX_QUOTE_CHARS + 100));
    expect(created!.quote.length).toBe(MAX_QUOTE_CHARS + 1);
    expect(created!.quote.endsWith('…')).toBe(true);
  });

  it('generates distinct ids for the same text', () => {
    const first = createQuoteAnnotation('同一段话');
    const second = createQuoteAnnotation('同一段话');
    expect(first!.id).not.toBe(second!.id);
  });
});

describe('quoteSummary', () => {
  it('keeps short quotes intact and truncates long ones', () => {
    expect(quoteSummary('短引用')).toBe('短引用');
    const long = 'y'.repeat(400);
    expect(quoteSummary(long).length).toBe(161);
    expect(quoteSummary(long).endsWith('…')).toBe(true);
  });
});

describe('buildQuotePrompt', () => {
  it('returns an empty string without annotations', () => {
    expect(buildQuotePrompt([])).toBe('');
    expect(withQuotePrompt('你好', [])).toBe('你好');
  });

  it('renders each quote with its comment', () => {
    const block = buildQuotePrompt([quote({ comment: ' 这段删掉 ' })]);
    expect(block).toContain('### 对话引用批注');
    expect(block).toContain('引用了你上面回答里的 1 处文字');
    expect(block).toContain('**引用 1**');
    expect(block).toContain('> 8 种植物：向日葵、豌豆射手、坚果墙');
    expect(block).toContain('- 用户批注：这段删掉');
  });

  it('marks annotations that carry no comment', () => {
    expect(buildQuotePrompt([quote()])).toContain('(只引用了原文，没有额外说明)');
  });

  it('numbers multiple quotes and skips empty quotes', () => {
    const block = buildQuotePrompt([
      quote({ id: 'a' }),
      quote({ id: 'b', quote: '', comment: '空的应被跳过' }),
      quote({ id: 'c', quote: '第二段原文' })
    ]);
    expect(block).toContain('2 处文字');
    expect(block).toContain('**引用 2**');
    expect(block).toContain('> 第二段原文');
    expect(block).not.toContain('空的应被跳过');
  });
});

describe('withQuotePrompt', () => {
  it('appends the block after the user text', () => {
    const merged = withQuotePrompt('把这段改成中文', [quote({ comment: '换成口语' })]);
    expect(merged.startsWith('把这段改成中文\n\n### 对话引用批注')).toBe(true);
    expect(merged).toContain('换成口语');
  });

  it('sends the block alone when there is no text', () => {
    const merged = withQuotePrompt('', [quote()]);
    expect(merged.startsWith('### 对话引用批注')).toBe(true);
  });
});
