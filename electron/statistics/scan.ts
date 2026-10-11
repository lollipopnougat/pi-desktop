import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  UsageStatisticsQuery,
  UsageStatistics,
  UsageMetrics,
  UsageBucket,
  ModelUsageSummary
} from '../../src/types/usage-statistics';
import {
  addUsageMetrics,
  emptyUsageMetrics,
  localDateKey,
  usageDateRange
} from '../../src/utils/usage-statistics';
import { t } from '../../src/i18n/zh';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const timestamp = (value: unknown): number =>
  typeof value === 'number' || typeof value === 'string' ? new Date(value).getTime() : NaN;

function metrics(usage: JsonObject): UsageMetrics {
  const input = number(usage.input) ?? 0;
  const output = number(usage.output) ?? 0;
  const cacheRead = number(usage.cacheRead) ?? 0;
  const cacheWrite = number(usage.cacheWrite) ?? 0;
  const cost = object(usage.cost);
  const parts = cost
    ? ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => number(cost[key]))
    : [];
  const totalCost =
    number(cost?.total) ??
    (parts.some((part) => part !== undefined)
      ? parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
      : undefined);
  // 对齐 SDK：缓存单独计入总量，reasoning 已包含在 output 中，不再叠加。
  return {
    records: 1,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: totalCost ?? 0,
    pricedRecords: totalCost === undefined ? 0 : 1
  };
}

interface UsageRecord {
  time: number;
  provider: string;
  model: string;
  metrics?: UsageMetrics;
  session: string;
  sessionCreatedAt: number;
}

/** 只读取固定 sessions 目录中的常规 JSONL，不追踪符号链接或载入 SDK 会话。 */
export async function scanUsageStatistics(
  root: string,
  query: UsageStatisticsQuery
): Promise<UsageStatistics> {
  const range = usageDateRange(query);
  if (!range) throw new Error(t.statsInvalidDates);
  const report: UsageStatistics = {
    query,
    granularity: range.days === 1 ? 'hour' : 'day',
    totals: emptyUsageMetrics(),
    sessionCount: 0,
    series: [],
    models: [],
    scannedFiles: 0,
    skippedFiles: 0,
    invalidLines: 0,
    duplicateRecords: 0,
    missingUsageRecords: 0,
    generatedAt: 0
  };
  const files: string[] = [];
  async function discover(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      report.skippedFiles++;
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await discover(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  await discover(root);
  const records = new Map<string, UsageRecord>();
  // 文件名/mtime 不代表消息日期：旧会话可以持续追加，必须按每条记录的时间筛选。
  for (const file of files.sort()) {
    let stream: ReturnType<typeof createReadStream> | undefined;
    let lines: ReturnType<typeof createInterface> | undefined;
    try {
      const size = (await stat(file)).size;
      if (size === 0) continue;
      stream = createReadStream(file, { encoding: 'utf8', end: size - 1 });
      lines = createInterface({ input: stream, crlfDelay: Infinity });
      // readline 不转发 input 错误，销毁接口让异步迭代结束，随后报告失败。
      let readError: Error | undefined;
      stream.on('error', (error) => {
        readError = error;
        lines?.close();
      });
      let session = '';
      let sessionCreatedAt = Infinity;
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: JsonObject | undefined;
        try {
          entry = object(JSON.parse(line));
        } catch {
          report.invalidLines++;
          continue;
        }
        if (!entry) {
          report.invalidLines++;
          continue;
        }
        if (!session) {
          if (entry.type !== 'session' || !text(entry.id)) {
            report.skippedFiles++;
            break;
          }
          session = text(entry.id);
          const created = timestamp(entry.timestamp);
          sessionCreatedAt = Number.isFinite(created) ? created : Infinity;
          continue;
        }
        const message = object(entry.message);
        const isAssistant = entry.type === 'message' && message?.role === 'assistant';
        const source = entry.type === 'message' ? message : entry;
        const usage = object(source?.usage);
        const supported =
          isAssistant ||
          (entry.type === 'message' && message?.role === 'toolResult' && usage) ||
          (['usage', 'compaction', 'branch_summary'].includes(text(entry.type)) && usage);
        if (!supported || !source) continue;
        const messageTime = timestamp(message?.timestamp);
        const time = Number.isFinite(messageTime) ? messageTime : timestamp(entry.timestamp);
        if (!Number.isFinite(time)) {
          report.invalidLines++;
          continue;
        }
        if (time < range.start.getTime() || time >= range.end.getTime()) continue;
        const provider = text(source.provider);
        const model = text(source.model);
        // fork 保留 entry.id/timestamp/message，但可能重写 parentId；不把 parentId 纳入指纹。
        // 加入内容与时间，避免短 entry.id 在无关会话中碰撞；旧格式无 id 时仍能识别副本。
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              entry.type,
              entry.id ?? null,
              time,
              provider,
              model,
              usage ?? null,
              message?.content ?? entry.summary ?? null,
              entry.kind ?? null
            ])
          )
          .digest('hex');
        const existing = records.get(fingerprint);
        if (existing) {
          report.duplicateRecords++;
          // 将复制记录归于最早的原始会话，而非遍历时碰巧先读到的分支。
          if (sessionCreatedAt < existing.sessionCreatedAt) {
            existing.session = session;
            existing.sessionCreatedAt = sessionCreatedAt;
          }
          continue;
        }
        records.set(fingerprint, {
          time,
          provider,
          model,
          metrics: usage ? metrics(usage) : undefined,
          session,
          sessionCreatedAt
        });
      }
      if (readError) throw readError;
      report.scannedFiles++;
    } catch {
      report.skippedFiles++;
    } finally {
      lines?.close();
      stream?.destroy();
    }
  }
  const keys: string[] = [];
  if (report.granularity === 'hour') {
    const lastHour = new Date(range.end.getTime() - 1).getHours();
    for (let hour = range.start.getHours(); hour <= lastHour; hour++)
      keys.push(`${query.startDate} ${String(hour).padStart(2, '0')}:00`);
  } else {
    const firstDay = new Date(range.start);
    firstDay.setHours(0, 0, 0, 0);
    for (const day = firstDay; day < range.end; day.setDate(day.getDate() + 1))
      keys.push(localDateKey(day));
  }
  const makeSeries = (): UsageBucket[] => keys.map((key) => ({ key, ...emptyUsageMetrics() }));
  report.series = makeSeries();
  const indexes = new Map(keys.map((key, index) => [key, index]));
  const sessions = new Set<string>();
  const models = new Map<string, { summary: ModelUsageSummary; sessions: Set<string> }>();
  for (const record of records.values()) {
    if (!record.metrics) {
      report.missingUsageRecords++;
      continue;
    }
    const key = JSON.stringify([record.provider, record.model]);
    let group = models.get(key);
    if (!group) {
      group = {
        summary: {
          key,
          provider: record.provider,
          model: record.model,
          totals: emptyUsageMetrics(),
          sessionCount: 0,
          series: makeSeries()
        },
        sessions: new Set()
      };
      models.set(key, group);
    }
    const date = new Date(record.time);
    const bucket =
      report.granularity === 'hour'
        ? `${localDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:00`
        : localDateKey(date);
    const index = indexes.get(bucket)!;
    addUsageMetrics(report.totals, record.metrics);
    addUsageMetrics(report.series[index], record.metrics);
    addUsageMetrics(group.summary.totals, record.metrics);
    addUsageMetrics(group.summary.series[index], record.metrics);
    sessions.add(record.session);
    group.sessions.add(record.session);
  }
  report.sessionCount = sessions.size;
  report.models = [...models.values()]
    .map(({ summary, sessions: groupSessions }) => ({
      ...summary,
      sessionCount: groupSessions.size
    }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || a.key.localeCompare(b.key));
  report.generatedAt = Date.now();
  return report;
}
