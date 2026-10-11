import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import TreeView from '../session/TreeView';
import SessionInfoModal from '../session/SessionInfoModal';
import Icon from '../common/Icon';
import MemoryPanel from './MemoryPanel';
import SubagentPanel from '../subagents/SubagentPanel';
import BackgroundTaskPanel from '../background-tasks/BackgroundTaskPanel';
import { t } from '../../i18n/zh';

/**
 * 聊天区域顶部标题栏：展示当前会话名称，并提供会话树入口。
 */
export default function ChatHeader() {
  const sessionId = usePiStore((s) => s.sessionId);
  const sessionFile = usePiStore((s) => s.sessionFile);
  const sessionLabel = usePiStore((s) => s.sessionLabel);
  const sessionVersion = usePiStore((s) => s.sessionVersion);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const setSessionLabel = usePiStore((s) => s.setSessionLabel);
  const treeViewOpen = usePiStore((s) => s.treeViewOpen);
  const setTreeViewOpen = usePiStore((s) => s.setTreeViewOpen);
  const subagentSnapshot = usePiStore((s) => s.subagentSnapshot);
  const backgroundTaskSnapshot = usePiStore((s) => s.backgroundTaskSnapshot);
  const subagentActiveCount = (subagentSnapshot?.runs ?? []).filter(
    (r) => r.status === 'running' || r.status === 'queued'
  ).length;
  const backgroundTaskActiveCount = (backgroundTaskSnapshot?.tasks ?? []).filter(
    (task) => task.status === 'running' && task.sessionId === sessionId
  ).length;
  const [label, setLabel] = useState<string>('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [backgroundTaskOpen, setBackgroundTaskOpen] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // 优先用 store 中的 sessionLabel（切换会话时由侧栏即时写入，无需扫盘）
    if (sessionLabel) {
      setLabel(sessionLabel);
      return;
    }
    // 兜底：sessionLabel 缺失时（如初始化、导航树跳转）才走 listSessions 扫盘
    loadLabel();
  }, [sessionId, sessionFile, sessionVersion, sessionLabel]);

  const loadLabel = async () => {
    if (!sessionId && !sessionFile) {
      setLabel('');
      return;
    }
    try {
      const result = await window.pi.listSessions();
      const all = result.all || [];
      const current = all.find((s: any) => s.id === sessionId || s.path === sessionFile);
      if (current) {
        setLabel(
          current.name ||
            current.firstMessage?.substring(0, 40) ||
            current.id?.substring(0, 8) ||
            (current.path ? await window.pi.baseName(current.path) : '') ||
            ''
        );
      } else {
        setLabel('');
      }
    } catch {
      setLabel('');
    }
  };

  const handleReload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await window.pi.reloadSession();
      // 不调 getMessages()：拉全量历史（含 tool result）会在长会话上爆 contextBridge。
      // reload 不改 session.messages 内容，原 messages 在 store 里依然有效。
      setSessionLabel(null); // 清空缓存的 label，让 useEffect 重新走 listSessions
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-od-border bg-od-bg-alt px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isStreaming && <Icon name="spinner" spin className="w-3 shrink-0 text-od-accent" />}
          <span className="truncate text-sm font-semibold text-od-text-bright">
            {label || t.chatEmptyTitle}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={handleReload}
            disabled={reloading}
            className="flex items-center rounded-md px-1.5 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-50"
            title={t.reloadSession}
          >
            <Icon name="rotate" spin={reloading} className="w-3.5" />
          </button>
          <div className="relative">
            <button
              onClick={() => setMemoryOpen((v) => !v)}
              className="flex items-center rounded-md px-1.5 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.memory.panelTitle}
            >
              <Icon name="memory" className="w-3.5" />
            </button>
            {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
          </div>
          <div className="relative">
            <button
              onClick={() => {
                setSubagentOpen((v) => !v);
                setBackgroundTaskOpen(false);
              }}
              className={`flex items-center rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-od-bg-hover hover:text-od-text-bright ${
                subagentActiveCount > 0 ? 'text-od-accent' : 'text-od-text-dim'
              }`}
              title={t.subagents.panelTitle}
            >
              <Icon name="agents" className="w-3.5" />
              {subagentActiveCount > 0 && (
                <span className="ml-0.5 font-mono text-xs">{subagentActiveCount}</span>
              )}
            </button>
            <SubagentPanel open={subagentOpen} onClose={() => setSubagentOpen(false)} />
          </div>
          <div className="relative">
            <button
              onClick={() => {
                setBackgroundTaskOpen((v) => !v);
                setSubagentOpen(false);
              }}
              className={`flex items-center rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-od-bg-hover hover:text-od-text-bright ${
                backgroundTaskActiveCount > 0 ? 'text-od-accent' : 'text-od-text-dim'
              }`}
              title={t.backgroundTasks.panelTitle}
            >
              <Icon name="backgroundTasks" className="w-3.5" />
              {backgroundTaskActiveCount > 0 && (
                <span className="ml-0.5 font-mono text-xs">{backgroundTaskActiveCount}</span>
              )}
            </button>
            <BackgroundTaskPanel
              open={backgroundTaskOpen}
              onClose={() => setBackgroundTaskOpen(false)}
            />
          </div>
          <button
            onClick={() => setInfoOpen(true)}
            className="flex items-center rounded-md px-1.5 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.sessionInfoTitle}
          >
            <Icon name="info" className="w-3.5" />
          </button>
          <button
            onClick={() => setTreeViewOpen(true)}
            className="flex items-center rounded-md px-1.5 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.treeView}
          >
            <Icon name="tree" className="w-3.5" />
          </button>
        </div>
      </div>
      {treeViewOpen && <TreeView onClose={() => setTreeViewOpen(false)} />}
      {infoOpen && <SessionInfoModal onClose={() => setInfoOpen(false)} />}
    </>
  );
}
