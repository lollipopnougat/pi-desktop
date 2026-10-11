export const BROWSER_BLANK_URL = 'about:blank';

export function isAllowedBrowserUrl(url: string): boolean {
  if (url === BROWSER_BLANK_URL) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeBrowserInput(input?: string): string {
  const value = input?.trim() || '';
  if (!value) return BROWSER_BLANK_URL;

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (!isAllowedBrowserUrl(parsed.toString())) throw new Error('仅支持 HTTP(S) 网页');
    return parsed.toString();
  }

  const looksLikeHost =
    /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z\d-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i.test(
      value
    );
  if (looksLikeHost) {
    return new URL(`https://${value}`).toString();
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('仅支持 HTTP(S) 网页');
  }

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
