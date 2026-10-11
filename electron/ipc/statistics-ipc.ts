import { ipcMain } from 'electron';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { DESKTOP_AGENT_DIR } from '../config-dir';
import { usageDateRange } from '../../src/utils/usage-statistics';
import type { UsageStatistics, UsageStatisticsQuery } from '../../src/types/usage-statistics';
import { t } from '../../src/i18n/zh';

/** 一个窗口最多一个扫描；切换日期、离开 tab 或关闭窗口时释放后台线程。 */
export function registerStatisticsIpc() {
  const active = new Map<number, { id: string; cancel: () => void }>();
  ipcMain.handle(
    'pi:getUsageStatistics',
    (event, query: UsageStatisticsQuery, requestId: string) => {
      if (!usageDateRange(query) || typeof requestId !== 'string' || requestId.length > 100)
        throw new Error(t.statsInvalidDates);
      const sender = event.sender;
      active.get(sender.id)?.cancel();
      return new Promise<UsageStatistics | null>((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'usage-worker.js'), {
          workerData: {
            root: path.join(DESKTOP_AGENT_DIR, 'sessions'),
            query: {
              startDate: query.startDate,
              endDate: query.endDate,
              startTime: query.startTime,
              endTime: query.endTime
            }
          }
        });
        let settled = false;
        const finish = (result: UsageStatistics | null, error?: Error) => {
          if (settled) return;
          settled = true;
          if (active.get(sender.id)?.id === requestId) active.delete(sender.id);
          sender.removeListener('destroyed', cancel);
          void worker.terminate().catch(() => {});
          if (error) reject(error);
          else resolve(result);
        };
        const cancel = () => finish(null);
        active.set(sender.id, { id: requestId, cancel });
        sender.once('destroyed', cancel);
        worker.once(
          'message',
          (message: { ok: boolean; report?: UsageStatistics; error?: string }) => {
            if (message.ok && message.report) finish(message.report);
            else finish(null, new Error(message.error || t.statsScanFailed));
          }
        );
        worker.once('error', (error) => finish(null, error));
        worker.once('exit', () => {
          if (!settled) finish(null, new Error(t.statsScanFailed));
        });
      });
    }
  );
  ipcMain.on('pi:cancelUsageStatistics', (event, requestId: string) => {
    const current = active.get(event.sender.id);
    if (current?.id === requestId) current.cancel();
  });
}
