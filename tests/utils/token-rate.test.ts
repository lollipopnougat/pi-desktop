import { describe, it, expect, vi } from 'vitest';
import { TokenRateTracker, extractOutputTokens } from '../../src/utils/token-rate';

describe('extractOutputTokens', () => {
  it('prefers real usage.output when larger than estimate', () => {
    const msg = {
      usage: { input: 100, output: 42, cacheRead: 0, cacheWrite: 0, totalTokens: 142 },
      content: [{ type: 'text', text: 'hello' }]
    };
    expect(extractOutputTokens(msg)).toBe(42);
  });

  it('takes max of reported usage and local estimate (Anthropic frozen usage case)', () => {
    // Anthropic 流中段 usage.output 冻结在 message_start 的小值（如 3），
    // 本地估算应接管，否则速率恒为 0
    const frozen = {
      usage: { input: 100, output: 3, cacheRead: 0, cacheWrite: 0 },
      content: [{ type: 'text', text: 'a'.repeat(400) }]
    };
    expect(extractOutputTokens(frozen)).toBe(100); // max(3, 400/4)
  });

  it('falls back to estimating text chars / 4 when no usage', () => {
    const msg = { content: [{ type: 'text', text: 'a'.repeat(40) }] };
    expect(extractOutputTokens(msg)).toBe(10);
  });

  it('counts thinking blocks in fallback', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: 'b'.repeat(20) },
        { type: 'text', text: 'c'.repeat(20) }
      ]
    };
    expect(extractOutputTokens(msg)).toBe(10);
  });

  it('counts toolCall name + arguments in fallback', () => {
    const msg = {
      content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls -la' } }]
    };
    // name(4) + JSON {"command":"ls -la"} (20) = 24 chars -> 6 tokens
    expect(extractOutputTokens(msg)).toBe(6);
  });

  it('returns 0 for empty/invalid message', () => {
    expect(extractOutputTokens(null)).toBe(0);
    expect(extractOutputTokens(undefined)).toBe(0);
    expect(extractOutputTokens({})).toBe(0);
    expect(extractOutputTokens({ content: [] })).toBe(0);
  });
});

describe('TokenRateTracker', () => {
  it('returns 0 rate with fewer than 2 samples', () => {
    const tr = new TokenRateTracker();
    expect(tr.rate()).toBe(0);
    tr.record({ content: [{ type: 'text', text: 'abcd' }] });
    expect(tr.rate()).toBe(0);
  });

  it('computes rate from samples', () => {
    vi.useFakeTimers();
    try {
      const tr = new TokenRateTracker();
      let text = '';
      vi.setSystemTime(0);
      tr.record({ content: [{ type: 'text', text }] });
      // 1 秒内增加 400 字符（=100 token） → 100 tok/s
      for (let i = 1; i <= 10; i++) {
        text += 'a'.repeat(40);
        vi.setSystemTime(i * 100);
        tr.record({ content: [{ type: 'text', text }] });
      }
      expect(tr.rate()).toBeCloseTo(100, 0);
      expect(tr.totalTokens).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers real usage over estimate during record', () => {
    vi.useFakeTimers();
    try {
      const tr = new TokenRateTracker();
      vi.setSystemTime(0);
      tr.record({ usage: { output: 10 }, content: [{ type: 'text', text: 'x' }] });
      vi.setSystemTime(1000);
      tr.record({ usage: { output: 60 }, content: [{ type: 'text', text: 'xx' }] });
      expect(tr.rate()).toBeCloseTo(50, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes non-zero rate when usage is frozen but content grows (Anthropic)', () => {
    vi.useFakeTimers();
    try {
      const tr = new TokenRateTracker();
      let text = '';
      vi.setSystemTime(0);
      tr.record({ usage: { output: 3 }, content: [{ type: 'text', text }] });
      for (let i = 1; i <= 10; i++) {
        text += 'a'.repeat(40);
        vi.setSystemTime(i * 100);
        // usage.output 全程冻结在 3（message_start 值）
        tr.record({ usage: { output: 3 }, content: [{ type: 'text', text }] });
      }
      expect(tr.rate()).toBeCloseTo(100, 0);
      expect(tr.totalTokens).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores token count going backwards', () => {
    const tr = new TokenRateTracker();
    const big = { usage: { output: 100 }, content: [] };
    const small = { usage: { output: 50 }, content: [] };
    tr.record(big);
    tr.record(small);
    expect(tr.totalTokens).toBe(100);
  });

  it('handles same-timestamp samples without getting stuck at dt=0', () => {
    vi.useFakeTimers();
    try {
      const tr = new TokenRateTracker();
      vi.setSystemTime(0);
      tr.record({ usage: { output: 10 }, content: [] });
      // 同毫秒内连发多个 delta
      tr.record({ usage: { output: 20 }, content: [] });
      tr.record({ usage: { output: 30 }, content: [] });
      expect(tr.rate()).toBe(0); // 还没有跨时间样本
      // 800ms 后再来一个，应基于最近的不同时间戳样本算速率
      vi.setSystemTime(800);
      tr.record({ usage: { output: 70 }, content: [] });
      expect(tr.rate()).toBeCloseTo(50, 0); // (70-30)/0.8
    } finally {
      vi.useRealTimers();
    }
  });

  it('smoothedRate adopts first instant rate directly then smooths via EMA', () => {
    vi.useFakeTimers();
    try {
      const tr = new TokenRateTracker();
      vi.setSystemTime(0);
      tr.record({ usage: { output: 0 }, content: [] });
      vi.setSystemTime(1000);
      tr.record({ usage: { output: 100 }, content: [] });
      // 首个非 0 瞬时速率直接采纳（约 100 tok/s）
      expect(tr.smoothedRate()).toBeCloseTo(100, 0);
      // 1 秒后总量涨到 180 → 瞬时 80；EMA = 0.25*80 + 0.75*100 = 95
      vi.setSystemTime(2000);
      tr.record({ usage: { output: 180 }, content: [] });
      expect(tr.smoothedRate()).toBeCloseTo(95, 0);
      // 平峰：500ms +15 tok → 瞬时 30；EMA = 0.25*30 + 0.75*95 = 78.75
      vi.setSystemTime(2500);
      tr.record({ usage: { output: 195 }, content: [] });
      expect(tr.smoothedRate()).toBeCloseTo(78.75, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('smoothedRate stays 0 while no positive instant rate, resets to 0', () => {
    const tr = new TokenRateTracker();
    tr.record({ usage: { output: 10 }, content: [] });
    expect(tr.smoothedRate()).toBe(0); // 只有一个样本，瞬时速率为 0，不进 EMA
    tr.reset();
    expect(tr.smoothedRate()).toBe(0);
  });

  it('reset clears all state', () => {
    const tr = new TokenRateTracker();
    tr.record({ usage: { output: 10 }, content: [] });
    tr.reset();
    expect(tr.rate()).toBe(0);
    expect(tr.totalTokens).toBe(0);
  });
});
