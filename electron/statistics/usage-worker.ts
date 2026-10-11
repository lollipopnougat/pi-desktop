import { parentPort, workerData } from 'node:worker_threads';
import { scanUsageStatistics } from './scan';
import type { UsageStatisticsQuery } from '../../src/types/usage-statistics';

const { root, query } = workerData as { root: string; query: UsageStatisticsQuery };
void scanUsageStatistics(root, query).then(
  (report) => parentPort?.postMessage({ ok: true, report }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
);
