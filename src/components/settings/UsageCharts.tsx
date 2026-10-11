import { useEffect, useId, useRef, useState } from 'react';
import type { ModelUsageSummary, UsageBucket } from '../../types/usage-statistics';
import {
  compactUsageNumber,
  formatUsageCost,
  formatUsageNumber
} from '../../utils/usage-statistics';
import { t } from '../../i18n/zh';

const tokenSeries = [
  { key: 'totalTokens', label: t.statsTotalTokens, color: 'accent' },
  { key: 'input', label: t.statsInput, color: 'cyan' },
  { key: 'output', label: t.statsOutput, color: 'green' },
  { key: 'cacheRead', label: t.statsCacheRead, color: 'purple' },
  { key: 'cacheWrite', label: t.statsCacheWrite, color: 'orange' }
] as const;
const costSeries = [{ key: 'cost', label: t.statsCost, color: 'green' }] as const;
const colors = ['accent', 'purple', 'green', 'orange', 'cyan', 'yellow', 'red', 'text-dim'];

export function UsageTrend({ series, hourly }: { series: UsageBucket[]; hourly: boolean }) {
  const [cost, setCost] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geometry = useRef({ left: 60, right: 16, width: 600 });
  const descriptionId = useId();
  const candidates = cost ? costSeries : tokenSeries;
  const active = candidates.filter((item) => !hidden.has(item.key));
  const hover = hovered === null ? undefined : series[Math.min(hovered, series.length - 1)];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function draw() {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.scale(dpr, dpr);
      const theme = getComputedStyle(document.documentElement);
      const rgb = (name: string, alpha = 1) =>
        `rgb(${theme.getPropertyValue(`--od-${name}`).trim()} / ${alpha})`;
      const fontSize = parseFloat(theme.fontSize) * 0.75;
      ctx.font = `${fontSize}px ${theme.fontFamily}`;
      const left = Math.max(56, fontSize * (cost ? 6 : 4.5));
      const right = fontSize * 1.5;
      const top = fontSize * 1.3;
      const bottom = rect.height - fontSize * 2.5;
      const width = Math.max(1, rect.width - left - right);
      geometry.current = { left, right, width: rect.width };
      const visible = (cost ? costSeries : tokenSeries).filter((item) => !hidden.has(item.key));
      let peak = 0;
      for (const point of series)
        for (const item of visible) peak = Math.max(peak, point[item.key]);
      const maximum = peak > 0 ? peak * 1.12 : 1;
      const x = (index: number) => left + (index / Math.max(1, series.length - 1)) * width;
      const y = (value: number) => bottom - (value / maximum) * (bottom - top);
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let tick = 0; tick <= 4; tick++) {
        const value = (maximum * tick) / 4;
        const position = y(value);
        ctx.strokeStyle = rgb('border', 0.6);
        ctx.beginPath();
        ctx.moveTo(left, position);
        ctx.lineTo(rect.width - right, position);
        ctx.stroke();
        ctx.fillStyle = rgb('text-dim');
        ctx.fillText(
          cost ? formatUsageCost(value) : compactUsageNumber(value),
          left - fontSize * 0.6,
          position
        );
      }
      const count = Math.max(2, Math.min(7, Math.floor(width / (fontSize * 5))));
      const ticks = new Set(
        Array.from({ length: count }, (_, index) =>
          Math.round((index * (series.length - 1)) / (count - 1))
        )
      );
      ctx.textBaseline = 'top';
      for (const index of ticks) {
        const point = series[index];
        if (!point) continue;
        ctx.textAlign = index === 0 ? 'left' : index === series.length - 1 ? 'right' : 'center';
        ctx.fillText(
          hourly ? point.key.slice(11) : point.key.slice(5),
          x(index),
          bottom + fontSize
        );
      }
      for (const item of visible) {
        if (series.length === 0) continue;
        ctx.beginPath();
        series.forEach((point, index) => {
          if (index === 0) ctx.moveTo(x(index), y(point[item.key]));
          else ctx.lineTo(x(index), y(point[item.key]));
        });
        ctx.strokeStyle = rgb(item.color);
        ctx.lineWidth = item.key === 'totalTokens' ? 2.3 : 1.7;
        ctx.lineJoin = 'round';
        ctx.stroke();
        if (item.key === 'totalTokens' || item.key === 'cost') {
          ctx.lineTo(x(series.length - 1), bottom);
          ctx.lineTo(x(0), bottom);
          ctx.closePath();
          ctx.fillStyle = rgb(item.color, 0.06);
          ctx.fill();
        }
      }
      if (hovered !== null && series.length > 0) {
        const index = Math.min(hovered, series.length - 1);
        ctx.strokeStyle = rgb('text-dim', 0.5);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x(index), top);
        ctx.lineTo(x(index), bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const item of visible) {
          ctx.fillStyle = rgb(item.color);
          ctx.beginPath();
          ctx.arc(x(index), y(series[index][item.key]), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme']
    });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, [series, cost, hidden, hourly, hovered]);

  return (
    <section className="rounded-xl border border-od-border bg-od-bg-alt p-5" data-usage-trend>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-od-text-bright">{t.statsTrend}</h3>
          <p className="mt-1 text-xs text-od-text-dim">{hourly ? t.statsHourly : t.statsDaily}</p>
        </div>
        <div className="flex rounded-lg bg-od-bg p-1">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={cost === value}
              onClick={() => {
                setCost(value);
                setHovered(null);
              }}
              className={`rounded-md px-3 py-1 text-xs ${cost === value ? 'bg-od-bg-hover text-od-text-bright' : 'text-od-text-dim'}`}
            >
              {value ? t.statsCostView : t.statsTokenView}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap justify-end gap-x-4 gap-y-2">
        {candidates.map((item) => (
          <button
            type="button"
            key={item.key}
            aria-pressed={!hidden.has(item.key)}
            onClick={() =>
              setHidden((previous) => {
                const next = new Set(previous);
                if (next.has(item.key)) next.delete(item.key);
                else next.add(item.key);
                return next;
              })
            }
            className={`flex items-center gap-1.5 text-xs text-od-text-dim ${hidden.has(item.key) ? 'opacity-40 line-through' : ''}`}
          >
            <span
              className="h-0.5 w-3"
              style={{ backgroundColor: `rgb(var(--od-${item.color}))` }}
            />
            {item.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="h-64 w-full rounded focus-visible:outline focus-visible:outline-od-accent"
          tabIndex={0}
          role="img"
          aria-label={t.statsTrend}
          aria-describedby={descriptionId}
          onMouseMove={(event) => {
            const { left, right, width } = geometry.current;
            const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
            setHovered(
              Math.max(
                0,
                Math.min(
                  series.length - 1,
                  Math.round(
                    ((offset - left) / Math.max(1, width - left - right)) * (series.length - 1)
                  )
                )
              )
            );
          }}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(0)}
          onBlur={() => setHovered(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setHovered((index) =>
                Math.max(
                  0,
                  Math.min(series.length - 1, (index ?? 0) + (event.key === 'ArrowRight' ? 1 : -1))
                )
              );
            }
          }}
        />
        <span id={descriptionId} className="sr-only">
          {t.statsChartKeyboard}
        </span>
        {hover && (
          <div
            role="status"
            className="pointer-events-none absolute right-3 top-0 z-10 w-56 rounded-lg border border-od-border-light bg-od-bg p-3 text-xs shadow-lg"
          >
            <div className="mb-2 font-medium text-od-text-bright">{hover.key}</div>
            {active.map((item) => (
              <div key={item.key} className="flex justify-between gap-2 py-0.5">
                <span className="text-od-text-dim">{item.label}</span>
                <span className="tabular-nums text-od-text">
                  {item.key === 'cost'
                    ? hover.pricedRecords
                      ? formatUsageCost(hover.cost)
                      : t.statsNoCost
                    : formatUsageNumber(hover[item.key])}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="mt-3 text-xs text-od-text-dim">
        <summary className="cursor-pointer hover:text-od-text">{t.statsShowData}</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full whitespace-nowrap text-right tabular-nums">
            <thead>
              <tr>
                <th className="p-2 text-left">{t.statsPeriod}</th>
                {tokenSeries.map((item) => (
                  <th className="p-2" key={item.key}>
                    {item.label}
                  </th>
                ))}
                <th className="p-2">{t.statsCostUnit}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr className="border-t border-od-border" key={point.key}>
                  <td className="p-2 text-left">{point.key}</td>
                  {tokenSeries.map((item) => (
                    <td className="p-2" key={item.key}>
                      {formatUsageNumber(point[item.key])}
                    </td>
                  ))}
                  <td className="p-2">
                    {point.pricedRecords ? formatUsageCost(point.cost) : t.statsNoCost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function ModelShare({ models, total }: { models: ModelUsageSummary[]; total: number }) {
  const slices = models
    .filter((model) => model.totals.totalTokens > 0)
    .map((model) => ({
      name: model.model || t.statsUnknownModel,
      provider: model.provider,
      value: model.totals.totalTokens,
      key: model.key
    }));
  const shown = slices.slice(0, 7);
  if (slices.length > 7)
    shown.push({
      name: t.statsOtherModels,
      provider: '',
      value: slices.slice(7).reduce((sum, item) => sum + item.value, 0),
      key: 'others'
    });
  let offset = 0;
  const stops = shown.map((item, index) => {
    const start = offset;
    offset += total ? (item.value / total) * 100 : 0;
    return `rgb(var(--od-${colors[index]})) ${start}% ${offset}%`;
  });
  return (
    <section className="rounded-xl border border-od-border bg-od-bg-alt p-5" data-usage-share>
      <h3 className="text-sm font-semibold text-od-text-bright">{t.statsModelShare}</h3>
      <p className="mt-1 text-xs text-od-text-dim">{t.statsModelShareHint}</p>
      <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6 py-6">
        <div
          aria-hidden
          className="flex h-44 w-44 shrink-0 items-center justify-center rounded-full"
          style={{
            background: stops.length
              ? `conic-gradient(${stops.join(',')})`
              : 'rgb(var(--od-border))'
          }}
        >
          <div className="flex h-32 w-32 flex-col items-center justify-center rounded-full bg-od-bg-alt">
            <span
              title={formatUsageNumber(total)}
              className="text-2xl font-semibold tabular-nums text-od-text-bright"
            >
              {compactUsageNumber(total)}
            </span>
            <span className="mt-1 text-xs text-od-text-dim">{t.statsTotalTokens}</span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-3">
          {shown.map((item, index) => (
            <li className="flex min-w-0 items-center gap-3 text-xs" key={item.key}>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: `rgb(var(--od-${colors[index]}))` }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-od-text" title={`${item.name} · ${item.provider}`}>
                  {item.name}
                </div>
                <div className="mt-0.5 truncate text-od-text-dim">{item.provider}</div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-od-text">{formatUsageNumber(item.value)}</div>
                <div className="mt-0.5 text-od-text-dim">
                  {((item.value / total) * 100).toFixed(1)}%
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
