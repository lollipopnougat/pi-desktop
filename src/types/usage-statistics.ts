export interface UsageStatisticsQuery {
  startDate: string;
  endDate: string;
  /** 本地时分 HH:mm；省略时从开始日零点统计至结束日全天。 */
  startTime?: string;
  /** 包含所选结束分钟内的全部记录。 */
  endTime?: string;
}

export interface UsageMetrics {
  records: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  pricedRecords: number;
}

export interface UsageBucket extends UsageMetrics {
  /** 本地日期，单日查询时为 YYYY-MM-DD HH:00。 */
  key: string;
}

export interface UsageSummary {
  totals: UsageMetrics;
  sessionCount: number;
  series: UsageBucket[];
}

export interface ModelUsageSummary extends UsageSummary {
  key: string;
  provider: string;
  model: string;
}

export interface UsageStatistics extends UsageSummary {
  query: UsageStatisticsQuery;
  granularity: 'hour' | 'day';
  models: ModelUsageSummary[];
  scannedFiles: number;
  skippedFiles: number;
  invalidLines: number;
  duplicateRecords: number;
  missingUsageRecords: number;
  generatedAt: number;
}
