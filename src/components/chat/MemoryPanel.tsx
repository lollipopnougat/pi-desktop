import { useEffect, useState, useCallback, useRef } from 'react';
import Icon from '../common/Icon';
import Disclosure from '../common/Disclosure';
import MemoryReviewSection from './MemoryReviewSection';
import { injectionSectionTitle, stripInjectionWrapper } from '../../lib/memory-injection-view';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import type {
  MemoryStatus,
  MemoryExtractionProgress,
  MemoryInjectionSection
} from '../../types/pi';

/**
 * 记忆面板（ChatHeader memory 按钮弹层）：
 * - 记忆系统状态（启用/注入/待合并提取/上次合并时间）
 * - 「从此项目会话提取」手动触发 Phase1
 * - 「合并记忆」手动触发 Phase2
 * - 提取进度实时展示（pi:memoryProgress 推送）
 */
export default function MemoryPanel({ onClose }: { onClose: () => void }) {
  const cwd = usePiStore((s) => s.cwd);
  const showToast = usePiStore((s) => s.showToast);
  const projectRef = useRef('');
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [progress, setProgress] = useState<MemoryExtractionProgress | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await window.pi.memory.getStatus();
      projectRef.current = s.projectId;
      setStatus(s);
      setExtracting(s.busy?.extracting ?? false);
      setConsolidating(s.busy?.consolidating ?? false);
    } catch {}
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.pi.onMemoryProgress((p) => {
      if (p.projectId && p.projectId !== projectRef.current) return;
      setProgress(p);
      if (p.phase === 'done') {
        refresh();
      }
    });
    return off;
  }, [refresh, cwd]);

  const notify = (msg: string, ok: boolean) => {
    showToast(msg, { variant: ok ? 'success' : 'error' });
  };

  const handleExtract = async () => {
    if (extracting) return;
    setExtracting(true);
    setProgress({ kind: 'extraction', phase: 'scan', total: 0, done: 0 });
    try {
      const r = await window.pi.memory.extract();
      if (r.ok && r.result) {
        notify(t.memory.extractDone(r.result.extracted, r.result.skipped, r.result.failed), true);
      } else if (r.error) {
        notify(t.memory.extractFailed(r.error), false);
      }
    } catch (e: any) {
      notify(t.memory.extractFailed(String(e?.message || e)), false);
    } finally {
      setExtracting(false);
      setProgress(null);
      refresh();
    }
  };

  const handleConsolidate = async () => {
    if (consolidating) return;
    setConsolidating(true);
    try {
      const r = await window.pi.memory.consolidate();
      if (r.ok) {
        notify(t.memory.consolidateDone(r.merged), true);
      } else if (r.error) {
        notify(t.memory.consolidateFailed(r.error), false);
      }
    } catch (e: any) {
      notify(t.memory.consolidateFailed(String(e?.message || e)), false);
    } finally {
      setConsolidating(false);
      refresh();
    }
  };

  const enabled = status?.enabled ?? false;
  const busy = extracting || consolidating;
  const threshold = status?.consolidateThreshold ?? 5;
  const pending = status?.pendingExtractions ?? 0;
  const injection = status?.injection ?? null;
  // 固定头/尾标记不单独成行；未注入时只列出记忆文件行（固定文案行无信息量）
  const injectionRows =
    injection?.sections.filter(
      (s) =>
        s.id !== 'context-header' && s.id !== 'context-footer' && (injection.active || !s.fixed)
    ) ?? [];

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-full z-40 mt-1 w-80 rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl">
        <div className="flex items-center justify-between border-b border-od-border px-3 py-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="memory" className="w-3.5 text-od-accent" />
            {t.memory.panelTitle}
          </div>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="close" size="xs" />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-3 py-2.5 text-xs">
          {status && (
            <MemoryReviewSection key={status.projectId} status={status} onChanged={refresh} />
          )}
          {busy && (
            <button
              onClick={() => window.pi.memory.cancel()}
              className="rounded border border-od-border px-2 py-1 text-od-text"
            >
              {t.memory.cancelJob}
            </button>
          )}
          {/* 状态区 */}
          <div className="space-y-1 text-od-text-dim">
            <div className="flex items-center justify-between">
              <span>{t.memory.panelStatus}</span>
              <span className={enabled ? 'text-od-green' : 'text-od-text-dim'}>
                {enabled ? t.memory.statusOn : t.memory.statusOff}
              </span>
            </div>
            {enabled && status && (
              <>
                <div className="flex items-center justify-between">
                  <span>{t.memory.injectedLabel}</span>
                  <span>
                    {status.injected
                      ? `${t.memory.statusInjected} · ${t.memory.injectionChars(status.injection.totalChars)}`
                      : t.memory.statusNotInjected}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t.memory.pendingExtractions(pending)}</span>
                  {pending >= threshold && (
                    <span className="text-od-orange">
                      {t.memory.consolidateHint(pending, threshold)}
                    </span>
                  )}
                </div>
                {status.lastConsolidation && (
                  <div className="flex items-center justify-between">
                    <span>{t.memory.lastConsolidation(formatTime(status.lastConsolidation))}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span>{t.memory.processedSessions(status.processedCount)}</span>
                </div>
              </>
            )}
          </div>

          {/* 本会话注入明细（分段 + 来源标注） */}
          {enabled && injection && (
            <div className="space-y-1 rounded border border-od-border-light px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-od-text">
                <span className="flex items-center gap-1">
                  <Icon name="memory" className="w-3 text-od-accent" />
                  {t.memory.injectionTitle}
                </span>
                {injection.active && (
                  <span className="text-od-text-dim">
                    {t.memory.injectionChars(injection.totalChars)}
                  </span>
                )}
              </div>

              {!injection.active && (
                <div className="text-od-text-dim">{t.memory.injectionInactive}</div>
              )}

              {injectionRows.map((section) => (
                <InjectionSectionRow key={section.id} section={section} />
              ))}

              {injection.active && (
                <div className="space-y-0.5 border-t border-od-border pt-1 text-od-text-dim">
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

          {/* 提取失败的会话（点提取会重试） */}
          {enabled && status && status.failedCount > 0 && (
            <div className="space-y-1 rounded border border-od-border-light px-2 py-1.5">
              <div className="flex items-center gap-1 text-od-orange">
                <Icon name="info" className="w-3" />
                {t.memory.failedSessionsTitle(status.failedCount)}
              </div>
              <div className="space-y-0.5 text-od-text-dim">
                {status.failedSessions.map((s) => (
                  <div key={s.name} className="truncate" title={`${s.name}\n${s.error}`}>
                    <span className="text-od-text">{shortSessionName(s.name)}</span> · {s.error}
                  </div>
                ))}
              </div>
              {status.failedCount > status.failedSessions.length && (
                <div className="text-od-text-dim">
                  {t.memory.failedSessionsMore(status.failedCount - status.failedSessions.length)}
                </div>
              )}
              <div className="text-od-text-dim">{t.memory.failedSessionsHint}</div>
            </div>
          )}

          {/* 操作区 */}
          {enabled ? (
            <div className="space-y-1.5 pt-1">
              <button
                onClick={handleExtract}
                disabled={busy}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-od-border-light px-2 py-1.5 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:opacity-50"
              >
                {extracting ? (
                  <Icon name="spinner" spin className="w-3" />
                ) : (
                  <Icon name="download" className="w-3" />
                )}
                {extracting ? t.memory.extractRunning : t.memory.extractBtn}
              </button>
              {extracting && progress && progress.phase === 'extract' && progress.total > 0 && (
                <div className="flex items-center gap-1.5 text-od-text-dim">
                  <Icon name="spinner" spin className="w-3" />
                  {t.memory.extractingProgress(progress.done, progress.total)}
                  {progress.current && (
                    <span className="truncate">· {progress.current.slice(0, 24)}</span>
                  )}
                </div>
              )}
              <button
                onClick={handleConsolidate}
                disabled={busy || pending === 0}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-od-border-light px-2 py-1.5 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:opacity-50"
              >
                {consolidating ? (
                  <Icon name="spinner" spin className="w-3" />
                ) : (
                  <Icon name="compress" className="w-3" />
                )}
                {consolidating ? t.memory.consolidateRunning : t.memory.consolidateBtn}
              </button>
            </div>
          ) : (
            <div className="rounded border border-od-border-light px-2 py-1.5 text-center text-od-text-dim">
              {t.memory.enabledInSettings}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
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
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-od-bg-dark px-1.5 py-1 font-mono text-xs leading-relaxed text-od-text">
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
