import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../common/Icon';
import Disclosure from '../common/Disclosure';
import MemoryReviewSection from '../chat/MemoryReviewSection';
import { injectionSectionTitle, stripInjectionWrapper } from '../../lib/memory-injection-view';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import type {
  MemoryConfig,
  MemoryExtractionProgress,
  MemoryInjectionSection,
  MemoryStatus
} from '../../types/pi';

/**
 * 记忆工作区（右侧面板的一个标签页）。
 *
 * 为什么不做成聊天头的弹层：记忆是「读 + 审 + 触发」三件事混在一起的界面，
 * 320px 的弹层放不下注入正文（每行只有 ~30 个中文字）、审核候选与失败原因，
 * 而且新加的自动沉淀/索引状态根本没有展示位置。搬到工作区后可拖宽、可与 diff 并存。
 *
 * 三个分段：
 * - 概览：启用状态、自动沉淀、检索索引、失败会话（可展开原因）
 * - 注入：本会话注入串逐段明细（模型实际看到的内容）
 * - 审核：待审核候选 + 记忆检索（复用聊天里的 MemoryReviewSection）
 */
type Segment = 'overview' | 'injection' | 'review';

export default function MemoryWorkspace() {
  const showToast = usePiStore((s) => s.showToast);
  const setSettingsOpen = usePiStore((s) => s.setSettingsOpen);
  const setSettingsTab = usePiStore((s) => s.setSettingsTab);
  const projectRef = useRef('');
  const [segment, setSegment] = useState<Segment>('overview');
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [progress, setProgress] = useState<MemoryExtractionProgress | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextConfig] = await Promise.all([
        window.pi.memory.getStatus(),
        window.pi.memory.getConfig()
      ]);
      projectRef.current = nextStatus.projectId;
      setStatus(nextStatus);
      setConfig(nextConfig);
      setExtracting(nextStatus.busy?.extracting ?? false);
      setConsolidating(nextStatus.busy?.consolidating ?? false);
      setError(null);
      void usePiStore.getState().refreshMemoryPendingReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.pi.onMemoryProgress((p) => {
      if (p.projectId && p.projectId !== projectRef.current) return;
      setProgress(p);
      if (p.phase === 'done') void refresh();
    });
    return off;
  }, [refresh]);

  const openSettings = () => {
    setSettingsTab('memory');
    setSettingsOpen(true);
  };

  const handleExtract = async () => {
    if (extracting) return;
    setExtracting(true);
    setProgress({ kind: 'extraction', phase: 'scan', total: 0, done: 0 });
    try {
      const r = await window.pi.memory.extract();
      if (r.ok && r.result) {
        showToast(t.memory.extractDone(r.result.extracted, r.result.skipped, r.result.failed), {
          variant: 'success'
        });
      } else if (r.error) {
        showToast(t.memory.extractFailed(r.error), { variant: 'error' });
      }
    } catch (e) {
      showToast(t.memory.extractFailed(e instanceof Error ? e.message : String(e)), {
        variant: 'error'
      });
    } finally {
      setExtracting(false);
      setProgress(null);
      void refresh();
    }
  };

  const handleConsolidate = async () => {
    if (consolidating) return;
    setConsolidating(true);
    try {
      const r = await window.pi.memory.consolidate();
      if (r.ok) showToast(t.memory.consolidateDone(r.merged), { variant: 'success' });
      else if (r.error) showToast(t.memory.consolidateFailed(r.error), { variant: 'error' });
    } catch (e) {
      showToast(t.memory.consolidateFailed(e instanceof Error ? e.message : String(e)), {
        variant: 'error'
      });
    } finally {
      setConsolidating(false);
      void refresh();
    }
  };

  const handleRebuildIndex = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      await window.pi.memory.reindex();
      showToast(t.memory.indexRebuilt, { variant: 'success' });
      void refresh();
    } catch (e) {
      showToast(t.memory.indexRebuildFailed(e instanceof Error ? e.message : String(e)), {
        variant: 'error'
      });
    } finally {
      setRebuilding(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const busy = extracting || consolidating;
  const pending = status?.pendingExtractions ?? 0;
  const threshold = status?.consolidateThreshold ?? 5;
  const candidates = status?.candidates.length ?? 0;
  const index = status?.index ?? null;
  const injection = status?.injection ?? null;
  const injectionRows = useMemo(
    () =>
      injection?.sections.filter(
        (s) =>
          s.id !== 'context-header' && s.id !== 'context-footer' && (injection.active || !s.fixed)
      ) ?? [],
    [injection]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-od-bg-dark">
      {/* 分段栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-od-border bg-od-bg-alt px-2">
        <SegmentButton active={segment === 'overview'} onClick={() => setSegment('overview')}>
          {t.memory.segOverview}
        </SegmentButton>
        <SegmentButton active={segment === 'injection'} onClick={() => setSegment('injection')}>
          {t.memory.segInjection}
          {injection?.active && (
            <span className="text-od-text-dim">
              {injection.totalChars > 0 ? ` ${t.memory.injectionChars(injection.totalChars)}` : ''}
            </span>
          )}
        </SegmentButton>
        <SegmentButton active={segment === 'review'} onClick={() => setSegment('review')}>
          {t.memory.segReview}
          {candidates > 0 && (
            <span className="rounded-full bg-od-orange/20 px-1.5 text-od-orange">{candidates}</span>
          )}
        </SegmentButton>
        <div className="ml-auto flex items-center gap-1">
          {status?.projectName && (
            <span className="max-w-40 truncate text-xs text-od-text-dim" title={status.projectName}>
              {status.projectName}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.memory.refresh}
          >
            <Icon name="rotate" className="w-3" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[56rem] px-4 py-3">
          {error && (
            <div
              role="alert"
              className="mb-3 rounded border border-od-red/40 px-3 py-2 text-xs text-od-red"
            >
              {error}
            </div>
          )}

          {!enabled && (
            <div className="rounded border border-od-border-light bg-od-bg-alt px-4 py-6 text-center">
              <Icon name="memory" className="mx-auto mb-2 w-5 text-od-text-dim" />
              <div className="text-sm text-od-text-bright">{t.memory.disabledTitle}</div>
              <div className="mt-1 text-xs text-od-text-dim">{t.memory.enabledInSettings}</div>
              <button
                type="button"
                onClick={openSettings}
                className="mt-3 inline-flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover"
              >
                <Icon name="settings" className="w-3" />
                {t.memory.openSettings}
              </button>
            </div>
          )}

          {enabled && segment === 'overview' && status && (
            <div className="space-y-3">
              {/* 不用 sm:grid-cols-2：Tailwind 的 sm: 看的是窗口宽度，右侧面板被拖窄时仍然两列，卡片里就会挤成一团。
                  改成可换行的 flex：每卡基准 19rem，放不下就整张掉到下一行（面板窄时自然变单列）。 */}
              <div className="flex flex-wrap gap-3">
                {/* 状态 */}
                <Card title={t.memory.panelStatus} icon="memory">
                  <Row label={t.memory.statusLabel}>
                    <span className={enabled ? 'text-od-green' : 'text-od-text-dim'}>
                      {enabled ? t.memory.statusOn : t.memory.statusOff}
                    </span>
                  </Row>
                  <Row label={t.memory.pendingLabel}>
                    <span className={pending >= threshold ? 'text-od-orange' : undefined}>
                      {t.memory.pendingValue(pending)}
                    </span>
                  </Row>
                  <Row label={t.memory.processedLabel}>
                    {t.memory.processedValue(status.processedCount)}
                  </Row>
                  <Row label={t.memory.lastConsolidationLabel}>
                    {status.lastConsolidation
                      ? formatTime(status.lastConsolidation)
                      : t.memory.neverConsolidated}
                  </Row>
                  {pending >= threshold && (
                    <div className="text-od-orange">
                      {t.memory.consolidateHint(pending, threshold)}
                    </div>
                  )}
                </Card>

                {/* 本会话注入 */}
                <Card
                  title={t.memory.injectionTitle}
                  icon="info"
                  action={
                    <button
                      type="button"
                      onClick={() => setSegment('injection')}
                      className="text-xs text-od-accent hover:underline"
                    >
                      {t.memory.viewInjection}
                    </button>
                  }
                >
                  <Row label={t.memory.injectedLabel}>
                    {injection?.active ? (
                      <span className="text-od-green">
                        {t.memory.statusInjected} · {t.memory.injectionChars(injection.totalChars)}
                      </span>
                    ) : (
                      <span className="text-od-text-dim">{t.memory.statusNotInjected}</span>
                    )}
                  </Row>
                  {injection?.frozenAt && (
                    <Row label={t.memory.frozenAtLabel}>
                      {t.memory.injectionFrozenAt(formatTime(injection.frozenAt))}
                    </Row>
                  )}
                  <div className="text-od-text-dim">{t.memory.injectionNote}</div>
                </Card>

                {/* 自动沉淀 */}
                <Card
                  title={t.memory.autoSedimentTitle}
                  icon="sparkles"
                  action={
                    <button
                      type="button"
                      onClick={openSettings}
                      className="text-xs text-od-accent hover:underline"
                    >
                      {t.memory.openSettings}
                    </button>
                  }
                >
                  <Row label={t.memory.autoSedimentLabel}>
                    {config?.autoExtract ? (
                      <span className="text-od-green">
                        {t.memory.autoSedimentOn(config.nudgeTurns, config.nudgeToolCalls)}
                      </span>
                    ) : (
                      <span className="text-od-text-dim">{t.memory.autoSedimentOff}</span>
                    )}
                  </Row>
                  <Row label={t.memory.correctionLabel}>
                    {config?.correctionDetect ? t.memory.statusOn : t.memory.statusOff}
                  </Row>
                  <Row label={t.memory.preCompactLabel}>
                    {config?.preCompactFlush ? t.memory.statusOn : t.memory.statusOff}
                  </Row>
                  <div className="text-od-text-dim">{t.memory.autoSedimentNote}</div>
                </Card>

                {/* 检索索引 */}
                <Card
                  title={t.memory.indexSection}
                  icon="find"
                  action={
                    <button
                      type="button"
                      onClick={() => void handleRebuildIndex()}
                      disabled={rebuilding}
                      className="flex items-center gap-1 text-xs text-od-accent hover:underline disabled:opacity-50"
                    >
                      <Icon
                        name={rebuilding ? 'spinner' : 'rotate'}
                        spin={rebuilding}
                        className="w-3"
                      />
                      {rebuilding ? t.memory.indexRebuilding : t.memory.indexRebuild}
                    </button>
                  }
                >
                  <Row label={t.memory.indexEntries}>
                    {index?.available
                      ? t.memory.indexMemoryValue(index.entries, index.files)
                      : t.memory.statusOff}
                  </Row>
                  <Row label={t.memory.indexSessions}>
                    {index?.sessions?.available && index.sessions.entries > 0
                      ? t.memory.indexSessionsValue(index.sessions.entries, index.sessions.files)
                      : t.memory.indexNever}
                  </Row>
                  <Row label={t.memory.indexSize}>
                    {index?.available ? formatBytes(index.bytes) : '—'}
                  </Row>
                  <Row label={t.memory.indexUpdatedLabel}>
                    {index?.indexedAt ? formatTime(index.indexedAt) : t.memory.indexNever}
                  </Row>
                  {index && !index.available && index.error && (
                    <div className="text-od-orange">{t.memory.indexUnavailable(index.error)}</div>
                  )}
                </Card>
              </div>

              {/* 失败会话 */}
              {status.failedCount > 0 && (
                <Card
                  title={t.memory.failedSessionsTitle(status.failedCount)}
                  icon="info"
                  tone="warn"
                  action={
                    <button
                      type="button"
                      onClick={() => void handleExtract()}
                      disabled={busy}
                      className="text-xs text-od-accent hover:underline disabled:opacity-50"
                    >
                      {t.memory.retryFailed}
                    </button>
                  }
                >
                  <div className="space-y-1">
                    {status.failedSessions.map((s) => (
                      <FailedSessionRow key={s.name} name={s.name} at={s.at} reason={s.error} />
                    ))}
                  </div>
                  {status.failedCount > status.failedSessions.length && (
                    <div className="text-od-text-dim">
                      {t.memory.failedSessionsMore(
                        status.failedCount - status.failedSessions.length
                      )}
                    </div>
                  )}
                  <div className="text-od-text-dim">{t.memory.failedSessionsHint}</div>
                </Card>
              )}
            </div>
          )}

          {enabled && segment === 'injection' && injection && (
            <div className="space-y-2">
              {!injection.active && (
                <div className="rounded border border-od-border-light bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
                  {t.memory.injectionInactive}
                </div>
              )}
              {injectionRows.map((section) => (
                <InjectionSectionRow key={section.id} section={section} />
              ))}
              {injection.active && (
                <div className="space-y-1 border-t border-od-border pt-2 text-xs text-od-text-dim">
                  {injection.markerChars > 0 && (
                    <div>{t.memory.injectionMarkerNote(injection.markerChars)}</div>
                  )}
                  <div>{t.memory.injectionNotInjectedNote}</div>
                  {injection.frozenAt && (
                    <div>{t.memory.injectionFrozenAt(formatTime(injection.frozenAt))}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {enabled && segment === 'review' && status && (
            <MemoryReviewSection key={status.projectId} status={status} onChanged={refresh} />
          )}
        </div>
      </div>

      {/* 动作条（常驻底部，不随内容滚走） */}
      {enabled && (
        <div className="flex shrink-0 items-center gap-2 border-t border-od-border bg-od-bg-alt px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-xs text-od-text-dim">
            {extracting && progress?.phase === 'extract' && progress.total > 0
              ? t.memory.extractingProgress(progress.done, progress.total)
              : extracting
                ? t.memory.extractRunning
                : consolidating
                  ? t.memory.consolidateRunning
                  : t.memory.actionHint(pending, threshold)}
          </div>
          {busy && (
            <button
              type="button"
              onClick={() => void window.pi.memory.cancel()}
              className="rounded border border-od-border px-2 py-1 text-xs text-od-text hover:bg-od-bg-hover"
            >
              {t.memory.cancelJob}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover disabled:opacity-50"
          >
            <Icon name="download" spin={extracting} className="w-3" />
            {t.memory.extractBtn}
          </button>
          <button
            type="button"
            onClick={() => void handleConsolidate()}
            disabled={busy || pending === 0}
            className="flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover disabled:opacity-50"
          >
            <Icon name="compress" spin={consolidating} className="w-3" />
            {t.memory.consolidateBtn}
            {pending > 0 && (
              <span className="rounded-full bg-od-bg-hover px-1.5 text-od-text-dim">{pending}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
        active
          ? 'bg-od-bg-dark text-od-text-bright'
          : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text'
      }`}
    >
      {children}
    </button>
  );
}

function Card({
  title,
  icon,
  action,
  tone,
  children
}: {
  title: string;
  icon: 'memory' | 'info' | 'sparkles' | 'find';
  action?: React.ReactNode;
  tone?: 'warn';
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 basis-[19rem] rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div
          className={`flex items-center gap-1.5 text-xs font-semibold ${
            tone === 'warn' ? 'text-od-orange' : 'text-od-text'
          }`}
        >
          <Icon name={icon} className="w-3" />
          {title}
        </div>
        {action}
      </div>
      <div className="space-y-1 text-xs text-od-text-dim">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="shrink-0 text-od-text-dim">{label}</span>
      <span className="ml-auto min-w-0 max-w-full break-words text-right text-od-text">
        {children}
      </span>
    </div>
  );
}

function FailedSessionRow({ name, at, reason }: { name: string; at: string; reason: string }) {
  return (
    <Disclosure
      title={shortSessionName(name)}
      extra={<span className="truncate">{at ? formatTime(at) : ''}</span>}
    >
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-od-bg-dark px-1.5 py-1 font-mono text-xs leading-relaxed text-od-text">
        {reason || t.memory.failedReasonEmpty}
      </pre>
    </Disclosure>
  );
}

/**
 * 单段注入内容行：展示名 + 来源 + 字符数，点击展开正文（默认展开记忆内容，固定文案折叠）。
 * 注入串里的包裹标签（`<user-profile>` 等）只对模型有意义，这里展示去标签后的正文。
 */
function InjectionSectionRow({ section }: { section: MemoryInjectionSection }) {
  const body = stripInjectionWrapper(section.content);
  return (
    <div className="space-y-0.5">
      <Disclosure
        title={injectionSectionTitle(
          section.id,
          {
            standing: t.memory.sectionStanding,
            profile: t.memory.sectionProfile,
            topics: t.memory.sectionTopics,
            policy: t.memory.sectionPolicy
          },
          section.label
        )}
        extra={
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{section.source}</span>
            <span className="shrink-0">· {t.memory.injectionChars(section.chars)}</span>
          </span>
        }
        disabled={!section.included}
        defaultOpen={section.id !== 'policy'}
      >
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-od-bg-dark px-2 py-1.5 font-mono text-xs leading-relaxed text-od-text">
          {body || t.memory.injectionEmpty}
        </pre>
        {section.truncated && (
          <div className="px-1 text-od-orange">
            {t.memory.injectionTruncated(section.originalChars ?? 0)}
          </div>
        )}
      </Disclosure>
      {!section.included && <div className="pl-4 text-od-text-dim">{t.memory.injectionEmpty}</div>}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 会话文件名 → 短标签：`2026-09-29T14-52-27-370Z_<uuid>.jsonl` → `2026-09-29 22:52 · 01a0eda7`
 * （时间戳部分按 UTC 解析后转本地展示，与面板其余时间一致）；无法识别时按长度截断。
 */
function shortSessionName(name: string): string {
  const base = name.replace(/\.jsonl$/, '');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d+Z_?(.*)$/.exec(base);
  if (!m) return base.length > 30 ? `${base.slice(0, 30)}…` : base;
  const label = formatTime(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  const id = (m[5] ?? '').slice(0, 8);
  return id ? `${label} · ${id}` : label;
}
