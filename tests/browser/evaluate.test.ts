import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVALUATE_TIMEOUT_MS,
  MAX_EVALUATE_OUTPUT_CHARS,
  MAX_EVALUATE_TIMEOUT_MS,
  buildBodyScript,
  buildEvaluateScript,
  buildExpressionScript,
  clampEvaluateTimeout,
  detectEvaluateMode,
  formatEvaluateResult
} from '../../electron/browser/evaluate';

describe('buildEvaluateScript', () => {
  it('wraps expressions so the value is awaited and serialized in the page', () => {
    const script = buildExpressionScript('document.title');
    expect(script.startsWith('(async () => {')).toBe(true);
    expect(script).toContain('const __piValue = await (\ndocument.title\n);');
    expect(script).toContain('__piSafe');
  });

  it('wraps statements in an inner async function so return/await work', () => {
    const script = buildBodyScript('const a = 1; return a * 2;');
    expect(script).toContain('await (async () => {\nconst a = 1; return a * 2;\n  })();');
  });

  it('dispatches on the requested mode', () => {
    expect(buildEvaluateScript('1 + 1', 'expression')).toBe(buildExpressionScript('1 + 1'));
    expect(buildEvaluateScript('1 + 1', 'body')).toBe(buildBodyScript('1 + 1'));
  });
});

describe('clampEvaluateTimeout', () => {
  it('falls back to the default and clamps into range', () => {
    expect(clampEvaluateTimeout(undefined)).toBe(DEFAULT_EVALUATE_TIMEOUT_MS);
    expect(clampEvaluateTimeout(0)).toBe(DEFAULT_EVALUATE_TIMEOUT_MS);
    expect(clampEvaluateTimeout(Number.NaN)).toBe(DEFAULT_EVALUATE_TIMEOUT_MS);
    expect(clampEvaluateTimeout(-5)).toBe(DEFAULT_EVALUATE_TIMEOUT_MS);
    expect(clampEvaluateTimeout(50)).toBe(100);
    expect(clampEvaluateTimeout(999_999)).toBe(MAX_EVALUATE_TIMEOUT_MS);
    expect(clampEvaluateTimeout(1234.6)).toBe(1235);
  });
});

describe('detectEvaluateMode', () => {
  it('treats expressions (and trailing comments) as expressions', () => {
    expect(detectEvaluateMode('document.title')).toBe('expression');
    expect(detectEvaluateMode('await fetch("/api")')).toBe('expression');
    expect(detectEvaluateMode('({ a: 1 })')).toBe('expression');
    expect(detectEvaluateMode('document.title // 标题')).toBe('expression');
    expect(detectEvaluateMode('(() => { return 1 })()')).toBe('expression');
  });

  it('falls back to the function body for statements', () => {
    expect(detectEvaluateMode('const a = 1; return a * 2;')).toBe('body');
    expect(detectEvaluateMode('return 1')).toBe('body');
    expect(detectEvaluateMode('const a = 1\nconsole.log(a)')).toBe('body');
  });

  it('never executes the code while probing', () => {
    // 探测阶段只做语法解析：副作用不应该发生
    expect(detectEvaluateMode('globalThis.__detectProbe = true;')).toBe('body');
    expect((globalThis as Record<string, unknown>).__detectProbe).toBeUndefined();
  });
});

describe('formatEvaluateResult', () => {
  it('renders the safe-serialization envelope', () => {
    expect(formatEvaluateResult(undefined)).toBe('undefined');
    expect(formatEvaluateResult(null)).toBe('undefined');
    expect(formatEvaluateResult({ kind: 'undefined' })).toBe('undefined');
    expect(formatEvaluateResult({ kind: 'json', value: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(formatEvaluateResult({ kind: 'json', value: 'text' })).toBe('text');
    expect(formatEvaluateResult({ kind: 'string', value: 'Error: x' })).toBe('Error: x');
    expect(formatEvaluateResult('plain')).toBe('plain');
  });

  it('truncates long output and reports the original length', () => {
    const raw = 'x'.repeat(MAX_EVALUATE_OUTPUT_CHARS + 10);
    const text = formatEvaluateResult({ kind: 'json', value: raw });
    expect(text).toContain('已截断');
    expect(text).toContain(String(raw.length));
    expect(text.startsWith('x'.repeat(100))).toBe(true);
  });

  it('documents the evaluate limits', () => {
    expect(MAX_EVALUATE_OUTPUT_CHARS).toBe(20_000);
    expect(DEFAULT_EVALUATE_TIMEOUT_MS).toBe(10_000);
    expect(MAX_EVALUATE_TIMEOUT_MS).toBe(30_000);
  });
});
