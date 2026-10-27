import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { diffLines } from 'diff';
import Icon from '../common/Icon';
import Disclosure from '../common/Disclosure';
import { t } from '../../i18n/zh';
import type {
  MemoryCandidate,
  MemoryStatus,
  MemorySearchHit,
  MemoryEntryDetail
} from '../../types/pi';

/** 设置与聊天面板共用的候选、来源和历史入口。审核始终绑定生成时的项目。 */
export default function MemoryReviewSection({
  status,
  onChanged
}: {
  status: MemoryStatus;
  onChanged: () => void;
}) {
  const [candidate, setCandidate] = useState<MemoryCandidate | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[]>([]);
  const [entry, setEntry] = useState<MemoryEntryDetail | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!candidate) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        setCandidate(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [candidate, busy]);

  const openCandidate = (next: MemoryCandidate) => {
    setCandidate(next);
    setEdits({});
    setError('');
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const review = (accept: boolean) =>
    perform(async () => {
      if (!candidate) return;
      await window.pi.memory.review(candidate.id, candidate.projectId, accept, edits);
      setCandidate(null);
    });

  return (
    <div className="space-y-2 text-xs">
      <div className="text-od-text-dim">
        {t.memory.scopeProject} · {status.projectName}
      </div>
      {error && !candidate && (
        <p role="alert" className="whitespace-pre-wrap text-od-red">
          {error}
        </p>
      )}
      <Disclosure title={t.memory.candidatesTitle(status.candidates.length)} indent>
        <p className="my-1 text-od-text-dim">{t.memory.candidateHint}</p>
        {status.candidates.map((c) => (
          <button
            key={c.id}
            disabled={busy}
            onClick={() => openCandidate(c)}
            className="my-1 block w-full rounded border border-od-border px-2 py-1 text-left text-od-text hover:bg-od-bg-hover"
          >
            {t.memory.reason(c.reason)} · {new Date(c.createdAt).toLocaleString()} ·{' '}
            {t.memory.changedFiles(c.changes.length)}
          </button>
        ))}
      </Disclosure>
      <Disclosure title={t.memory.searchSources} indent>
        <form
          className="my-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              setHits(await window.pi.memory.search(query));
              setSearched(true);
              setEntry(null);
            });
          }}
        >
          <input
            aria-label={t.memory.searchSources}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-od-border bg-od-bg px-2 py-1 text-od-text"
          />
          <button
            disabled={busy || !query.trim()}
            className="rounded border border-od-border px-2 text-od-text"
          >
            {t.memory.searchBtn}
          </button>
        </form>
        {searched && !hits.length && <p className="text-od-text-dim">{t.memory.searchEmpty}</p>}
        {hits.map((hit) => (
          <button
            key={`${hit.file}:${hit.id}`}
            className="my-1 block w-full rounded border border-od-border p-2 text-left text-od-text hover:bg-od-bg-hover"
            onClick={() =>
              void perform(async () => setEntry(await window.pi.memory.readEntry(hit.id)))
            }
          >
            <span className="block text-od-text-dim">
              {hit.scope === 'project' ? t.memory.scopeProject : t.memory.scopeGlobal} ·{' '}
              {hit.created || t.memory.unknownDate} · {t.memory.evidenceStatus(hit.status)}
            </span>
            {hit.text.slice(0, 200)}
          </button>
        ))}
        {entry && (
          <div className="space-y-2 rounded border border-od-border p-2">
            <p className="whitespace-pre-wrap text-od-text">{entry.text}</p>
            <p className="text-od-text-dim">{t.memory.sourceHint}</p>
            {!entry.sources.length && <p className="text-od-text-dim">{t.memory.noSource}</p>}
            {entry.sources.map((source) => (
              <Disclosure
                key={source.id}
                truncate={false}
                title={`${source.session || source.id} · ${source.sourceTime || t.memory.unknownDate}`}
              >
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-od-text">
                  {source.content}
                </pre>
              </Disclosure>
            ))}
          </div>
        )}
      </Disclosure>
      <Disclosure title={t.memory.historyTitle} indent>
        <p className="my-1 text-od-text-dim">{t.memory.rollbackHint}</p>
        {status.history.map((h) => (
          <button
            key={h.id}
            disabled={busy || !status.enabled}
            onClick={() =>
              void perform(async () =>
                openCandidate(await window.pi.memory.rollback(h.id, status.projectId))
              )
            }
            className="my-1 block w-full rounded border border-od-border px-2 py-1 text-left text-od-text hover:bg-od-bg-hover"
          >
            {new Date(h.at).toLocaleString()} · {t.memory.reason(h.reason)} ·{' '}
            {t.memory.previewRollback}
          </button>
        ))}
      </Disclosure>
      {!!status.legacyProjects.length && (
        <Disclosure title={t.memory.legacyTitle} tone="warning" indent>
          <p className="my-1 text-od-text-dim">{t.memory.legacyHint}</p>
          {status.legacyProjects.map((name) => (
            <button
              key={name}
              disabled={busy || !status.enabled}
              onClick={() =>
                void perform(async () =>
                  openCandidate(await window.pi.memory.migrateLegacy(name, status.projectId))
                )
              }
              className="my-1 block rounded border border-od-border px-2 py-1 text-od-text"
            >
              {t.memory.previewMigration(name)}
            </button>
          ))}
        </Disclosure>
      )}
      {status.unassignedExtractions > 0 && (
        <p className="text-od-orange">
          {t.memory.unassignedExtractions(status.unassignedExtractions)}
        </p>
      )}
      {candidate &&
        createPortal(
          <div
            className="fixed inset-0 z-[120] flex flex-col bg-black/50"
            style={{ paddingTop: window.pi.platform === 'darwin' ? 38 : 32 }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t.memory.reviewTitle}
              className="mx-auto my-5 flex min-h-0 w-[min(960px,94vw)] flex-1 flex-col rounded-lg border border-od-border bg-od-bg-alt shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-od-border px-4 py-3 text-od-text-bright">
                <span>
                  {t.memory.reviewTitle} · {t.memory.reason(candidate.reason)}
                </span>
                <button
                  disabled={busy}
                  aria-label={t.memory.closeReview}
                  onClick={() => setCandidate(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <p className="text-xs text-od-text-dim">{t.memory.reviewHint}</p>
                {!!candidate.warnings.length && (
                  <p className="text-sm text-od-orange">
                    {t.memory.largeDeletionWarning(candidate.warnings.join(', '))}
                  </p>
                )}
                {error && (
                  <p role="alert" className="whitespace-pre-wrap text-sm text-od-red">
                    {error}
                  </p>
                )}
                {candidate.changes.map((change) => (
                  <div key={change.file} className="space-y-2">
                    <div className="break-all text-sm font-semibold text-od-text-bright">
                      {change.file}
                    </div>
                    <pre className="max-h-56 overflow-auto rounded border border-od-border bg-od-bg p-2 text-xs">
                      {diffLines(change.before, edits[change.file] ?? change.after).map(
                        (part, i) => (
                          <span
                            key={i}
                            className={
                              part.added
                                ? 'text-od-green'
                                : part.removed
                                  ? 'text-od-red'
                                  : 'text-od-text-dim'
                            }
                          >
                            {part.value
                              .split('\n')
                              .map((line, j, lines) =>
                                line || j < lines.length - 1
                                  ? `${part.added ? '+ ' : part.removed ? '- ' : '  '}${line}\n`
                                  : ''
                              )
                              .join('')}
                          </span>
                        )
                      )}
                    </pre>
                    <Disclosure title={t.memory.correctCandidate} indent>
                      <textarea
                        aria-label={t.memory.correctFile(change.file)}
                        value={edits[change.file] ?? change.after}
                        onChange={(e) =>
                          setEdits((prev) => ({ ...prev, [change.file]: e.target.value }))
                        }
                        className="mt-2 h-40 w-full rounded border border-od-border bg-od-bg p-2 font-mono text-xs text-od-text"
                      />
                    </Disclosure>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t border-od-border p-3 text-sm">
                <button
                  disabled={busy || !status.enabled}
                  onClick={() => void review(false)}
                  className="rounded border border-od-border px-3 py-1 text-od-text"
                >
                  {t.memory.rejectCandidate}
                </button>
                <button
                  disabled={busy || !status.enabled}
                  onClick={() => void review(true)}
                  className="rounded bg-od-accent px-3 py-1 text-od-bg disabled:opacity-50"
                >
                  {busy ? t.memory.reviewSaving : t.memory.acceptCandidate}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
