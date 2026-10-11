import { useEffect, useState, useRef } from 'react';
import { usePiStore } from '../../store/pi-store';
import { transitionSession } from '../../hooks/loadSession';
import { confirmStopRunning, abortRunningTurn } from '../../lib/stopRunningConfirm';
import ContextMenu, { type MenuItem } from '../common/ContextMenu';
import PromptModal from '../common/PromptModal';
import ConfirmDialog from '../common/ConfirmDialog';
import ProjectInfoModal from './ProjectInfoModal';
import SessionSearchModal from './SessionSearchModal';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import type { SessionGroup } from '../../types/shared';

type SortMode = 'modified' | 'created' | 'createdAsc' | 'name';

const SORT_MODES: SortMode[] = ['modified', 'created', 'createdAsc', 'name'];

/** 会话排序比较器 */
function compareSession(a: any, b: any, mode: SortMode): number {
  switch (mode) {
    case 'created': {
      const ta = a.created instanceof Date ? a.created.getTime() : new Date(a.created).getTime();
      const tb = b.created instanceof Date ? b.created.getTime() : new Date(b.created).getTime();
      return tb - ta; // 新→旧
    }
    case 'createdAsc': {
      const ta = a.created instanceof Date ? a.created.getTime() : new Date(a.created).getTime();
      const tb = b.created instanceof Date ? b.created.getTime() : new Date(b.created).getTime();
      return ta - tb; // 旧→新
    }
    case 'name': {
      const la = (a.name || a.firstMessage || a.id || a.path || '').toLowerCase();
      const lb = (b.name || b.firstMessage || b.id || b.path || '').toLowerCase();
      return la.localeCompare(lb, 'zh');
    }
    case 'modified':
    default: {
      const ta = a.modified instanceof Date ? a.modified.getTime() : new Date(a.modified).getTime();
      const tb = b.modified instanceof Date ? b.modified.getTime() : new Date(b.modified).getTime();
      return tb - ta; // SDK 默认：最近活动在前
    }
  }
}

export default function SessionSidebar() {
  const sessionId = usePiStore((s) => s.sessionId);
  const cwd = usePiStore((s) => s.cwd);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const sidebarWidth = usePiStore((s) => s.sidebarWidth);
  const setSidebarWidth = usePiStore((s) => s.setSidebarWidth);
  const sidebarOpen = usePiStore((s) => s.sidebarOpen);
  const sessionVersion = usePiStore((s) => s.sessionVersion);
  const showToast = usePiStore((s) => s.showToast);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; session: any } | null>(null);
  const [renameTarget, setRenameTarget] = useState<any | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('modified');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; cwd: string } | null>(
    null
  );
  const [showProjectInfo, setShowProjectInfo] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<any | null>(null);
  const [removing, setRemoving] = useState(false);
  const asideRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const listRequestRef = useRef(0);

  // 当前会话变化时：展开所在分组并滚动到可见区域
  useEffect(() => {
    if (!sessionId) return;
    // 找到会话所在分组并展开
    for (const g of groups) {
      if (g.sessions.some((s) => s.id === sessionId)) {
        if (!expanded[g.cwd]) {
          setExpanded((e) => ({ ...e, [g.cwd]: true }));
        }
        break;
      }
    }
    // 滚动到可见区域
    setTimeout(() => {
      activeItemRef.current?.scrollIntoView({ block: 'nearest' });
    }, 50);
  }, [sessionId, groups]);

  useEffect(() => {
    loadSessions();
  }, [sessionId, cwd, sessionVersion, sortMode]);

  const loadSessions = async () => {
    const request = ++listRequestRef.current;
    try {
      const result = await window.pi.listSessions();
      const all = [...(result.all || [])].sort((a, b) => compareSession(a, b, sortMode));
      const groupMap: Record<string, any[]> = {};
      // 按排序后的顺序分组，分组顺序跟随组内最靠前的会话
      for (const s of all) {
        const dir = s.cwd || 'unknown';
        if (!groupMap[dir]) groupMap[dir] = [];
        groupMap[dir].push(s);
      }
      const gs = Object.entries(groupMap).map(([cwd, sessions]) => ({ cwd, sessions }));
      // 预计算每个项目目录的展示名（跨平台 baseName），避免会话列表显示完整路径
      const named = await Promise.all(
        gs.map(async (g) => ({ ...g, name: await window.pi.baseName(g.cwd) }))
      );
      if (request !== listRequestRef.current) return;
      setGroups(named);

      // Auto-expand current cwd
      const currentCwd = usePiStore.getState().cwd;
      if (currentCwd) {
        setExpanded((e) => ({ ...e, [currentCwd]: true }));
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  };

  const handleNewSession = async (targetCwd?: string) => {
    // 新建会话会重建 session（中止当前轮），运行中先确认
    if (!(await confirmStopRunning(t.stopRunningActionNew))) return;
    await transitionSession(() => window.pi.newSession(targetCwd));
  };

  const handleNewSessionInProject = async () => {
    const targetCwd = await window.pi.selectDirectory();
    if (!targetCwd) return;
    await handleNewSession(targetCwd);
  };

  const handleRemoveProject = async (targetCwd: string) => {
    // 移除项目会切到别的项目/新建会话，等于中止当前轮，运行中先确认
    if (!(await confirmStopRunning(t.stopRunningActionSwitch))) return;
    setRemoving(true);
    try {
      await transitionSession(async () => {
        await abortRunningTurn();
        await window.pi.removeProject(targetCwd);
        const result = await window.pi.listSessions();
        const other = result.all.find((s) => s.cwd !== targetCwd);
        if (other) await window.pi.switchSession(other.path);
        else await window.pi.newSession(targetCwd);
      });
    } catch (e: any) {
      console.error('remove project failed', e);
    } finally {
      setRemoving(false);
      setConfirmRemove(null);
    }
  };

  const isMac = window.pi?.platform === 'darwin';

  const buildProjectMenuItems = (targetCwd: string): MenuItem[] => [
    {
      label: isMac ? t.openInFinder : t.openInExplorer,
      onClick: () => window.pi.showInFolder(targetCwd)
    },
    {
      label: t.projectInfo,
      onClick: () => setShowProjectInfo(targetCwd)
    },
    { label: '', separator: true },
    {
      label: t.removeProject,
      danger: true,
      onClick: () => setConfirmRemove(targetCwd)
    }
  ];

  const handleSortClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSortMenu({ x: rect.left, y: rect.bottom + 2 });
  };

  const sortModeLabel = (mode: SortMode): string => {
    switch (mode) {
      case 'created':
        return t.sortCreated;
      case 'createdAsc':
        return t.sortCreatedAsc;
      case 'name':
        return t.sortName;
      case 'modified':
      default:
        return t.sortModified;
    }
  };

  const sortMenuItems: MenuItem[] = [
    { label: t.sortSessions, header: true },
    { separator: true, label: '' },
    ...SORT_MODES.map((mode) => ({
      label: sortModeLabel(mode),
      active: sortMode === mode,
      onClick: () => setSortMode(mode)
    }))
  ];

  const handleSwitchSession = async (session: any) => {
    // 切换会话会中止当前轮（SDK 在切换前 await abort），运行中先让用户确认
    if (!(await confirmStopRunning(t.stopRunningActionSwitch))) return;
    await transitionSession(() => window.pi.switchSession(session.path), sessionLabel(session));
  };

  // === 会话右键菜单操作 ===
  const sessionLabel = (s: any) =>
    s.name || s.firstMessage?.substring(0, 40) || s.id?.substring(0, 8) || s.pathBase || '会话';

  const handleCtxCopy = async (s: any) => {
    try {
      await window.pi.duplicateSession(s.path);
      await loadSessions();
    } catch (e: any) {
      console.error('duplicate session failed:', e);
    }
  };

  const handleCtxRename = async (s: any) => {
    // Electron 不支持 window.prompt()，改用自定义模态框
    setRenameTarget(s);
  };

  const handleRenameConfirm = async (name: string) => {
    const s = renameTarget;
    setRenameTarget(null);
    if (!name.trim()) return;
    try {
      await window.pi.renameSession(s.path, name.trim());
      await loadSessions();
    } catch (e: any) {
      console.error('rename session failed:', e);
    }
  };

  const handleCtxExportJsonl = async (s: any) => {
    const out = await window.pi.saveDialog({
      title: t.ctxExportJsonl,
      defaultPath: `${sessionLabel(s)}.jsonl`,
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
    });
    if (!out) return;
    try {
      await window.pi.exportSessionJsonl(s.path, out);
    } catch (e: any) {
      console.error('export jsonl failed:', e);
    }
  };

  const handleCtxExportHtml = async (s: any) => {
    const out = await window.pi.saveDialog({
      title: t.ctxExportHtml,
      defaultPath: `${sessionLabel(s)}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    });
    if (!out) return;
    // 导出 HTML 内部会临时切到目标会话再切回来（等于中止当前轮），运行中先确认
    if (!(await confirmStopRunning(t.stopRunningActionExport))) return;
    try {
      await transitionSession(() => window.pi.exportSessionHtml(s.path, out));
    } catch (e: any) {
      console.error('export html failed:', e);
    }
  };

  const handleCtxDelete = async (s: any) => {
    setConfirmDeleteSession(s);
  };

  const performDeleteSession = async () => {
    const s = confirmDeleteSession;
    if (!s) return;
    try {
      await window.pi.deleteSession(s.path);
      await loadSessions();
    } catch (e: any) {
      // 原先用 window.alert：renderer 里唯一的原生弹窗，与全应用的 toast 反馈不一致
      showToast(t.sessionDeleteFail(String(e?.message || e)), { variant: 'error' });
    } finally {
      setConfirmDeleteSession(null);
    }
  };

  const onSessionContextMenu = (e: React.MouseEvent, s: any) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, session: s });
  };

  const ctxMenuItems: MenuItem[] = ctxMenu
    ? [
        { label: t.ctxCopySession, onClick: () => handleCtxCopy(ctxMenu.session) },
        { label: t.ctxRenameSession, onClick: () => handleCtxRename(ctxMenu.session) },
        { separator: true, label: '' },
        { label: t.ctxExportJsonl, onClick: () => handleCtxExportJsonl(ctxMenu.session) },
        { label: t.ctxExportHtml, onClick: () => handleCtxExportHtml(ctxMenu.session) },
        { separator: true, label: '' },
        {
          label: t.ctxDeleteSession,
          danger: true,
          onClick: () => handleCtxDelete(ctxMenu.session)
        }
      ]
    : [];

  // Drag to resize sidebar width
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = asideRef.current?.offsetWidth ?? sidebarWidth;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const next = startWidth + (ev.clientX - startX);
      setSidebarWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div
        ref={asideRef}
        className={`relative flex shrink-0 flex-col overflow-hidden border-r border-od-border ${
          sidebarOpen ? '' : 'border-r-0'
        } ${dragging ? '' : 'sidebar-anim'}`}
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
      >
        {/* 内容层固定宽度：外层 width 动画时不重排内容（只裁剪） */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ width: sidebarWidth }}>
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm font-semibold uppercase tracking-wider text-od-text-dim">
              {t.sessions}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex items-center justify-center rounded-md p-1 text-sm text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                title={t.sessionSearch.title}
                aria-label={t.sessionSearch.title}
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
              >
                <Icon name="search" className="w-3.5" />
              </button>
              <button
                onClick={handleSortClick}
                className="flex items-center justify-center rounded-md p-1 text-sm text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                title={t.sortSessions}
              >
                <Icon name="sort" className="w-3.5" />
              </button>
              <button
                onClick={handleNewSessionInProject}
                className="flex items-center justify-center rounded-md p-1 text-sm text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                title={t.newSessionInProject}
              >
                <Icon name="plus" className="w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto px-1.5">
            {groups.length === 0 && (
              <div className="px-2 py-2 text-xs text-od-text-dim">{t.noSessions}</div>
            )}
            {groups.map((group) => (
              <div key={group.cwd} className="group mb-0.5">
                <div className="relative flex items-center">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [group.cwd]: !e[group.cwd] }))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setProjectMenu({ x: e.clientX, y: e.clientY, cwd: group.cwd });
                    }}
                    title={group.cwd}
                    className="flex flex-1 min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text"
                  >
                    <Icon
                      name={expanded[group.cwd] ? 'chevronDown' : 'chevronRight'}
                      className="w-3"
                    />
                    <Icon name="folder" className="w-3" />
                    <span className="truncate text-sm font-semibold">
                      {group.name || group.cwd}
                    </span>
                    <span className="ml-auto text-od-text-dim group-hover:opacity-0 transition-opacity">
                      {group.sessions.length}
                    </span>
                  </button>
                  <button
                    onClick={() => handleNewSession(group.cwd)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded p-1 text-od-text-dim opacity-0 pointer-events-none transition-opacity hover:bg-od-bg-hover hover:text-od-text-bright group-hover:opacity-100 group-hover:pointer-events-auto"
                    title={t.newSessionForProject}
                  >
                    <Icon name="plus" className="w-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      setProjectMenu({ x: r.right, y: r.bottom, cwd: group.cwd });
                    }}
                    className="absolute right-7 top-1/2 -translate-y-1/2 flex items-center justify-center rounded p-1 text-od-text-dim opacity-0 pointer-events-none transition-opacity hover:bg-od-bg-hover hover:text-od-text-bright group-hover:opacity-100 group-hover:pointer-events-auto"
                    title={t.projectMenu}
                  >
                    <Icon name="ellipsisVertical" className="w-3" />
                  </button>
                </div>
                {expanded[group.cwd] && (
                  <div className="mt-0.5 space-y-0.5 pb-1">
                    {group.sessions.map((s) => {
                      const active = s.id === sessionId;
                      const isActiveStreaming = active && isStreaming;
                      return (
                        <button
                          key={s.id || s.path}
                          ref={active ? activeItemRef : undefined}
                          onClick={() => handleSwitchSession(s)}
                          onContextMenu={(e) => onSessionContextMenu(e, s)}
                          className={`flex w-full items-center gap-1 rounded-md py-1.5 pl-7 pr-2 text-left text-sm transition-colors ${
                            active
                              ? 'bg-od-accent/15 text-od-accent'
                              : 'text-od-text hover:bg-od-bg-hover'
                          }`}
                        >
                          {isActiveStreaming ? (
                            <Icon name="spinner" spin className="w-3 shrink-0 text-od-accent" />
                          ) : null}
                          <span className="truncate" title={s.path || undefined}>
                            {sessionLabel(s)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Resize handle（固定在内层右侧，收起时随外层裁剪隐藏） */}
          <div
            onMouseDown={startResize}
            className={`absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-od-accent/50 ${
              dragging ? 'bg-od-accent/60' : ''
            }`}
            title="拖拽调整宽度"
          />
        </div>
      </div>

      {searchOpen && (
        <SessionSearchModal
          onClose={() => setSearchOpen(false)}
          onSelect={(session) => {
            setSearchOpen(false);
            if (session.path !== usePiStore.getState().sessionFile) {
              void handleSwitchSession(session);
            }
          }}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {sortMenu && (
        <ContextMenu
          x={sortMenu.x}
          y={sortMenu.y}
          items={sortMenuItems}
          onClose={() => setSortMenu(null)}
        />
      )}
      <PromptModal
        open={renameTarget != null}
        title={t.renamePrompt}
        defaultValue={renameTarget ? sessionLabel(renameTarget) : ''}
        onConfirm={handleRenameConfirm}
        onClose={() => setRenameTarget(null)}
      />

      {/* 项目操作菜单 */}
      {projectMenu && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          items={buildProjectMenuItems(projectMenu.cwd)}
          onClose={() => setProjectMenu(null)}
        />
      )}

      {/* 项目属性弹窗 */}
      {showProjectInfo && (
        <ProjectInfoModal cwd={showProjectInfo} onClose={() => setShowProjectInfo(null)} />
      )}

      {/* 移除项目二次确认 */}
      <ConfirmDialog
        open={confirmRemove !== null}
        title={t.removeProject}
        message={confirmRemove ? t.removeProjectConfirm(confirmRemove) : ''}
        confirmText={t.confirmRemove}
        danger
        loading={removing}
        onConfirm={() => confirmRemove && handleRemoveProject(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
      />

      {/* 删除会话二次确认 */}
      <ConfirmDialog
        open={confirmDeleteSession !== null}
        title={t.deleteSession}
        message={confirmDeleteSession ? t.deleteConfirm(sessionLabel(confirmDeleteSession)) : ''}
        confirmText={t.delete}
        danger
        onConfirm={performDeleteSession}
        onClose={() => setConfirmDeleteSession(null)}
      />
    </>
  );
}
