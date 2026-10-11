import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanUsageStatistics } from '../../electron/statistics/scan';
import { usageDateRange, recentUsageDates } from '../../src/utils/usage-statistics';

let root: string;
const query = { startDate: '2026-10-03', endDate: '2026-10-04' };
const time = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
const header = (id: string, day = 1) => ({
  type: 'session',
  id,
  timestamp: new Date(time(day)).toISOString(),
  cwd: '/test'
});
function message(id: string, day = 3, extra: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(time(day)).toISOString(),
    message: {
      role: 'assistant',
      timestamp: time(day),
      model: 'model-a',
      provider: 'provider-a',
      content: [{ type: 'text', text: id }],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 10,
        reasoning: 5,
        totalTokens: 999,
        cost: { total: 0.25 }
      },
      ...extra
    }
  };
}
async function session(file: string, entries: unknown[]) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return target;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('历史会话用量扫描', () => {
  it('按本地消息日期扫描旧会话，合计缓存且不重复叠加 reasoning', async () => {
    await session('project/2025-01-old-session.jsonl', [
      header('a'),
      message('before', 2),
      message('one'),
      message('two', 4),
      message('after', 5)
    ]);
    const result = await scanUsageStatistics(root, query);
    expect(result.totals).toEqual({
      records: 2,
      input: 200,
      output: 40,
      cacheRead: 100,
      cacheWrite: 20,
      totalTokens: 360,
      cost: 0.5,
      pricedRecords: 2
    });
    expect(result.series.map((bucket) => [bucket.key, bucket.totalTokens])).toEqual([
      ['2026-10-03', 180],
      ['2026-10-04', 180]
    ]);
    expect(result.sessionCount).toBe(1);
    expect(result.models[0].totals).toEqual(result.totals);
    expect(JSON.stringify(result)).not.toContain('content');
  });

  it('单日按小时汇总，起点包含且次日零点排除，空小时补零', async () => {
    await session('a.jsonl', [
      header('a'),
      message('midnight', 3, { timestamp: time(3, 0) }),
      message('last', 3, { timestamp: time(4, 0) - 1 }),
      message('next', 4, { timestamp: time(4, 0) })
    ]);
    const result = await scanUsageStatistics(root, {
      startDate: '2026-10-03',
      endDate: '2026-10-03'
    });
    expect(result.granularity).toBe('hour');
    expect(result.series).toHaveLength(24);
    expect(result.series[0].records).toBe(1);
    expect(result.series[23].records).toBe(1);
    expect(result.series[12].totalTokens).toBe(0);
    expect(result.totals.records).toBe(2);
  });

  it('去重 fork 副本并归属最早的会话，同时保留分支新增用量', async () => {
    const original = message('shared');
    await session('a-fork.jsonl', [
      header('fork', 4),
      { ...original, parentId: 'rewritten' },
      message('new', 4)
    ]);
    await session('z-original.jsonl', [header('original'), original]);
    let result = await scanUsageStatistics(root, query);
    expect(result.totals.records).toBe(2);
    expect(result.duplicateRecords).toBe(1);
    expect(result.sessionCount).toBe(2);
    await session('a-fork.jsonl', [header('fork', 4), original]);
    result = await scanUsageStatistics(root, query);
    expect(result.totals.records).toBe(1);
    expect(result.sessionCount).toBe(1);
  });

  it('无关会话碰巧使用同一短 entry.id 时，依照内容和时间区分', async () => {
    await session('a.jsonl', [header('a'), message('same')]);
    await session('b.jsonl', [
      header('b'),
      message('same', 3, { content: [{ type: 'text', text: 'different' }] }),
      message('same', 4)
    ]);
    expect((await scanUsageStatistics(root, query)).totals.records).toBe(3);
  });

  it('相同模型 ID 的不同供应商分别统计，辅助用量不猜测模型', async () => {
    await session('a.jsonl', [
      header('a'),
      message('one'),
      message('two', 3, { provider: 'provider-b' }),
      {
        type: 'usage',
        id: 'warm',
        kind: 'cache_warm',
        timestamp: time(3),
        provider: 'provider-a',
        model: 'model-a',
        usage: { input: 10 }
      },
      {
        type: 'compaction',
        id: 'compact',
        timestamp: time(3),
        summary: 'summary',
        usage: { input: 30, output: 5 }
      },
      { type: 'branch_summary', id: 'branch', timestamp: time(3), usage: { input: 20 } },
      {
        type: 'message',
        id: 'tool',
        timestamp: time(3),
        message: { role: 'toolResult', content: [], usage: { input: 15 } }
      }
    ]);
    const result = await scanUsageStatistics(root, query);
    expect(result.totals.records).toBe(6);
    expect(result.totals.totalTokens).toBe(440);
    expect(result.models).toHaveLength(3);
    expect(result.models.find((item) => !item.model)?.totals.totalTokens).toBe(70);
    expect(result.models.find((item) => item.provider === 'provider-a')?.totals.totalTokens).toBe(
      190
    );
  });

  it('缺少用量与费用的记录显式区分，零费用有效，异常数值不污染总计', async () => {
    await session('a.jsonl', [
      header('a'),
      message('missing', 3, { usage: undefined }),
      message('no-cost', 3, {
        usage: { input: 10, output: -20, cacheRead: '50', cacheWrite: null }
      }),
      message('zero', 3, { usage: { output: 5, cost: { total: 0 } } }),
      message('parts', 3, { usage: { input: 2, cost: { input: 0.1, output: 0.2 } } })
    ]);
    const result = await scanUsageStatistics(root, query);
    expect(result.missingUsageRecords).toBe(1);
    expect(result.totals.records).toBe(3);
    expect(result.totals.totalTokens).toBe(17);
    expect(result.totals.pricedRecords).toBe(2);
    expect(result.totals.cost).toBeCloseTo(0.3);
  });

  it('损坏行和未写完的末行不阻断其他记录，不读取符号链接', async () => {
    const file = await session('a.jsonl', [header('a'), message('one')]);
    await appendFile(file, 'not-json\n{"type":"message"');
    await session('invalid.jsonl', [message('no-header')]);
    await symlink(file, path.join(root, 'linked.jsonl'));
    await symlink(root, path.join(root, 'cycle'));
    const result = await scanUsageStatistics(root, query);
    expect(result.totals.records).toBe(1);
    expect(result.invalidLines).toBe(2);
    expect(result.skippedFiles).toBe(1);
    expect(result.duplicateRecords).toBe(0);
  });

  it('统计包含会话树的所有实际调用分支，忽略用户/工具普通文本和自定义快照', async () => {
    await session('a.jsonl', [
      header('a'),
      message('branch-a'),
      { ...message('branch-b'), parentId: 'other' },
      message('user', 3, { role: 'user', usage: undefined }),
      { type: 'custom', timestamp: time(3), data: { message: message('copied') } },
      { type: 'message', timestamp: time(3), message: { role: 'toolResult', content: [] } }
    ]);
    expect((await scanUsageStatistics(root, query)).totals.records).toBe(2);
  });

  it('消息无时间时使用 entry 时间，时间无效的记录提示跳过', async () => {
    const bad = message('bad', 3, { timestamp: undefined });
    await session('a.jsonl', [
      header('a'),
      message('fallback', 3, { timestamp: undefined }),
      { ...bad, timestamp: 'invalid' }
    ]);
    const result = await scanUsageStatistics(root, query);
    expect(result.totals.records).toBe(1);
    expect(result.invalidLines).toBe(1);
  });

  it('重新统计读取新增数据和文件删除后的状态', async () => {
    const file = await session('a.jsonl', [header('a'), message('one')]);
    expect((await scanUsageStatistics(root, query)).totals.records).toBe(1);
    await appendFile(file, JSON.stringify(message('two')) + '\n');
    expect((await scanUsageStatistics(root, query)).totals.records).toBe(2);
    await rm(file);
    expect((await scanUsageStatistics(root, query)).totals.records).toBe(0);
  });

  it('无数据或目录不存在时返回完整零值时间轴', async () => {
    const result = await scanUsageStatistics(path.join(root, 'missing'), query);
    expect(result.scannedFiles).toBe(0);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.series).toHaveLength(2);
    expect(result.models).toEqual([]);
  });
});

describe('统计日期约束', () => {
  it('分钟范围包含开始时刻和结束分钟，排除两侧记录', async () => {
    const start = new Date(2026, 9, 3, 9, 30).getTime();
    const end = new Date(2026, 9, 3, 10, 16).getTime();
    await session('minutes.jsonl', [
      header('minutes'),
      message('before', 3, { timestamp: start - 1 }),
      message('first', 3, { timestamp: start }),
      message('last', 3, { timestamp: end - 1 }),
      message('after', 3, { timestamp: end })
    ]);
    const result = await scanUsageStatistics(root, {
      startDate: '2026-10-03',
      startTime: '09:30',
      endDate: '2026-10-03',
      endTime: '10:15'
    });
    expect(result.totals.records).toBe(2);
    expect(result.series.map((bucket) => [bucket.key, bucket.records])).toEqual([
      ['2026-10-03 09:00', 1],
      ['2026-10-03 10:00', 1]
    ]);
  });

  it('跨日的早间结束时刻仍生成最后一天的统计桶', async () => {
    await session('overnight.jsonl', [
      header('overnight'),
      message('late', 3, { timestamp: time(3, 23) }),
      message('early', 4, { timestamp: time(4, 1) })
    ]);
    const result = await scanUsageStatistics(root, {
      ...query,
      startTime: '22:30',
      endTime: '01:00'
    });
    expect(result.series.map((bucket) => [bucket.key, bucket.records])).toEqual([
      ['2026-10-03', 1],
      ['2026-10-04', 1]
    ]);
    expect(result.totals.records).toBe(2);
  });

  it('同一分钟可查询，23:59 包含日末全部毫秒，非法和倒序时分被拒绝', () => {
    const base = { startDate: '2026-10-03', endDate: '2026-10-03' };
    const minute = usageDateRange({ ...base, startTime: '23:59', endTime: '23:59' })!;
    expect(minute.end.getTime() - minute.start.getTime()).toBe(60_000);
    expect(minute.end).toEqual(new Date(2026, 9, 4));
    for (const startTime of ['24:00', '12:60', '9:30', '', '12:34:56', null, 930]) {
      expect(usageDateRange({ ...base, startTime } as never)).toBeUndefined();
      expect(usageDateRange({ ...base, endTime: startTime } as never)).toBeUndefined();
    }
    expect(usageDateRange({ ...base, startTime: '10:01', endTime: '10:00' })).toBeUndefined();
  });

  it('拒绝非法日期、逆序、错误类型和过长区间', async () => {
    for (const invalid of [
      { startDate: '2026-02-30', endDate: '2026-03-01' },
      { startDate: '2026-10-04', endDate: '2026-10-03' },
      { startDate: '2025-01-01', endDate: '2026-01-02' },
      { startDate: '', endDate: '2026-10-03' }
    ])
      await expect(scanUsageStatistics(root, invalid)).rejects.toThrow();
    expect(usageDateRange(null as never)).toBeUndefined();
  });
  it('按日历计算跨月、闰年与快捷区间', () => {
    expect(usageDateRange({ startDate: '2024-01-01', endDate: '2024-12-31' })?.days).toBe(366);
    expect(usageDateRange({ startDate: '2026-03-01', endDate: '2026-03-31' })?.days).toBe(31);
    expect(recentUsageDates(7, new Date(2026, 9, 4))).toEqual({
      startDate: '2026-09-28',
      endDate: '2026-10-04'
    });
  });

  it('全天与显式分钟边界在夏令时切换日覆盖同一个本地日', () => {
    for (const date of ['2026-03-08', '2026-11-01']) {
      const fullDay = usageDateRange({ startDate: date, endDate: date })!;
      const timed = usageDateRange({
        startDate: date,
        endDate: date,
        startTime: '00:00',
        endTime: '23:59'
      })!;
      expect(timed).toEqual(fullDay);
      expect(fullDay.end.getHours()).toBe(0);
      expect(fullDay.days).toBe(1);
    }
    const before = new Date(2026, 2, 8, 1);
    const after = new Date(2026, 2, 8, 3);
    if (before.getTimezoneOffset() !== after.getTimezoneOffset()) {
      expect(
        usageDateRange({ startDate: '2026-03-08', endDate: '2026-03-08', startTime: '02:30' })
      ).toBeUndefined();
      expect(
        usageDateRange({ startDate: '2026-03-08', endDate: '2026-03-08' })!.end.getTime() -
          usageDateRange({ startDate: '2026-03-08', endDate: '2026-03-08' })!.start.getTime()
      ).toBe(23 * 60 * 60 * 1000);
    }
  });
});
