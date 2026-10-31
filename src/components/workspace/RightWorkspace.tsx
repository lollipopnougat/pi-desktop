import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import FileTree from '../code/FileTree';
import Breadcrumb from '../code/Breadcrumb';
import DiffViewer from '../code/DiffViewer';
import ReviewPanel from '../code/ReviewPanel';
import ResizeHandle from '../common/ResizeHandle';
import Markdown from '../common/Markdown';
import BrowserContent from './BrowserContent';
import MemoryWorkspace from './MemoryWorkspace';
import BackgroundTaskPanel from '../background-tasks/BackgroundTaskPanel';
import type { IconName } from '../common/icons';
import SubagentPanel from '../subagents/SubagentPanel';
import { detectLanguage } from '../../hooks/useMonaco';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import type { CodeTab } from '../../types/shared';
import { changeSignature, shortHash } from '../../lib/turn-changes';
import { resolveTurnFileDiff } from '../../lib/turn-diff';
import {
  onOpenWorkspaceBackgroundTasks,
  onOpenWorkspaceMemory,
  onOpenWorkspaceSubagents,
  onSelectWorkspaceTab
} from '../../lib/app-commands';
import type { BrowserState, BrowserTabState } from '../../types/pi';

interface BrowserWorkspaceTab extends BrowserTabState {
  id: string;
  type: 'browser';
  browserId: string;
}

/** 单例「辅助」标签：记忆 / 子 agent / 后台任务，各自最多一页，没有文件路径 */
type AuxTabKind = 'memory' | 'subagents' | 'backgroundTasks';

interface AuxWorkspaceTab {
  id: string;
  type: AuxTabKind;
  title: string;
}

type WorkspaceTab = CodeTab | BrowserWorkspaceTab | AuxWorkspaceTab;

const AUX_TAB_TITLES: Record<AuxTabKind, () => string> = {
  memory: () => t.memory.panelTitle,
  subagents: () => t.subagents.panelTitle,
  backgroundTasks: () => t.backgroundTasks.panelTitle
};

/** 辅助标签的图标（CodeTab 的 file/diff/review 不在此列） */
const AUX_TAB_ICONS: Record<AuxTabKind, IconName> = {
  memory: 'memory',
  subagents: 'agents',
  backgroundTasks: 'backgroundTasks'
};

const browserWorkspaceId = (id: string) => `browser:${id}`;

export default function RightWorkspace() {
  const [codeTabs, setCodeTabs] = useState<CodeTab[]>([]);
  const [auxTabKinds, setAuxTabKinds] = useState<AuxTabKind[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState>({
    enabled: false,
    tabs: [],
    activeTabId: null
  });
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [fileFilter, setFileFilter] = useState('');
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [mdPreviewMap, setMdPreviewMap] = useState<Record<string, boolean>>({});
  const cwd = usePiStore((state) => state.cwd);
  const toolExecutions = usePiStore((state) => state.toolExecutions);
  const messages = usePiStore((state) => state.messages);
  const pendingFile = usePiStore((state) => state.pendingFile);
  const setPendingFile = usePiStore((state) => state.setPendingFile);
  const rightPanelOpen = usePiStore((state) => state.rightPanelOpen);
  const setRightPanelOpen = usePiStore((state) => state.setRightPanelOpen);
  const rightPanelMaximized = usePiStore((state) => state.rightPanelMaximized);
  const setRightPanelMaximized = usePiStore((state) => state.setRightPanelMaximized);
  const setTerminalPanelOpen = usePiStore((state) => state.setTerminalPanelOpen);
  const browserEnabled = usePiStore((state) => state.browserEnabled);
  const settingsOpen = usePiStore((state) => state.settingsOpen);
  const treeViewOpen = usePiStore((state) => state.treeViewOpen);
  const { theme: monacoTheme, options: monacoOptions } = useMonacoEditor();
  const showToast = usePiStore((state) => state.showToast);
  const codeTabsRef = useRef(codeTabs);
  const activeTabIdRef = useRef(activeTabId);
  const processingRef = useRef(false);
  const browserStateEventVersionRef = useRef(0);

  const selectTabId = useCallback((tabId: string | null) => {
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
  }, []);

  /**
   * 释放 pendingFile 处理闸门。处理期间又来了新请求时会因为闸门被挡掉，
   * 这里用它的新引用重新触发一次 effect，避免「第二次点击被静默吞掉」。
   */
  const releaseProcessing = useCallback(() => {
    processingRef.current = false;
    const queued = usePiStore.getState().pendingFile;
    if (queued) usePiStore.getState().setPendingFile({ ...queued });
  }, []);

  useEffect(() => {
    codeTabsRef.current = codeTabs;
  }, [codeTabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    window.pi
      .getUiSettings()
      .then((ui) => {
        const saved = ui?.fileTreeWidth;
        if (typeof saved === 'number' && Number.isFinite(saved) && saved >= 80) {
          setFileTreeWidth(saved);
        }
      })
      .catch(() => {});
  }, []);

  const syncBrowserTabs = useCallback(
    (state: BrowserState) => {
      setBrowserState(state);
      usePiStore.setState({ browserEnabled: state.enabled });
      const active = activeTabIdRef.current;
      if (
        active?.startsWith('browser:') &&
        !state.tabs.some((tab) => browserWorkspaceId(tab.id) === active)
      ) {
        const fallbackBrowser = state.tabs[state.tabs.length - 1];
        const fallbackCode = codeTabsRef.current[codeTabsRef.current.length - 1];
        selectTabId(
          fallbackBrowser ? browserWorkspaceId(fallbackBrowser.id) : fallbackCode?.id || null
        );
      }
    },
    [selectTabId]
  );

  useEffect(() => {
    let disposed = false;
    const initialVersion = browserStateEventVersionRef.current;
    window.pi.browser
      .getState()
      .then((state) => {
        if (!disposed && browserStateEventVersionRef.current === initialVersion) {
          syncBrowserTabs(state);
        }
      })
      .catch(() => {});
    const offState = window.pi.onBrowserStateChanged((state) => {
      browserStateEventVersionRef.current += 1;
      syncBrowserTabs(state);
    });
    const offFocus = window.pi.onBrowserFocusRequested((tabId) => {
      const id = browserWorkspaceId(tabId);
      setRightPanelOpen(true);
      selectTabId(id);
    });
    return () => {
      disposed = true;
      offState();
      offFocus();
      window.pi.browser.setVisible(false).catch(() => {});
    };
  }, [selectTabId, setRightPanelOpen, syncBrowserTabs]);

  const handleFileOpen = useCallback(
    async (filePath: string) => {
      const existing = codeTabsRef.current.find(
        (tab) => tab.type === 'file' && tab.filePath === filePath
      );
      if (existing) {
        selectTabId(existing.id);
        return;
      }
      try {
        const content = await window.pi.readFile(filePath);
        const newTab: CodeTab = {
          id: `file-${Date.now()}`,
          type: 'file',
          title: (await window.pi.baseName(filePath)) || filePath,
          filePath,
          content
        };
        setCodeTabs((previous) => [...previous, newTab]);
        selectTabId(newTab.id);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), { variant: 'error' });
      }
    },
    [selectTabId, showToast]
  );

  useEffect(() => {
    if (!pendingFile || processingRef.current) return;
    processingRef.current = true;
    setPendingFile(null);
    if (pendingFile.mode === 'file') {
      handleFileOpen(pendingFile.path).finally(() => {
        releaseProcessing();
      });
      return;
    }

    // 「本次改动」卡片点「审核」：一轮里所有被改动的文件，左侧列表 + 右侧完整 diff
    if (pendingFile.mode === 'review') {
      const reviewChanges = pendingFile.changes ?? [];
      if (reviewChanges.length === 0) {
        releaseProcessing();
        return;
      }
      const reviewId = `review:${reviewChanges.length}:${shortHash(
        reviewChanges.map(changeSignature).join('|')
      )}`;
      const openedReview = codeTabsRef.current.find((tab) => tab.id === reviewId);
      if (openedReview) {
        selectTabId(openedReview.id);
      } else {
        const reviewTab: CodeTab = {
          id: reviewId,
          type: 'review',
          title: t.turnChanges.reviewTitle(reviewChanges.length),
          filePath: reviewChanges[0]?.path ?? '',
          changes: reviewChanges
        };
        setCodeTabs((previous) => [...previous, reviewTab]);
        selectTabId(reviewTab.id);
      }
      releaseProcessing();
      return;
    }

    // 「本次改动」卡片点文件名：该文件的完整前后内容（反应用 patch 还原改动前内容）
    if (pendingFile.change) {
      const change = pendingFile.change;
      const tabId = `diff:${shortHash(changeSignature(change))}`;
      const opened = codeTabsRef.current.find((tab) => tab.id === tabId);
      if (opened) {
        selectTabId(opened.id);
        releaseProcessing();
        return;
      }
      void (async () => {
        const [resolved, name] = await Promise.all([
          resolveTurnFileDiff(change, (path) => window.pi.readFile(path)),
          window.pi.baseName(change.path).catch(() => '')
        ]);
        const diffTab: CodeTab = {
          id: tabId,
          type: 'diff',
          title: `Diff: ${name || change.path}`,
          filePath: change.path,
          patch: change.patches.join('\n'),
          originalContent: resolved?.original,
          modifiedContent: resolved?.modified
        };
        setCodeTabs((previous) => [...previous, diffTab]);
        selectTabId(diffTab.id);
        releaseProcessing();
      })();
      return;
    }

    const exec = pendingFile.toolCallId ? toolExecutions[pendingFile.toolCallId] : undefined;
    const edits = pendingFile.edits || exec?.args?.edits;
    let patch = exec?.result?.details?.patch;
    if (!patch && pendingFile.toolCallId) {
      for (const message of messages) {
        if (message?.role === 'toolResult' && message?.toolCallId === pendingFile.toolCallId) {
          patch = message?.details?.patch;
          break;
        }
      }
    }
    const tabId = `diff-${pendingFile.toolCallId || Date.now()}`;
    const existing = codeTabsRef.current.find((tab) => tab.id === tabId);
    if (existing) {
      selectTabId(existing.id);
      releaseProcessing();
      return;
    }

    void (async () => {
      if (patch) {
        const newTab: CodeTab = {
          id: tabId,
          type: 'diff',
          title: `Diff: ${await window.pi.baseName(pendingFile.path)}`,
          filePath: pendingFile.path,
          patch
        };
        setCodeTabs((previous) => [...previous, newTab]);
        selectTabId(newTab.id);
      } else if (edits?.length) {
        let modified = '';
        try {
          modified = await window.pi.readFile(pendingFile.path);
        } catch {}
        let original = modified;
        for (const edit of edits) {
          if (edit.oldText && edit.newText) original = original.replace(edit.newText, edit.oldText);
        }
        const newTab: CodeTab = {
          id: tabId,
          type: 'diff',
          title: `Diff: ${await window.pi.baseName(pendingFile.path)}`,
          filePath: pendingFile.path,
          originalContent: original,
          modifiedContent: modified
        };
        setCodeTabs((previous) => [...previous, newTab]);
        selectTabId(newTab.id);
      } else {
        await handleFileOpen(pendingFile.path);
      }
      releaseProcessing();
    })();
  }, [
    pendingFile,
    handleFileOpen,
    messages,
    releaseProcessing,
    selectTabId,
    setPendingFile,
    toolExecutions
  ]);

  const openAuxTab = useCallback(
    (kind: AuxTabKind) => {
      setAuxTabKinds((previous) => (previous.includes(kind) ? previous : [...previous, kind]));
      setRightPanelOpen(true);
      selectTabId(kind);
    },
    [selectTabId, setRightPanelOpen]
  );

  const activateTab = (tab: WorkspaceTab) => {
    selectTabId(tab.id);
    if (tab.type === 'browser') window.pi.browser.activate(tab.browserId).catch(() => {});
  };

  const closeTab = async (tab: WorkspaceTab) => {
    const currentTabs: WorkspaceTab[] = [
      ...codeTabsRef.current,
      ...auxTabKinds.map<AuxWorkspaceTab>((kind) => ({
        id: kind,
        type: kind,
        title: AUX_TAB_TITLES[kind]()
      })),
      ...browserState.tabs.map<BrowserWorkspaceTab>((browserTab) => ({
        ...browserTab,
        id: browserWorkspaceId(browserTab.id),
        type: 'browser',
        browserId: browserTab.id
      }))
    ];
    const index = currentTabs.findIndex((item) => item.id === tab.id);
    const nextTabs = currentTabs.filter((item) => item.id !== tab.id);
    if (activeTabIdRef.current === tab.id) {
      selectTabId(nextTabs[Math.min(index, nextTabs.length - 1)]?.id || null);
    }
    if (tab.type === 'browser') {
      await window.pi.browser.close(tab.browserId);
    } else if (
      tab.type === 'memory' ||
      tab.type === 'subagents' ||
      tab.type === 'backgroundTasks'
    ) {
      setAuxTabKinds((previous) => previous.filter((kind) => kind !== tab.type));
    } else {
      setCodeTabs((previous) => previous.filter((item) => item.id !== tab.id));
    }
    // 关掉最后一个标签后右侧面板没有内容可看：顺手收起（否则留一块空面板）
    if (nextTabs.length === 0) setRightPanelOpen(false);
  };

  const openBrowser = async () => {
    try {
      const tab = await window.pi.browser.open();
      setBrowserState((previous) => ({
        ...previous,
        tabs: previous.tabs.some((item) => item.id === tab.id)
          ? previous.tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...previous.tabs, tab],
        activeTabId: tab.id
      }));
      setRightPanelOpen(true);
      selectTabId(browserWorkspaceId(tab.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    }
  };

  const openFilePicker = async () => {
    const file = await window.pi.selectFile({ title: t.workspaceOpenFile });
    if (file) await handleFileOpen(file);
  };

  const browserTabs = useMemo<BrowserWorkspaceTab[]>(
    () =>
      browserState.tabs.map((tab) => ({
        ...tab,
        id: browserWorkspaceId(tab.id),
        type: 'browser' as const,
        browserId: tab.id
      })),
    [browserState.tabs]
  );
  const auxTabs = useMemo<AuxWorkspaceTab[]>(
    () =>
      auxTabKinds.map((kind) => ({
        id: kind,
        type: kind,
        title: AUX_TAB_TITLES[kind]()
      })),
    [auxTabKinds]
  );
  const tabs = useMemo<WorkspaceTab[]>(
    () => [...codeTabs, ...auxTabs, ...browserTabs],
    [codeTabs, auxTabs, browserTabs]
  );
  // 数字快捷键（Mod+1..9）切标签：标签集合含浏览器标签且随状态变化，用 ref 保留最新顺序
  const tabsRef = useRef<WorkspaceTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => onOpenWorkspaceMemory(() => openAuxTab('memory')), [openAuxTab]);
  useEffect(() => onOpenWorkspaceSubagents(() => openAuxTab('subagents')), [openAuxTab]);
  useEffect(
    () => onOpenWorkspaceBackgroundTasks(() => openAuxTab('backgroundTasks')),
    [openAuxTab]
  );

  useEffect(() => {
    return onSelectWorkspaceTab((index) => {
      const target = tabsRef.current[index];
      if (!target) return;
      selectTabId(target.id);
      if (target.type === 'browser') window.pi.browser.activate(target.browserId).catch(() => {});
    });
  }, [selectTabId]);
  const activeCodeTab = codeTabs.find((tab) => tab.id === activeTabId) || null;
  const activeBrowserTab = browserTabs.find((tab) => tab.id === activeTabId) || null;
  const activeAuxTab = auxTabs.find((tab) => tab.id === activeTabId) || null;
  const activeTab = activeCodeTab || activeAuxTab || activeBrowserTab;
  const isMarkdown =
    activeCodeTab?.type === 'file' && /\.(md|markdown)$/i.test(activeCodeTab.filePath || '');
  const mdPreview = activeCodeTab ? (mdPreviewMap[activeCodeTab.id] ?? true) : true;
  // 审核 tab 自带文件列表，再叠一层文件树会把 diff 挤没（默认面板宽度只有几百 px）
  // 记忆标签自带双栏卡片布局，不叠文件树
  const showFileTree =
    !activeBrowserTab && !activeAuxTab && activeCodeTab?.type !== 'review' && !treeCollapsed;

  return (
    <div className="flex h-full w-full flex-col bg-od-bg-dark">
      <div className="flex h-8 shrink-0 items-center overflow-hidden border-b border-od-border bg-od-bg-alt">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex max-w-44 shrink-0 cursor-pointer items-center gap-1 border-r border-od-border px-2 text-xs ${
                activeTabId === tab.id
                  ? 'bg-od-bg-dark text-od-text-bright'
                  : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text'
              }`}
              onClick={() => activateTab(tab)}
              title={tab.title}
            >
              <Icon
                name={
                  tab.type === 'browser'
                    ? 'browser'
                    : tab.type === 'memory' ||
                        tab.type === 'subagents' ||
                        tab.type === 'backgroundTasks'
                      ? AUX_TAB_ICONS[tab.type]
                      : tab.type === 'file'
                        ? 'file'
                        : 'diff'
                }
                className="w-3 shrink-0"
              />
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab);
                }}
                className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-od-text-dim opacity-0 hover:bg-od-bg-hover hover:text-od-text-bright group-hover:opacity-100"
                title={t.closePanel}
              >
                <Icon name="close" size="xs" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          {browserEnabled && (
            <button
              type="button"
              onClick={() => void openBrowser()}
              className="flex h-6 w-6 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.browserNewTab}
            >
              <Icon name="plus" className="w-3" />
            </button>
          )}
          {!activeBrowserTab && activeCodeTab?.type !== 'review' && (
            <button
              type="button"
              onClick={() => setTreeCollapsed((value) => !value)}
              className={`flex h-6 w-6 items-center justify-center rounded hover:bg-od-bg-hover hover:text-od-text-bright ${
                treeCollapsed ? 'text-od-text-dim' : 'text-od-text-bright'
              }`}
              title={treeCollapsed ? t.showTree : t.hideTree}
            >
              <Icon name="folder" className="w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setRightPanelMaximized(!rightPanelMaximized)}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-od-bg-hover hover:text-od-text-bright ${
              rightPanelMaximized ? 'text-od-text-bright' : 'text-od-text-dim'
            }`}
            title={rightPanelMaximized ? t.workspaceRestore : t.workspaceMaximize}
          >
            <Icon name={rightPanelMaximized ? 'restore' : 'expand'} className="w-3" />
          </button>
        </div>
      </div>

      {(activeCodeTab?.type === 'file' || activeCodeTab?.type === 'diff') &&
        activeCodeTab.filePath && (
          <Breadcrumb
            filePath={activeCodeTab.filePath}
            cwd={cwd}
            onFileOpen={handleFileOpen}
            isMarkdown={isMarkdown}
            mdPreview={mdPreview}
            onToggleMdPreview={() =>
              setMdPreviewMap((previous) => ({
                ...previous,
                [activeCodeTab.id]: !mdPreview
              }))
            }
          />
        )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {activeCodeTab?.type === 'file' && isMarkdown && mdPreview && (
            <div className="h-full overflow-y-auto px-6 py-4">
              <Markdown content={activeCodeTab.content || ''} />
            </div>
          )}
          {activeCodeTab?.type === 'file' && !(isMarkdown && mdPreview) && (
            <Editor
              path={activeCodeTab.filePath}
              value={activeCodeTab.content}
              language={detectLanguage(activeCodeTab.filePath)}
              theme={monacoTheme}
              options={{ ...monacoOptions, readOnly: true, scrollBeyondLastLine: false }}
            />
          )}
          {activeCodeTab?.type === 'diff' && (
            <DiffViewer
              filePath={activeCodeTab.filePath}
              patch={activeCodeTab.patch}
              beforeContent={activeCodeTab.beforeContent}
              originalContent={activeCodeTab.originalContent}
              modifiedContent={activeCodeTab.modifiedContent}
            />
          )}
          {activeCodeTab?.type === 'review' && (
            <ReviewPanel changes={activeCodeTab.changes ?? []} />
          )}
          {activeAuxTab?.type === 'memory' && <MemoryWorkspace />}
          {activeAuxTab?.type === 'subagents' && <SubagentPanel />}
          {activeAuxTab?.type === 'backgroundTasks' && <BackgroundTaskPanel />}
          {activeBrowserTab && (
            <BrowserContent
              tab={activeBrowserTab}
              browserId={activeBrowserTab.browserId}
              obscured={!rightPanelOpen || settingsOpen || treeViewOpen}
            />
          )}
          {!activeTab && (
            <div className="flex h-full items-center justify-center px-6 text-od-text-dim">
              <div className="text-center">
                <Icon name="code" className="mx-auto mb-3 w-6" />
                <div className="text-sm text-od-text-bright">{t.workspaceEmpty}</div>
                <div className="mt-1 text-xs">{t.workspaceEmptyHint}</div>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openFilePicker()}
                    className="flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover"
                  >
                    <Icon name="file" className="w-3" />
                    {t.workspaceOpenFile}
                  </button>
                  {browserEnabled && (
                    <button
                      type="button"
                      onClick={() => void openBrowser()}
                      className="flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover"
                    >
                      <Icon name="browser" className="w-3" />
                      {t.browserNewTab}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setTerminalPanelOpen(true)}
                    className="flex items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text-bright hover:bg-od-bg-hover"
                  >
                    <Icon name="terminal" className="w-3" />
                    {t.workspaceOpenTerminal}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {showFileTree && (
          <ResizeHandle
            side="left"
            onResize={(delta) => {
              const next = Math.max(80, fileTreeWidth - delta);
              setFileTreeWidth(next);
              window.pi.setUiSettings({ fileTreeWidth: next }).catch(() => {});
            }}
          />
        )}

        {showFileTree && (
          <div
            className="flex shrink-0 flex-col border-l border-od-border"
            style={{ width: fileTreeWidth }}
          >
            <div className="border-b border-od-border p-2">
              <div className="flex items-center gap-1.5 rounded border border-od-border bg-od-bg-dark px-2 py-1 focus-within:border-od-accent">
                <Icon name="find" className="w-3 text-od-text-dim" />
                <input
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder={t.filterFiles}
                  className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-xs text-od-text outline-none ring-0 placeholder:text-od-text-dim focus:outline-none focus:ring-0"
                />
                {fileFilter && (
                  <button
                    type="button"
                    onClick={() => setFileFilter('')}
                    className="text-od-text-dim hover:text-od-text"
                    title={t.closePanel}
                  >
                    <Icon name="close" size="xs" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0 overflow-y-auto">
              <FileTree
                cwd={cwd}
                onFileOpen={handleFileOpen}
                filter={fileFilter}
                activePath={activeCodeTab?.filePath}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
