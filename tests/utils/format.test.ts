import { describe, it, expect } from 'vitest';
import { formatTokens } from '../../src/utils/format';

describe('formatTokens', () => {
  it('returns "0" for zero', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('returns "0" for negative', () => {
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(-1000)).toBe('0');
  });

  it('returns "0" for NaN/null/undefined', () => {
    expect(formatTokens(NaN)).toBe('0');
    expect(formatTokens(null as any)).toBe('0');
    expect(formatTokens(undefined as any)).toBe('0');
  });

  it('returns raw number below 1000', () => {
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(999)).toBe('999');
  });

  it('uses k unit at exactly 1000', () => {
    expect(formatTokens(1000)).toBe('1.0k');
  });

  it('formats large numbers with one decimal', () => {
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(1000000)).toBe('1000.0k');
  });

  it('rounds to one decimal place', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9999)).toBe('10.0k');
  });
});
