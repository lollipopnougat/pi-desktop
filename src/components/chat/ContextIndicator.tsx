import { useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import { formatTokens as fmt } from '../../utils/format';
import ContextDetailModal from './ContextDetailModal';

/**
 * 上下文使用指示器：圆环显示占比，左侧显示输入/输出 token 数与上下文大小。
 * 点击展开上下文详情面板（数据来源 pi:getContextDetail）。
 * 放在输入框右下角模型选择器左侧。
 */
export default function ContextIndicator() {
  const stats = usePiStore((s) => s.stats);
  const [detailOpen, setDetailOpen] = useState(false);

  // stats 可能为 null（新会话未发消息、或 sessionFile 未就绪）
  // 此时显示 0 状态占位，而不是隐藏，让用户知道指示器存在
  const hasStats = !!stats;
  const percent = hasStats ? Math.min(100, Math.max(0, stats!.contextPercent || 0)) : 0;
  const inputTokens = hasStats ? stats!.tokens.input || 0 : 0;
  const outputTokens = hasStats ? stats!.tokens.output || 0 : 0;
  const usedTokens = hasStats
    ? (stats!.tokens.input || 0) +
      (stats!.tokens.output || 0) +
      (stats!.tokens.cacheRead || 0) +
      (stats!.tokens.cacheWrite || 0)
    : 0;

  // 圆环参数
  const size = 22;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (percent / 100) * circ;

  // 占比颜色：< 50% 绿、< 80% 黄、>= 80% 红（跟随主题变量）
  const varRgb = (k: string) => `rgb(var(--od-${k}))`;
  const color = percent >= 80 ? varRgb('red') : percent >= 50 ? varRgb('yellow') : varRgb('green');

  return (
    <>
      <button
        onClick={() => setDetailOpen(true)}
        className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-od-bg-hover"
        title={`${t.contextUsage}: ${percent.toFixed(0)}% · ${t.contextDetailTitle}`}
      >
        {/* 左侧：token 数 + 上下文大小 */}
        <div
          className={`flex flex-col items-end leading-none font-mono ${hasStats ? '' : 'opacity-40'}`}
        >
          <span className="text-xs text-od-text-dim">
            <span className="text-od-accent" title={t.tokensIn}>
              ↑{fmt(inputTokens)}
            </span>
            <span className="mx-0.5 text-od-border-light">·</span>
            <span className="text-od-green" title={t.tokensOut}>
              ↓{fmt(outputTokens)}
            </span>
          </span>
          <span className="text-xs text-od-text-dim" title={t.contextSize}>
            {fmt(usedTokens)}
          </span>
        </div>

        {/* 圆环 */}
        <svg
          width={size}
          height={size}
          className={`shrink-0 -rotate-90 ${hasStats ? '' : 'opacity-40'}`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={varRgb('border')}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.3s ease, stroke 0.3s ease' }}
          />
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            className="rotate-90"
            style={{
              transformOrigin: 'center',
              fontSize: '8px',
              fill: color,
              fontWeight: 600
            }}
          >
            {Math.round(percent)}
          </text>
        </svg>
      </button>
      {detailOpen && <ContextDetailModal onClose={() => setDetailOpen(false)} />}
    </>
  );
}
