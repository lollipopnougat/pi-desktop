import { describe, it, expect } from 'vitest';
import { extractText, truncate, normalize, shortenPath } from '../../src/utils/text';

describe('extractText', () => {
  it('returns string content as-is', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('extracts text blocks from content array', () => {
    const content = [
      { type: 'text', text: 'hello ' },
      { type: 'image', url: 'x' },
      { type: 'text', text: 'world' },
    ];
    expect(extractText(content)).toBe('hello world');
  });

  it('returns empty string for non-array non-string', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText(42)).toBe('');
    expect(extractText({})).toBe('');
  });

  it('returns empty string for array with no text blocks', () => {
    expect(extractText([{ type: 'image', url: 'x' }])).toBe('');
  });

  it('handles empty array', () => {
    expect(extractText([])).toBe('');
  });

  it('filters out falsy entries', () => {
    expect(extractText([null, undefined, { type: 'text', text: 'ok' }])).toBe('ok');
  });
});

describe('truncate', () => {
  it('returns empty string for falsy input', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate(null as any, 10)).toBe('');
  });

  it('returns string unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when exceeding limit', () => {
    expect(truncate('hello world', 5)).toBe('hello…');
  });

  it('handles exact boundary', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello!', 5)).toBe('hello…');
  });
});

describe('normalize', () => {
  it('replaces newlines and tabs with spaces', () => {
    expect(normalize('hello\nworld\tfoo')).toBe('hello world foo');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalize('  hello  ')).toBe('hello');
  });

  it('returns empty string for falsy input', () => {
    expect(normalize('')).toBe('');
    expect(normalize(null as any)).toBe('');
  });

  it('handles multiple consecutive newlines/tabs', () => {
    expect(normalize('a\n\nb\t\tc')).toBe('a  b  c');
  });
});

describe('shortenPath', () => {
  it('returns empty string for falsy input', () => {
    expect(shortenPath('')).toBe('');
  });

  it('returns path as-is (renderer has no HOME)', () => {
    expect(shortenPath('/Users/test/project')).toBe('/Users/test/project');
  });
});
