import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Dropdown from '../common/Dropdown';
import DateTimePicker from '../common/DateTimePicker';
import type { UsageStatistics, UsageStatisticsQuery } from '../../types/usage-statistics';
import {
  formatUsageCost,
  formatUsageNumber,
  recentUsageDates,
  usageDateRange
} from '../../utils/usage-statistics';
import { ModelShare, UsageTrend } from './UsageCharts';
import { t } from '../../i18n/zh';

const presets = [
  { days: 1, label: t.statsToday },
  { days: 7, label: t.statsWeek },
  { days: 30, label: t.statsMonth },
  { days: 90, label: t.statsQuarter }
];

export default function StatisticsTab() {
  const [query, setQuery] = useState<UsageStatisticsQuery>(() => recentUsageDates(30));
  const [preset, setPreset] = useState<number | null>(30);
  const [model, setModel] = useState('');
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<{
    key: string;
    report: UsageStatistics | null;
    error: string;
  } | null>(null);
  const valid = Boolean(usageDateRange(query));
  const requestKey = JSON.stringify([
    query.startDate,
    query.endDate,
    query.startTime,
    query.endTime,
    revision
  ]);
  const current = response?.key === requestKey ? response.report : null;
  const loading = valid && response?.key !== requestKey;
  const error = response?.key === requestKey ? response.error : '';

  useEffect(() => {
    if (!usageDateRange(query)) return;
    let live = true;
    let started = false;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      started = true;
      window.pi
        .getUsageStatistics(query, requestId)
        .then((result) => {
          if (live)
            setResponse({
              key: requestKey,
              report: result,
              error: result ? '' : t.statsScanFailed
            });
        })
        .catch((cause: unknown) => {
          if (live)
            setResponse({
              key: requestKey,
              report: null,
              error: cause instanceof Error ? cause.message : String(cause)
            });
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (started) window.pi.cancelUsageStatistics(requestId);
    };
  }, [query, requestKey]);

  const changeDates = (next: UsageStatisticsQuery, days: number | null = null) => {
    setQuery(next);
    setPreset(days);
    setModel('');
  };
  const selected = current?.models.find((item) => item.key === model);
  const summary = selected ?? current;
  const totals = summary?.totals;
  const inputTotal = totals ? totals.input + totals.cacheRead + totals.cacheWrite : 0;
  const cacheRate = inputTotal && totals ? (totals.cacheRead / inputTotal) * 100 : 0;
  const models = selected ? [selected] : (current?.models ?? []);

  return (
    <div className="space-y-5" data-statistics-tab>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-od-text-bright">{t.tabStatistics}</h2>
          <p className="mt-1.5 text-xs text-od-text-dim">{t.statsDescription}</p>
        </div>
        {current && (
          <p className="pt-1 text-xs text-od-text-dim">
            {t.statsUpdated(
              new Date(current.generatedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit'
              }),
              current.scannedFiles
            )}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-od-border bg-od-bg-alt p-4">
        <div className="min-w-0 max-w-full space-y-3">
          <div className="flex flex-wrap gap-1 rounded-lg bg-od-bg p-1">
            {presets.map((item) => (
              <button
                type="button"
                key={item.days}
                aria-pressed={preset === item.days}
                onClick={() => changeDates(recentUsageDates(item.days), item.days)}
                className={`rounded-md px-3 py-1 text-xs transition-colors ${preset === item.days ? 'bg-od-accent/15 text-od-accent' : 'text-od-text-dim hover:text-od-text'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-od-text-dim">
            <DateTimePicker
              ariaLabel={t.statsStartDateTime}
              mode="datetime"
              value={`${query.startDate}T${query.startTime ?? '00:00'}`}
              maxValue={`${query.endDate}T${query.endTime ?? '23:59'}`}
              onChange={(value) => {
                const [startDate, startTime] = value.split('T');
                changeDates({ ...query, startDate, startTime });
              }}
            />
            <span>{t.statsTo}</span>
            <DateTimePicker
              ariaLabel={t.statsEndDateTime}
              mode="datetime"
              value={`${query.endDate}T${query.endTime ?? '23:59'}`}
              minValue={`${query.startDate}T${query.startTime ?? '00:00'}`}
              onChange={(value) => {
                const [endDate, endTime] = value.split('T');
                changeDates({ ...query, endDate, endTime });
              }}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 basis-60 items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-xs text-od-text-dim">{t.statsModelFilter}</div>
            <Dropdown
              value={selected?.key ?? ''}
              onChange={setModel}
              ariaLabel={t.statsModelFilter}
              className="h-9"
              fullWidth
              searchable
              disabled={loading || !current}
              options={[
                { value: '', label: t.statsAllModels },
                ...(current?.models ?? []).map((item) => ({
                  value: item.key,
                  label: item.model || t.statsUnknownModel,
                  hint: item.provider || t.statsUnknownProvider
                }))
              ]}
            />
          </div>
          <button
            type="button"
            aria-label={t.statsRefresh}
            title={t.statsRefresh}
            disabled={!valid}
            onClick={() => setRevision((value) => value + 1)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-od-border-light text-od-text-dim hover:bg-od-bg-hover hover:text-od-text disabled:opacity-40"
          >
            <Icon name={loading ? 'spinner' : 'refresh'} spin={loading} className="w-3.5" />
          </button>
        </div>
      </div>
      <p className="text-xs text-od-text-dim">{t.statsTimeRangeHint}</p>
      {!valid && (
        <p role="alert" className="text-sm text-od-yellow">
          {t.statsInvalidDates}
        </p>
      )}
      {valid && error && (
        <div
          role="alert"
          className="rounded-xl border border-od-red/30 bg-od-red/5 p-5 text-sm text-od-red"
        >
          {t.statsScanFailed}
          <p className="mt-2 break-words text-xs">{error}</p>
        </div>
      )}
      {valid && loading && (
        <div
          role="status"
          className="flex min-h-64 items-center justify-center gap-3 rounded-xl border border-od-border bg-od-bg-alt text-sm text-od-text-dim"
        >
          <Icon name="spinner" spin className="w-4" />
          {t.statsLoading}
        </div>
      )}
      {current && !loading && (
        <>
          {(current.skippedFiles > 0 ||
            current.invalidLines > 0 ||
            current.missingUsageRecords > 0) && (
            <p
              role="status"
              className="rounded-lg border border-od-yellow/30 bg-od-yellow/5 p-3 text-xs text-od-yellow"
            >
              {t.statsScanWarnings(
                current.skippedFiles,
                current.invalidLines,
                current.missingUsageRecords
              )}
            </p>
          )}
          {totals && (
            <section
              className="rounded-xl border border-od-border bg-od-bg-alt p-5"
              data-usage-summary
            >
              <div className="mb-6 flex flex-wrap items-center justify-between gap-5">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-od-accent/10 text-od-accent">
                    <Icon name="statistics" className="w-5" />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-od-text-dim">{t.statsTotalTokens}</div>
                    <div
                      data-total-tokens
                      className="break-all text-3xl font-semibold tabular-nums text-od-text-bright"
                    >
                      {formatUsageNumber(totals.totalTokens)}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-7 gap-y-3 text-xs">
                  <div>
                    <div className="text-od-text-dim">{t.statsRecords}</div>
                    <div className="mt-1 text-base tabular-nums text-od-text-bright">
                      {formatUsageNumber(totals.records)}
                    </div>
                  </div>
                  <div>
                    <div className="text-od-text-dim">{t.statsSessions}</div>
                    <div className="mt-1 text-base tabular-nums text-od-text-bright">
                      {formatUsageNumber(summary!.sessionCount)}
                    </div>
                  </div>
                  <div>
                    <div className="text-od-text-dim">{t.statsCostUnit}</div>
                    <div data-total-cost className="mt-1 text-base tabular-nums text-od-green">
                      {totals.pricedRecords ? formatUsageCost(totals.cost) : t.statsNoCost}
                    </div>
                    {totals.pricedRecords > 0 && totals.pricedRecords < totals.records && (
                      <div className="mt-1 text-od-yellow">{t.statsPartialCost}</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
                {[
                  {
                    label: t.statsInput,
                    value: totals.input,
                    color: 'text-od-cyan',
                    icon: 'back' as const
                  },
                  {
                    label: t.statsOutput,
                    value: totals.output,
                    color: 'text-od-green',
                    icon: 'external' as const
                  },
                  {
                    label: t.statsCacheRead,
                    value: totals.cacheRead,
                    color: 'text-od-purple',
                    icon: 'memory' as const
                  },
                  {
                    label: t.statsCacheWrite,
                    value: totals.cacheWrite,
                    color: 'text-od-orange',
                    icon: 'save' as const
                  }
                ].map((item) => (
                  <div
                    key={item.label}
                    className="min-w-0 rounded-lg border border-od-border bg-od-bg/50 p-3"
                  >
                    <div className="mb-2 flex items-center gap-2 text-xs text-od-text-dim">
                      <Icon name={item.icon} className={`w-3 ${item.color}`} />
                      {item.label}
                    </div>
                    <div className="break-all text-lg font-medium tabular-nums text-od-text-bright">
                      {formatUsageNumber(item.value)}
                    </div>
                  </div>
                ))}
                <div
                  className="col-span-2 rounded-lg border border-od-border bg-od-bg/50 p-3 xl:col-span-1"
                  title={t.statsCacheRateHint}
                >
                  <div className="mb-2 flex justify-between gap-2 text-xs">
                    <span className="text-od-text-dim">{t.statsCacheRate}</span>
                    <span className="tabular-nums text-od-green">{cacheRate.toFixed(1)}%</span>
                  </div>
                  <div
                    role="meter"
                    aria-label={t.statsCacheRate}
                    aria-valuenow={cacheRate}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-od-border"
                  >
                    <div
                      className="h-full rounded-full bg-od-green"
                      style={{ width: `${cacheRate}%` }}
                    />
                  </div>
                </div>
              </div>
            </section>
          )}
          {totals?.records === 0 && (
            <div className="rounded-xl border border-dashed border-od-border p-8 text-center">
              <Icon name="statistics" className="mb-3 w-6 text-od-text-dim" />
              <p className="text-sm text-od-text">{t.statsEmpty}</p>
              <p className="mt-2 text-xs text-od-text-dim">{t.statsEmptyHint}</p>
            </div>
          )}
          {summary && (
            <UsageTrend series={summary.series} hourly={current.granularity === 'hour'} />
          )}
          {totals && totals.totalTokens > 0 && (
            <ModelShare models={models} total={totals.totalTokens} />
          )}
          {models.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-od-border bg-od-bg-alt">
              <h3 className="p-5 text-sm font-semibold text-od-text-bright">
                {t.statsModelDetails}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-right text-xs tabular-nums">
                  <thead className="border-y border-od-border bg-od-bg/50 text-od-text-dim">
                    <tr>
                      <th className="px-5 py-3 text-left">{t.statsModel}</th>
                      {[t.statsRecords, t.statsTotalTokens, t.statsShare, t.statsCostUnit].map(
                        (label) => (
                          <th key={label} className="px-4 py-3 font-medium">
                            {label}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((item) => (
                      <tr
                        className="border-b border-od-border last:border-0 hover:bg-od-bg-hover"
                        key={item.key}
                      >
                        <td className="px-5 py-3 text-left">
                          <button
                            type="button"
                            className="max-w-64 truncate text-od-text hover:text-od-accent"
                            title={item.model || t.statsUnknownModel}
                            onClick={() => setModel(item.key)}
                          >
                            {item.model || t.statsUnknownModel}
                          </button>
                          <div className="mt-1 text-od-text-dim">
                            {item.provider || t.statsUnknownProvider}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-od-text">
                          {formatUsageNumber(item.totals.records)}
                        </td>
                        <td className="px-4 py-3 text-od-text">
                          {formatUsageNumber(item.totals.totalTokens)}
                        </td>
                        <td className="px-4 py-3 text-od-text-dim">
                          {totals?.totalTokens
                            ? ((item.totals.totalTokens / totals.totalTokens) * 100).toFixed(1)
                            : '0.0'}
                          %
                        </td>
                        <td className="px-4 py-3 text-od-green">
                          {item.totals.pricedRecords
                            ? formatUsageCost(item.totals.cost)
                            : t.statsNoCost}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      <div className="space-y-1.5 text-xs leading-relaxed text-od-text-dim">
        <p>{t.statsSource}</p>
        <p>{t.statsMethod}</p>
        <p>{t.statsCostNote}</p>
        {current && current.duplicateRecords > 0 && (
          <p>{t.statsDeduplicated(current.duplicateRecords)}</p>
        )}
      </div>
    </div>
  );
}
