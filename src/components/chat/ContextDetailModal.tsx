import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { formatTokens as fmt } from '../../utils/format';
import { usePiStore } from '../../store/pi-store';

/** 估算 token（与 SDK 的 estimateTokens 保持同一思路：chars/4） */
function estimateTokens(msg: any): number {
  let chars = 0;
  const content = msg?.content;
  if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && block.text) chars += block.text.length;
      else if (block?.type === 'thinking' && block.thinking) chars += block.thinking.length;
      else if (block?.type === 'toolCall') {
        chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
      } else if (block?.type === 'image') {
        chars += 4800;
      }
    }
  } else if (msg?.role === 'bashExecution') {
    chars = (msg.command?.length ?? 0) + (msg.output?.length ?? 0);
  } else if (msg?.role === 'compactionSummary' || msg?.role === 'branchSummary') {
    chars = msg.summary?.length ?? 0;
  } else if (msg?.role === 'custom') {
    chars =
      typeof msg.content === 'string'
        ? msg.content.length
        : JSON.stringify(msg.content ?? '').length;
  }
  return Math.ceil(chars / 4);
}

interface BreakdownRow {
  label: string;
  count: number;
  tokens: number;
  color: string;
}

interface RecentRow {
  role: string;
  preview: string;
  tokens: number;
}

function messagePreview(msg: any): string {
  const content = msg?.content;
  if (typeof content === 'string') return content.slice(0, 80);
  if (Array.isArray(content)) {
    const text = content.find((b) => b?.type === 'text')?.text;
    if (text) return String(text).slice(0, 80);
    const tc = content.find((b) => b?.type === 'toolCall');
    if (tc) return `[${tc.name}]`;
  }
  if (msg?.role === 'bashExecution') return msg.command?.slice(0, 80) ?? '';
  if (msg?.role === 'compactionSummary' || msg?.role === 'branchSummary')
    return msg.summary?.slice(0, 80) ?? '';
  return msg?.role ?? '';
}

type ContextDetailData = Awaited<ReturnType<typeof window.pi.getContextDetail>>;

export default function ContextDetailModal({ onClose }: { onClose: () => void }) {
  const isMac = window.pi?.platform === 'darwin';
  const [data, setData] = useState<ContextDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 轮询与手动刷新可能重叠：只认最后一次请求的结果
  const requestRef = useRef(0);
  const aliveRef = useRef(true);

  // mode：initial=首次拉取（错误铺满面板）；silent=自动刷新（失败保留旧内容）；
  // manual=用户点刷新（转圈提示，只在点击时给反馈，2.5s 轮询不闪）
  const load = useCallback(async (mode: 'initial' | 'silent' | 'manual') => {
    const id = ++requestRef.current;
    if (mode === 'manual') setRefreshing(true);
    try {
      const d = await window.pi.getContextDetail();
      if (!aliveRef.current || id !== requestRef.current) return;
      setData(d);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e: any) {
      if (!aliveRef.current || id !== requestRef.current) return;
      // 静默刷新失败保留已有内容，只有首次加载才把错误铺满面板
      if (mode === 'initial') setError(e?.message || t.contextDetailLoadFailed);
    } finally {
      if (aliveRef.current && id === requestRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    // 微任务里发起首次拉取：避免「在 effect 体内同步 setState」的级联渲染告警
    void Promise.resolve().then(() => load('initial'));
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // 面板打开期间跟随会话状态刷新：stats / sessionVersion 只在「一次 run 结算」时变化，
  // 所以面板不会一直陈旧，也不需要额外开销（首次挂载已由上面的 initial 拉取覆盖）。
  const stats = usePiStore((s) => s.stats);
  const sessionVersion = usePiStore((s) => s.sessionVersion);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const autoSkipFirstRef = useRef(true);
  useEffect(() => {
    if (autoSkipFirstRef.current) {
      autoSkipFirstRef.current = false;
      return;
    }
    void load('silent');
  }, [stats, sessionVersion, load]);

  // 流式期间数字在动：2.5s 轮询一次（关掉面板即停）；主进程侧 getSessionStats 只遍历内存 entries，很轻
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => void load('silent'), 2500);
    return () => clearInterval(timer);
  }, [isStreaming, load]);

  // ====== 组成明细 ======
  const breakdown: BreakdownRow[] = useMemo(() => {
    if (!data) return [];
    const sysTokens = Math.ceil((data.systemPrompt?.length ?? 0) / 4);
    const rows: Record<string, { count: number; tokens: number }> = {
      user: { count: 0, tokens: 0 },
      assistant: { count: 0, tokens: 0 },
      toolCall: { count: 0, tokens: 0 },
      toolResult: { count: 0, tokens: 0 },
      other: { count: 0, tokens: 0 }
    };
    for (const m of data.messages) {
      const tk = estimateTokens(m);
      const role = m?.role;
      if (role === 'user') {
        rows.user.count++;
        rows.user.tokens += tk;
      } else if (role === 'assistant') {
        rows.assistant.count++;
        rows.assistant.tokens += tk;
      } else if (role === 'toolResult') {
        rows.toolResult.count++;
        rows.toolResult.tokens += tk;
      } else {
        rows.other.count++;
        rows.other.tokens += tk;
      }
      // assistant 里的 toolCall 单独统计
      if (role === 'assistant' && Array.isArray(m?.content)) {
        for (const b of m.content) {
          if (b?.type === 'toolCall') {
            const t = ((b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length) / 4;
            rows.toolCall.count++;
            rows.toolCall.tokens += Math.ceil(t);
          }
        }
      }
    }
    const v = (k: string) => `rgb(var(--od-${k}))`;
    return [
      { label: t.contextDetailSystemPrompt, count: 1, tokens: sysTokens, color: v('accent') },
      { label: t.contextDetailUser, ...rows.user, color: v('green') },
      { label: t.contextDetailAssistant, ...rows.assistant, color: v('purple') },
      { label: t.contextDetailToolCalls, ...rows.toolCall, color: v('yellow') },
      { label: t.contextDetailToolResults, ...rows.toolResult, color: v('cyan') },
      { label: t.contextDetailOther, ...rows.other, color: v('text-dim') }
    ].filter((r) => r.count > 0 || r.label === t.contextDetailSystemPrompt);
  }, [data]);

  // ====== 最近消息 top8 ======
  const recentTop: RecentRow[] = useMemo(() => {
    if (!data) return [];
    return [...data.messages]
      .map((m) => ({
        role: m?.role ?? 'unknown',
        preview: messagePreview(m),
        tokens: estimateTokens(m)
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);
  }, [data]);

  const totalEstimated = useMemo(() => breakdown.reduce((s, r) => s + r.tokens, 0), [breakdown]);

  const percent = data?.contextUsage?.percent ?? null;
  const used = data?.contextUsage?.tokens ?? null;
  const win = data?.contextUsage?.contextWindow ?? data?.contextWindow ?? null;

  // 缓存命中率 = cacheRead / (input + cacheRead)
  const cacheHitRate = useMemo(() => {
    if (!data?.tokens) return null;
    const inp = data.tokens.input ?? 0;
    const cr = data.tokens.cacheRead ?? 0;
    if (inp + cr === 0) return null;
    return ((cr / (inp + cr)) * 100).toFixed(1);
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center bg-black/60"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 w-full max-w-2xl flex-1 flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="info" className="w-3.5 text-od-accent" />
            {t.contextDetailTitle}
            {data?.model && (
              <span className="ml-2 font-normal text-xs text-od-text-dim">
                {data.model.provider}/{data.model.id}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {updatedAt && (
              <span className="text-xs text-od-text-dim">
                {t.contextDetailUpdatedAt(
                  updatedAt.toLocaleTimeString('zh-CN', { hour12: false })
                )}
              </span>
            )}
            <button
              onClick={() => void load('manual')}
              disabled={refreshing}
              title={t.contextDetailRefresh}
              className="text-od-text-dim hover:text-od-text-bright disabled:opacity-60"
            >
              <Icon name={refreshing ? 'spinner' : 'refresh'} spin={refreshing} size="sm" />
            </button>
            <button onClick={onClose} className="text-od-text-dim hover:text-od-text-bright">
              <Icon name="close" size="sm" />
            </button>
          </div>
        </div>

        {error ? (
          <div className="flex flex-1 items-center justify-center text-xs text-od-red">{error}</div>
        ) : !data ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-od-text-dim">
            <Icon name="spinner" spin className="w-3" />
            {t.contextDetailLoading}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 text-xs">
            {/* 使用情况 */}
            <div className="mb-4">
              <h3 className="mb-2 text-xs font-semibold text-od-text">{t.contextDetailUsage}</h3>
              <div className="space-y-2 rounded border border-od-border bg-od-bg-dark p-3">
                <div className="flex items-center justify-between">
                  <span className="text-od-text-dim">{t.contextDetailUsed}</span>
                  <span className="font-mono text-od-text-bright">
                    {used !== null ? fmt(used) : '--'}
                    {win ? ` / ${fmt(win)}` : ''}
                    {percent !== null && (
                      <span
                        className={`ml-2 ${percent >= 80 ? 'text-od-red' : percent >= 50 ? 'text-od-yellow' : 'text-od-green'}`}
                      >
                        {percent.toFixed(0)}%
                      </span>
                    )}
                  </span>
                </div>
                {/* 进度条 */}
                <div className="h-1.5 overflow-hidden rounded-full bg-od-bg-hover">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, percent ?? 0)}%`,
                      background:
                        (percent ?? 0) >= 80
                          ? 'rgb(var(--od-red))'
                          : (percent ?? 0) >= 50
                            ? 'rgb(var(--od-yellow))'
                            : 'rgb(var(--od-green))'
                    }}
                  />
                </div>
                {/* 统计 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-od-text-dim">
                  <span>
                    {t.contextDetailMessagesLabel}: {data.totalMessages}
                  </span>
                  <span>
                    {t.tokensIn}: {fmt(data.tokens?.input ?? 0)} · {t.tokensOut}:{' '}
                    {fmt(data.tokens?.output ?? 0)}
                  </span>
                  {cacheHitRate !== null && (
                    <span>
                      {t.contextDetailCacheHit}: {cacheHitRate}%
                    </span>
                  )}
                  {data.cost !== null && (
                    <span>
                      {t.contextDetailCost}: ${data.cost.toFixed(4)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 组成明细 */}
            <div className="mb-4">
              <h3 className="mb-2 text-xs font-semibold text-od-text">
                {t.contextDetailComposition}
                <span className="ml-1 font-normal text-od-text-dim">
                  ({t.contextDetailEstimated} · 共 {fmt(totalEstimated)})
                </span>
              </h3>
              <div className="space-y-1">
                {breakdown.map((row) => {
                  const pct = totalEstimated > 0 ? (row.tokens / totalEstimated) * 100 : 0;
                  return (
                    <div
                      key={row.label}
                      className="flex items-center gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-sm"
                        style={{ background: row.color }}
                      />
                      <span className="w-28 shrink-0 text-od-text">{row.label}</span>
                      <span className="w-14 shrink-0 text-right font-mono text-od-text-dim">
                        {row.count}
                        {row.label !== t.contextDetailSystemPrompt ? ' 条' : ''}
                      </span>
                      <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-od-bg-hover">
                        <div
                          className="h-full"
                          style={{ width: `${pct}%`, background: row.color }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right font-mono text-od-text-bright">
                        {fmt(row.tokens)}
                      </span>
                      <span className="w-10 shrink-0 text-right font-mono text-od-text-dim">
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 最近消息 top8 */}
            <div className="mb-2">
              <h3 className="mb-2 text-xs font-semibold text-od-text">
                {t.contextDetailRecentMessages}
                <span className="ml-1 font-normal text-od-text-dim">
                  ({t.contextDetailRecentHint})
                </span>
              </h3>
              <div className="space-y-1">
                {recentTop.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                  >
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${
                        m.role === 'user'
                          ? 'bg-od-green/20 text-od-green'
                          : m.role === 'assistant'
                            ? 'bg-od-purple/20 text-od-purple'
                            : m.role === 'toolResult'
                              ? 'bg-od-accent/20 text-od-accent'
                              : 'bg-od-bg-hover text-od-text-dim'
                      }`}
                    >
                      {m.role}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-od-text-dim">
                      {m.preview || '(empty)'}
                    </span>
                    <span className="shrink-0 font-mono text-od-text-bright">{fmt(m.tokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
