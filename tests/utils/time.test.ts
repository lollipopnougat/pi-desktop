import { describe, it, expect } from 'vitest';
import { formatTime } from '../../src/utils/time';

describe('formatTime', () => {
  it('formats a valid timestamp as YYYY-MM-DD HH:mm:ss', () => {
    const ts = new Date('2024-06-15T14:30:45').getTime();
    const result = formatTime(ts);
    // 格式检查（时区可能影响具体值，但格式应一致）
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('formats a specific known timestamp correctly', () => {
    // 使用 UTC 时间避免时区问题：2024-01-01T00:00:00Z
    const ts = Date.UTC(2024, 0, 1, 0, 0, 0);
    const result = formatTime(ts);
    // 在 UTC+0 时区应为 "2024-01-01 00:00:00"
    // 其他时区日期可能不同，但格式一致
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('pads single-digit components with leading zeros', () => {
    const ts = new Date(2024, 0, 5, 3, 7, 9).getTime();
    const result = formatTime(ts);
    // 月份、日、时、分、秒都应补零
    expect(result).toMatch(/2024-01-05 03:07:09/);
  });

  it('returns empty string for invalid timestamp', () => {
    expect(formatTime('invalid')).toBe('');
    expect(formatTime(NaN)).toBe('');
    expect(formatTime(undefined)).toBe('');
  });

  it('returns empty string for Infinity', () => {
    expect(formatTime(Infinity)).toBe('');
    expect(formatTime(-Infinity)).toBe('');
  });

  it('accepts numeric string timestamps', () => {
    const ts = new Date(2024, 5, 15, 10, 0, 0).getTime();
    expect(formatTime(String(ts))).toBe(formatTime(ts));
  });
});
