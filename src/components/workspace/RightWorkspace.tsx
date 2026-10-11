import { useCallback, useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import FileTree from '../code/FileTree';
import Breadcrumb from '../code/Breadcrumb';
import DiffViewer from '../code/DiffViewer';
import ResizeHandle from '../common/ResizeHandle';
import Markdown from '../common/Markdown';
import BrowserContent from './BrowserContent';
import { detectLanguage } from '../../hooks/useMonaco';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import type { CodeTab } from '../../types/shared';
import type { BrowserState, BrowserTabState } from '../../types/pi';

interface BrowserWorkspaceTab extends BrowserTabState {
  id: string;
  type: 'browser';
  browserId: string;
}

type WorkspaceTab = CodeTab | BrowserWorkspaceTab;

const browserWorkspaceId = (id: string) => `browser:${id}`;

export default function RightWorkspace() {
  const [codeTabs, setCodeTabs] = useState<CodeTab[]>([]);
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
        processingRef.current = false;
      });
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
      processingRef.current = false;
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
      processingRef.current = false;
    })();
  }, [pendingFile, handleFileOpen, messages, selectTabId, setPendingFile, toolExecutions]);

  const activateTab = (tab: WorkspaceTab) => {
    selectTabId(tab.id);
    if (tab.type === 'browser') window.pi.browser.activate(tab.browserId).catch(() => {});
  };

  const closeTab = async (tab: WorkspaceTab) => {
    const currentTabs: WorkspaceTab[] = [
      ...codeTabsRef.current,
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
    } else {
      setCodeTabs(nextTabs.filter((item): item is CodeTab => item.type !== 'browser'));
    }
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

  const browserTabs = browserState.tabs.map<BrowserWorkspaceTab>((tab) => ({
    ...tab,
    id: browserWorkspaceId(tab.id),
    type: 'browser',
    browserId: tab.id
  }));
  const tabs: WorkspaceTab[] = [...codeTabs, ...browserTabs];
  const activeCodeTab = codeTabs.find((tab) => tab.id === activeTabId) || null;
  const activeBrowserTab = browserTabs.find((tab) => tab.id === activeTabId) || null;
  const activeTab = activeCodeTab || activeBrowserTab;
  const isMarkdown =
    activeCodeTab?.type === 'file' && /\.(md|markdown)$/i.test(activeCodeTab.filePath || '');
  const mdPreview = activeCodeTab ? (mdPreviewMap[activeCodeTab.id] ?? true) : true;

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
                name={tab.type === 'browser' ? 'browser' : tab.type === 'diff' ? 'diff' : 'file'}
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
          {!activeBrowserTab && (
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

      {activeCodeTab?.filePath && (
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

        {!activeBrowserTab && !treeCollapsed && (
          <ResizeHandle
            side="left"
            onResize={(delta) => {
              const next = Math.max(80, fileTreeWidth - delta);
              setFileTreeWidth(next);
              window.pi.setUiSettings({ fileTreeWidth: next }).catch(() => {});
            }}
          />
        )}

        {!activeBrowserTab && !treeCollapsed && (
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
