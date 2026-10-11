import type { UsageMetrics, UsageStatisticsQuery } from '../types/usage-statistics';

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1970 || year > 9999) return;
  const date = new Date(year, month - 1, day);
  return localDateKey(date) === value ? date : undefined;
}

function applyLocalTime(date: Date, value: unknown): boolean {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  const day = localDateKey(date);
  date.setHours(hour, minute, 0, 0);
  // 夏令时跳过的本地时间不能被 Date 静默归一化成另一个时刻。
  return localDateKey(date) === day && date.getHours() === hour && date.getMinutes() === minute;
}

/** 本地日期边界兼容全天查询；有时分时结束分钟包含在内，内部使用左闭右开区间。 */
export function usageDateRange(query: UsageStatisticsQuery) {
  const start = typeof query?.startDate === 'string' ? parseDate(query.startDate) : undefined;
  const last = typeof query?.endDate === 'string' ? parseDate(query.endDate) : undefined;
  if (!start || !last || start > last) return undefined;
  const days =
    Math.round(
      (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) -
        Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
        86_400_000
    ) + 1;
  if (days > 366) return undefined;
  if (query.startTime !== undefined && !applyLocalTime(start, query.startTime)) return undefined;
  const end = new Date(last);
  if (query.endTime !== undefined) {
    if (!applyLocalTime(end, query.endTime)) return undefined;
    end.setTime(end.getTime() + 60_000);
  } else {
    end.setDate(end.getDate() + 1);
  }
  if (start >= end) return undefined;
  return { start, end, days };
}

export function recentUsageDates(days: number, now = new Date()): UsageStatisticsQuery {
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  return { startDate: localDateKey(start), endDate: localDateKey(now) };
}

export function emptyUsageMetrics(): UsageMetrics {
  return {
    records: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    pricedRecords: 0
  };
}

export function addUsageMetrics(target: UsageMetrics, source: UsageMetrics): void {
  for (const key of Object.keys(target) as (keyof UsageMetrics)[]) {
    if (key in source) target[key] += source[key];
  }
}

export function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

export function compactUsageNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

export function formatUsageCost(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);
}
