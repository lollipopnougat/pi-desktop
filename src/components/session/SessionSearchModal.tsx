import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { usePiStore } from '../../store/pi-store';
import {
  buildSessionSearchIndex,
  searchSessionIndex,
  sessionSearchSnippet,
  type SearchProject,
  type SearchSession
} from '../../utils/session-search';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

interface SessionSearchModalProps {
  onClose: () => void;
  onSelect: (session: SessionInfo) => void;
}

type SearchResult =
  | { type: 'project'; project: SearchProject; entry: SearchSession }
  | { type: 'session'; entry: SearchSession; snippet: string };

export default function SessionSearchModal({ onClose, onSelect }: SessionSearchModalProps) {
  const cwd = usePiStore((state) => state.cwd);
  const sessionFile = usePiStore((state) => state.sessionFile);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(12);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const deferredQuery = useDeferredValue(query);
  const pending = query !== deferredQuery;
  const index = useMemo(() => buildSessionSearchIndex(sessions), [sessions]);
  const matches = useMemo(() => searchSessionIndex(index, deferredQuery), [index, deferredQuery]);
  const projectCount = Math.min(matches.projects.length, Math.ceil(limit / 2));
  const sessionCount = Math.min(matches.sessions.length, limit);
  const results = useMemo<SearchResult[]>(
    () => [
      ...matches.projects.slice(0, projectCount).map((project): SearchResult => ({
        type: 'project',
        project,
        entry: project.latestSession
      })),
      ...matches.sessions.slice(0, sessionCount).map((entry): SearchResult => ({
        type: 'session',
        entry,
        snippet: sessionSearchSnippet(entry, deferredQuery)
      }))
    ],
    [matches, projectCount, sessionCount, deferredQuery]
  );
  const selectedIndex = Math.min(activeIndex, results.length - 1);
  const hasMore = matches.projects.length > projectCount || matches.sessions.length > sessionCount;
  const searching = !!deferredQuery.trim();

  useEffect(() => {
    let alive = true;
    // 每次打开只扫描一次；输入关键词不会再次读取会话文件。
    window.pi.listSessions().then(
      (result) => {
        if (!alive) return;
        setSessions(result.all);
        setLoading(false);
      },
      () => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      }
    );
    return () => {
      alive = false;
    };
  }, [request]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, deferredQuery, sessions]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setLimit(12);
    setActiveIndex(0);
  };

  const select = (result: SearchResult) => {
    if (!pending) onSelect(result.entry.session);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法确认候选词时不能触发会话切换。
    if (event.nativeEvent.isComposing || event.keyCode === 229 || pending) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((selectedIndex + delta + results.length) % results.length);
      }
    } else if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      select(results[selectedIndex]);
    }
  };

  const renderResult = (result: SearchResult, itemIndex: number) => {
    const isProject = result.type === 'project';
    const active = itemIndex === selectedIndex;
    const current = isProject
      ? result.project.cwd === cwd
      : result.entry.session.path === sessionFile;
    const title = isProject ? result.project.name : result.entry.title;
    const detail = isProject ? result.project.cwd : result.entry.projectName;
    const snippet = isProject ? '' : result.snippet;
    return (
      <button
        key={isProject ? `project:${result.project.cwd}` : result.entry.session.path}
        id={`${listId}-${itemIndex}`}
        ref={active ? activeRef : undefined}
        type="button"
        role="option"
        aria-selected={active}
        aria-current={current ? 'true' : undefined}
        tabIndex={-1}
        disabled={pending}
        onMouseEnter={() => setActiveIndex(itemIndex)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => select(result)}
        title={isProject ? t.sessionSearch.openProject(detail) : title}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
          active ? 'bg-od-bg-hover text-od-text-bright' : 'text-od-text hover:bg-od-bg-hover'
        }`}
      >
        <span className="flex w-4 shrink-0 items-center justify-center">
          <Icon
            name={current ? 'circle' : isProject ? 'folder' : 'comment'}
            className={current ? 'w-1.5 text-od-accent' : 'w-3 text-od-text-dim'}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span
              className={`truncate text-xs text-od-text-dim ${isProject ? 'max-w-[40%]' : 'max-w-[25%]'}`}
              title={detail}
            >
              {detail}
            </span>
          </span>
          {snippet && (
            <span className="mt-1 block truncate text-xs text-od-text-dim">{snippet}</span>
          )}
        </span>
        <kbd
          aria-hidden="true"
          className={`shrink-0 rounded-md border border-od-border-light px-1.5 py-0.5 text-xs text-od-text-dim ${active ? '' : 'invisible'}`}
        >
          {t.sessionSearch.openKey}
        </kbd>
      </button>
    );
  };

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="fixed inset-0 z-[100] flex flex-col items-center bg-black/45 px-6 pb-6"
      style={{ paddingTop: 'max(54px, 10vh)', WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <Modal className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-od-border-light bg-od-bg-alt shadow-2xl">
        <Dialog
          aria-label={t.sessionSearch.title}
          className="flex max-h-[38rem] min-h-0 flex-col outline-none"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-od-border px-5 py-4">
            <Icon name="search" className="w-4 shrink-0 text-od-text-dim" />
            <input
              ref={inputRef}
              autoFocus
              role="combobox"
              aria-label={t.sessionSearch.title}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t.sessionSearch.placeholder}
              className="min-w-0 flex-1 bg-transparent text-base text-od-text-bright outline-none placeholder:text-od-text-dim focus:shadow-none"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label={t.sessionSearch.close}
              title={t.sessionSearch.close}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
            >
              <Icon name="close" className="w-3" />
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
            {loading ? (
              <div
                role="status"
                className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-od-text-dim"
              >
                <Icon name="spinner" spin className="w-4" />
                {t.sessionSearch.loading}
              </div>
            ) : failed ? (
              <div
                role="alert"
                className="flex flex-col items-center gap-3 px-4 py-12 text-sm text-od-text-dim"
              >
                <span>{t.sessionSearch.loadFailed}</span>
                <button
                  type="button"
                  onClick={() => {
                    setFailed(false);
                    setLoading(true);
                    setRequest((value) => value + 1);
                  }}
                  className="rounded-md px-3 py-1 text-od-accent hover:bg-od-bg-hover"
                >
                  {t.sessionSearch.retry}
                </button>
              </div>
            ) : null}
            <div
              id={listId}
              role="listbox"
              aria-label={t.sessionSearch.results}
              aria-busy={loading || pending}
            >
              {projectCount > 0 && (
                <div role="group" aria-labelledby={`${listId}-projects`}>
                  <div
                    id={`${listId}-projects`}
                    className="px-10 pb-1 pt-3 text-xs text-od-text-dim"
                  >
                    {searching ? t.sessionSearch.projects : t.sessionSearch.recentProjects}
                  </div>
                  {results.slice(0, projectCount).map(renderResult)}
                </div>
              )}
              {sessionCount > 0 && (
                <div role="group" aria-labelledby={`${listId}-sessions`}>
                  <div
                    id={`${listId}-sessions`}
                    className="px-10 pb-1 pt-4 text-xs text-od-text-dim"
                  >
                    {searching ? t.sessionSearch.sessions : t.sessionSearch.recentSessions}
                  </div>
                  {results
                    .slice(projectCount)
                    .map((result, offset) => renderResult(result, projectCount + offset))}
                </div>
              )}
            </div>
            {!loading && !failed && !results.length && (
              <div role="status" className="px-4 py-12 text-center text-sm text-od-text-dim">
                {searching ? t.sessionSearch.noResults : t.sessionSearch.empty}
              </div>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => setLimit((value) => value + 24)}
                className="mt-2 w-full rounded-lg py-2 text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
              >
                {t.sessionSearch.showMore}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-4 border-t border-od-border px-5 py-2.5 text-xs text-od-text-dim">
            <span>{t.sessionSearch.keyboardHint}</span>
            <span>{t.sessionSearch.closeHint}</span>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
