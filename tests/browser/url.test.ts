import { describe, expect, it } from 'vitest';
import {
  BROWSER_BLANK_URL,
  isAllowedBrowserUrl,
  normalizeBrowserInput
} from '../../electron/browser/url';

describe('browser URL normalization', () => {
  it('uses the internal blank page for empty input', () => {
    expect(normalizeBrowserInput('')).toBe(BROWSER_BLANK_URL);
  });

  it('keeps HTTP(S) URLs and upgrades host-like input to HTTPS', () => {
    expect(normalizeBrowserInput('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserInput('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserInput('localhost:5173')).toBe('https://localhost:5173/');
  });

  it('turns plain text into a Google search', () => {
    expect(normalizeBrowserInput('pi desktop browser')).toBe(
      'https://www.google.com/search?q=pi%20desktop%20browser'
    );
  });

  it('rejects non-web protocols', () => {
    expect(() => normalizeBrowserInput('file:///tmp/a.txt')).toThrow('仅支持 HTTP(S) 网页');
    expect(() => normalizeBrowserInput('javascript:alert(1)')).toThrow('仅支持 HTTP(S) 网页');
    expect(isAllowedBrowserUrl('https://example.com')).toBe(true);
    expect(isAllowedBrowserUrl('file:///tmp/a.txt')).toBe(false);
  });
});
