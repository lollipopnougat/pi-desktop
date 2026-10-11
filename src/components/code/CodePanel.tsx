import { useState, useCallback, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import FileTree from './FileTree';
import Breadcrumb from './Breadcrumb';
import DiffViewer from './DiffViewer';
import ResizeHandle from '../common/ResizeHandle';
import Markdown from '../common/Markdown';
import { detectLanguage } from '../../hooks/useMonaco';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import type { CodeTab } from '../../types/shared';

// re-export 保持向后兼容
export type { CodeTab };

interface CodePanelProps {
  open: boolean;
  onClose: () => void;
}

export default function CodePanel({ open, onClose }: CodePanelProps) {
  const [tabs, setTabs] = useState<CodeTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 文件树宽度持久化到 ~/.pi-desktop/ui-config.json（不再用 localStorage）
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [fileFilter, setFileFilter] = useState('');
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // 各 markdown tab 是否处于预览模式（默认预览），按 tabId 记忆
  const [mdPreviewMap, setMdPreviewMap] = useState<Record<string, boolean>>({});
  const cwd = usePiStore((s) => s.cwd);
  const toolExecutions = usePiStore((s) => s.toolExecutions);
  const messages = usePiStore((s) => s.messages);
  const pendingFile = usePiStore((s) => s.pendingFile);
  const setPendingFile = usePiStore((s) => s.setPendingFile);
  const { theme: monacoTheme, options: monacoOptions } = useMonacoEditor();
  const tabsRef = useRef(tabs);
  const processingRef = useRef(false);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // 挂载时读取持久化的文件树宽度（ui-config.json）
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

  const handleFileOpen = useCallback(async (filePath: string) => {
    const existingTab = tabsRef.current.find((t) => t.type === 'file' && t.filePath === filePath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
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
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (e) {
      console.error('Failed to read file:', e);
    }
  }, []);

  // Handle pending file requests from ToolCard (read/write/edit tools)
  useEffect(() => {
    if (!pendingFile || processingRef.current) return;
    processingRef.current = true;
    // 立即清空 pendingFile，防止 effect 因 toolExecutions 变化重复触发
    setPendingFile(null);
    if (pendingFile.mode === 'file') {
      handleFileOpen(pendingFile.path).finally(() => {
        processingRef.current = false;
      });
    } else if (pendingFile.mode === 'diff' && pendingFile.toolCallId) {
      const exec = toolExecutions[pendingFile.toolCallId];
      const edits = pendingFile.edits || exec?.args?.edits;
      // 优先从实时 toolExecutions 取 patch；历史会话没有 toolExecutions（事件不重放），
      // 则从 store messages 里按 toolCallId 查找对应的 toolResult，取其 details.patch。
      let patch = exec?.result?.details?.patch;
      if (!patch) {
        for (const m of messages) {
          if (m?.role === 'toolResult' && m?.toolCallId === pendingFile.toolCallId) {
            patch = m?.details?.patch;
            break;
          }
        }
      }
      const tabId = `diff-${pendingFile.toolCallId}`;
      if (tabsRef.current.find((t) => t.id === tabId)) {
        setActiveTabId(tabId);
        return;
      }
      if (patch) {
        // patch 是 edit 工具生成的精确 unified diff（含 context 行）。
        // 从 hunk 重建 original/modified 片段：上下文行进两侧，删除行只进 original，新增行只进 modified。
        // 这对历史会话尤其关键——历史 edit 的 newText/oldText 已不在当前磁盘文件中，
        // 但 patch 本身完整记录了改动，不依赖磁盘文件即可准确呈现差异。
        (async () => {
          const bn = await window.pi.baseName(pendingFile.path);
          const newTab: CodeTab = {
            id: tabId,
            type: 'diff',
            title: `Diff: ${bn}`,
            filePath: pendingFile.path,
            patch
          };
          // 幂等添加：StrictMode 会双重执行 effect，用函数式更新检查 tab 是否已存在，避免重复 tab。
          setTabs((prev) => (prev.find((t) => t.id === tabId) ? prev : [...prev, newTab]));
          setActiveTabId(tabId);
          processingRef.current = false;
        })();
      } else if (edits && edits.length > 0) {
        // 无 patch（例如实时会话 tool_execution_end 尚未到达）时，读取当前文件 + 反向应用 edits。
        // 注意：此方案依赖 newText 仍能匹配当前文件，历史会话若文件已被后续修改会匹配失败。
        (async () => {
          let modified = '';
          try {
            modified = await window.pi.readFile(pendingFile.path);
          } catch {}
          let original = modified;
          for (const edit of edits) {
            if (edit.oldText && edit.newText) {
              original = original.replace(edit.newText, edit.oldText);
            }
          }
          const newTab: CodeTab = {
            id: tabId,
            type: 'diff',
            title: `Diff: ${await window.pi.baseName(pendingFile.path)}`,
            filePath: pendingFile.path,
            originalContent: original,
            modifiedContent: modified
          };
          setTabs((prev) => (prev.find((t) => t.id === tabId) ? prev : [...prev, newTab]));
          setActiveTabId(tabId);
          processingRef.current = false;
        })();
      } else {
        // 没有 edits 信息，退化为直接打开文件
        handleFileOpen(pendingFile.path).finally(() => {
          processingRef.current = false;
        });
      }
    }
  }, [pendingFile, handleFileOpen, toolExecutions, setPendingFile]);

  const handleCloseTab = (tabId: string) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : null);
      }
      return filtered;
    });
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isMarkdown =
    activeTab?.type === 'file' && /\.(md|markdown)$/i.test(activeTab.filePath || '');
  // markdown 默认预览模式（map 中未记录时视为 true）
  const mdPreview = activeTab ? (mdPreviewMap[activeTab.id] ?? true) : true;

  if (!open) return null;

  return (
    <div className="flex h-full w-full flex-col bg-od-bg-dark">
      {/* Tab bar（横跨整个面板顶部） */}
      <div className="flex items-center border-b border-od-border bg-od-bg-alt">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1 border-r border-od-border px-3 py-1.5 text-xs cursor-pointer ${
              activeTabId === tab.id
                ? 'bg-od-bg-dark text-od-text-bright'
                : 'text-od-text-dim hover:text-od-text'
            }`}
            onClick={() => setActiveTabId(tab.id)}
          >
            <Icon name={tab.type === 'diff' ? 'diff' : 'file'} className="w-3" />
            <span className="truncate max-w-[120px]">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab.id);
              }}
              className="ml-1 text-od-text-dim hover:text-od-red"
            >
              <Icon name="close" size="xs" />
            </button>
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="px-3 py-1.5 text-xs text-od-text-dim whitespace-nowrap">
            {t.noOpenFiles}
          </div>
        )}
        <button
          onClick={() => setTreeCollapsed((v) => !v)}
          className={`ml-auto flex h-6 w-6 px-2 py-1 mr-1 items-center justify-center rounded hover:bg-od-bg-hover hover:text-od-text-bright ${
            treeCollapsed ? 'text-od-text-dim' : 'text-od-text-bright'
          }`}
          title={treeCollapsed ? t.showTree : t.hideTree}
        >
          <Icon name="folder" className="w-3.5" />
        </button>
        {/* <button
          onClick={onClose}
          className="px-2 py-1 text-xs text-od-text-dim hover:text-od-text"
          title={t.closePanel}
        >
          <Icon name="foldingPanel" className="w-3" />
        </button> */}
      </div>

      {/* 面包屑路径栏（横跨整个面板，仅文件 tab 显示） */}
      {activeTab?.filePath && (
        <Breadcrumb
          filePath={activeTab.filePath}
          cwd={cwd}
          onFileOpen={handleFileOpen}
          isMarkdown={isMarkdown}
          mdPreview={mdPreview}
          onToggleMdPreview={() =>
            setMdPreviewMap((prev) => ({ ...prev, [activeTab.id]: !mdPreview }))
          }
        />
      )}

      {/* 内容区：左编辑器 + 右文件树 */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Editor content */}
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {activeTab?.type === 'file' && isMarkdown && mdPreview && (
            <div className="h-full overflow-y-auto px-6 py-4">
              <Markdown content={activeTab.content || ''} />
            </div>
          )}
          {activeTab?.type === 'file' && !(isMarkdown && mdPreview) && (
            <Editor
              path={activeTab.filePath}
              value={activeTab.content}
              language={detectLanguage(activeTab.filePath)}
              theme={monacoTheme}
              options={{ ...monacoOptions, readOnly: true, scrollBeyondLastLine: false }}
            />
          )}
          {activeTab?.type === 'diff' && (
            <DiffViewer
              filePath={activeTab.filePath}
              patch={activeTab.patch}
              beforeContent={activeTab.beforeContent}
              originalContent={activeTab.originalContent}
              modifiedContent={activeTab.modifiedContent}
            />
          )}
          {!activeTab && (
            <div className="flex h-full items-center justify-center text-od-text-dim">
              <div className="text-center">
                <p className="text-sm">{t.codePanel}</p>
                <p className="mt-1 text-xs">{t.codePanelHint}</p>
              </div>
            </div>
          )}
        </div>

        {/* 拖拽分隔条（收起文件树时隐藏） */}
        {!treeCollapsed && (
          <ResizeHandle
            side="left"
            onResize={(delta) => {
              const next = Math.max(80, fileTreeWidth - delta);
              setFileTreeWidth(next);
              window.pi.setUiSettings({ fileTreeWidth: next }).catch(() => {});
            }}
          />
        )}

        {/* File Tree（右侧，可收起） */}
        {!treeCollapsed && (
          <div
            className="flex shrink-0 flex-col border-l border-od-border"
            style={{ width: fileTreeWidth }}
          >
            <div className="border-b border-od-border p-2">
              <div className="flex items-center gap-1.5 rounded-md border border-od-border bg-od-bg-dark px-2 py-1 focus-within:border-od-accent">
                <Icon name="find" className="w-3 text-od-text-dim" />
                <input
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder={t.filterFiles}
                  className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-xs text-od-text outline-none ring-0 placeholder:text-od-text-dim focus:outline-none focus:ring-0"
                />
                {fileFilter && (
                  <button
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
                activePath={activeTab?.filePath}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
