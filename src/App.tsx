import { useEffect, useState } from 'react';
import { usePiStore } from './store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import { applyTheme, onSystemColorChange } from './theme/applyTheme';
import { usePiEventSubscription } from './hooks/usePiEvent';
import { useMonacoSetup } from './hooks/useMonaco';
import { transitionSession } from './hooks/loadSession';
import { useSessionInit } from './hooks/useSessionInit';
import { useEventBindings } from './hooks/useEventBindings';
import ChatStream from './components/chat/ChatStream';
import ChatInput from './components/chat/ChatInput';
import ChatHeader from './components/chat/ChatHeader';
import Footer from './components/Footer';
import SessionSidebar from './components/session/SessionSidebar';
import SettingsPage from './components/SettingsPage';
import RightWorkspace from './components/workspace/RightWorkspace';
import WorkspacePanel from './components/workspace/WorkspacePanel';
import TodoPanel from './components/chat/TodoPanel';
import McpStatusModal from './components/chat/McpStatusModal';
import CompactionToast from './components/chat/CompactionToast';
import ToastHost from './components/common/ToastHost';
import StopRunningConfirm from './components/common/StopRunningConfirm';
import { confirmStopRunning } from './lib/stopRunningConfirm';
import TerminalPanel from './components/terminal/TerminalPanel';
import GoalEditDialog from './components/goal/GoalEditDialog';
import TodoProgressCapsule from './components/chat/TodoProgressCapsule';
import PanelIcon from './components/common/PanelIcon';
import TitleMenuBar from './components/common/TitleMenuBar';
import Icon from './components/common/Icon';
import { t } from './i18n/zh';

export default function App() {
  usePiEventSubscription();
  useMonacoSetup();
  // useShallow：逐字段比较，流式/工具执行等无关字段变化不再重渲染整个 App 树
  const {
    settingsOpen,
    isCompacting,
    isSessionLoading,
    retryInfo,
    rightPanelOpen,
    rightPanelMaximized,
    sidebarOpen,
    terminalPanelOpen,
    treeViewOpen,
    fontSize,
    rightPanelWidth,
    todoPanelOpen,
    uiFontFamily,
    themeFamily,
    colorMode,
    // actions：zustand 的 action 引用稳定（store 创建时定义），订阅不会触发多余重渲染
    // 仅保留 App JSX 直接用到的；init/切换/事件订阅的 action 在 useSessionInit/useEventBindings 内订阅
    setSettingsOpen,
    setSidebarOpen,
    setTerminalPanelOpen,
    setRightPanelOpen,
    setTodoPanelOpen,
    setRightPanelWidth
  } = usePiStore(
    useShallow((s) => ({
      settingsOpen: s.settingsOpen,
      isCompacting: s.isCompacting,
      isSessionLoading: s.isSessionLoading,
      retryInfo: s.retryInfo,
      rightPanelOpen: s.rightPanelOpen,
      rightPanelMaximized: s.rightPanelMaximized,
      sidebarOpen: s.sidebarOpen,
      terminalPanelOpen: s.terminalPanelOpen,
      treeViewOpen: s.treeViewOpen,
      fontSize: s.fontSize,
      rightPanelWidth: s.rightPanelWidth,
      todoPanelOpen: s.todoPanelOpen,
      uiFontFamily: s.uiFontFamily,
      themeFamily: s.themeFamily,
      colorMode: s.colorMode,
      setSettingsOpen: s.setSettingsOpen,
      setSidebarOpen: s.setSidebarOpen,
      setTerminalPanelOpen: s.setTerminalPanelOpen,
      setRightPanelOpen: s.setRightPanelOpen,
      setTodoPanelOpen: s.setTodoPanelOpen,
      setRightPanelWidth: s.setRightPanelWidth
    }))
  );
  const [initialized, setInitialized] = useState(false);
  const isMac = window.pi?.platform === 'darwin';

  // Apply font size to root element so all rem-based sizes scale
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  // Apply UI font family via CSS variable（未显式指定 font-family 的 UI 元素都会跟随）
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font', uiFontFamily);
  }, [uiFontFamily]);

  // 应用主题：主题族或明暗变化时重应用
  useEffect(() => {
    applyTheme(themeFamily, colorMode);
  }, [themeFamily, colorMode]);

  // colorMode === 'system' 时跟随系统明暗反转热切换
  useEffect(() => {
    if (colorMode !== 'system') return;
    return onSystemColorChange(() => applyTheme(usePiStore.getState().themeFamily, 'system'));
  }, [colorMode]);

  // 会话初始化 + 切换、菜单/ask/plan/stats 事件订阅
  useSessionInit(initialized, setInitialized);
  useEventBindings();

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-od-text-dim">{t.loading}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top status bar - drag region for macOS traffic lights
          毛玻璃：标题栏不铺背景色，露出原生 vibrancy 层；底色由下方主区域负责。
          设置页/会话树全屏面板打开时隐藏标题栏按钮（面板顶部透玻璃，按钮露出会穿透点击） */}
      <div
        className="flex items-center justify-between border-b border-od-border py-1.5 text-xs text-od-text"
        style={
          {
            paddingTop: isMac ? '8px' : undefined,
            height: isMac ? '40px' : '38px',
            WebkitAppRegion: 'drag'
          } as React.CSSProperties
        }
      >
        {/* 左侧分组本身不标 no-drag（继承外层 drag，含 macOS 红绿灯前的留白），
            交互元素各自标 no-drag */}
        <div className="flex items-center gap-2" style={{ paddingLeft: isMac ? '80px' : '16px' }}>
          {/* 会话面板开关（VSCode 风格侧栏图标）——全屏面板打开时隐藏 */}
          {!(settingsOpen || treeViewOpen) && (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
                sidebarOpen ? 'titlebar-btn-active' : ''
              }`}
              title={t.toggleSidebar}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <PanelIcon name="sidebar" size={16} />
            </button>
          )}

          {/* 标题不可选中且穿透光标事件，点击它时由下方的 drag 区域接管窗口拖拽 */}
          <span className="pointer-events-none ml-1 select-none text-sm font-semibold tracking-wide text-od-text-bright">
            {t.appName}
          </span>
          {/* Windows/Linux 自定义菜单栏（标题后面）——全屏面板打开时隐藏 */}
          {!isMac && !(settingsOpen || treeViewOpen) && (
            <TitleMenuBar
              onOpenFolder={async () => {
                const dir = await window.pi.selectDirectory();
                if (!dir) return;
                // 切换项目目录会重建 runtime（中止当前轮），运行中先确认
                if (!(await confirmStopRunning(t.stopRunningActionCwd))) return;
                await transitionSession(() => window.pi.setCwd(dir));
              }}
              onOpenSettings={() => {
                setSettingsOpen(true);
              }}
              onAbout={() => {
                window.pi.showAbout();
              }}
            />
          )}

          {isSessionLoading && (
            <span className="flex items-center gap-1 text-od-text-dim">
              <Icon name="spinner" spin className="w-3" />
              {t.sessionLoading}
            </span>
          )}
          {isCompacting && (
            <span className="flex items-center gap-1 text-od-yellow">
              <Icon name="spinner" spin className="w-3" />
              {t.compacting}
            </span>
          )}
          {retryInfo && (
            <span className="flex items-center gap-1 text-od-orange">
              <Icon name="retry" spin className="w-3" />
              {t.retrying(retryInfo.attempt, retryInfo.maxAttempts)}
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-2"
          style={
            {
              paddingRight: isMac ? '16px' : '150px',
              WebkitAppRegion: 'no-drag'
            } as React.CSSProperties
          }
        >
          {/* 全屏面板打开时隐藏右侧全部按钮 */}
          {!(settingsOpen || treeViewOpen) && (
            <>
              {/* 终端面板开关（VSCode 风格底部面板图标） */}
              <button
                onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
                className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
                  terminalPanelOpen ? 'titlebar-btn-active' : ''
                }`}
                title={t.toggleTerminal}
              >
                <PanelIcon name="panel" size={16} />
              </button>
              {/* 右侧工作区开关（代码 / Diff / 浏览器） */}
              <button
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
                  rightPanelOpen ? 'titlebar-btn-active' : ''
                }`}
                title={rightPanelOpen ? t.hideWorkspace : t.showWorkspace}
              >
                <PanelIcon name="auxiliary" size={16} />
              </button>
              {/* TODO 面板开关 */}
              <button
                onClick={() => setTodoPanelOpen(!todoPanelOpen)}
                className={`titlebar-btn flex h-7 w-7 items-center justify-center rounded-md ${
                  todoPanelOpen ? 'titlebar-btn-active' : ''
                }`}
                title={t.toggleTodo}
              >
                <Icon name="todo" className="w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main 3-column layout */}
      {/* 毛玻璃：主容器不铺底色——侧栏区域透明露玻璃，聊天/代码区自己铺 bg-od-bg */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Session Sidebar */}
        <SessionSidebar />

        <div className="flex flex-1 min-w-0 overflow-hidden">
          {/* Center: Chat + Terminal (vertical split) */}
          <div
            ref={(element) => {
              if (element) element.inert = rightPanelOpen && rightPanelMaximized;
            }}
            className="flex flex-1 min-w-0 flex-col overflow-hidden bg-od-bg"
          >
            {/* Chat area takes remaining vertical space */}
            <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
              <ChatHeader />
              <TodoProgressCapsule />
              <ChatStream />
              <ChatInput />
            </div>
            {/* Bottom: Terminal Panel */}
            <TerminalPanel />
          </div>

          {/* Right: unified workspace (files / diffs / browser) */}
          <WorkspacePanel
            open={rightPanelOpen}
            maximized={rightPanelMaximized}
            width={rightPanelWidth}
            onResize={(delta) => setRightPanelWidth(rightPanelWidth - delta)}
          >
            <RightWorkspace />
          </WorkspacePanel>
        </div>
      </div>

      {/* Footer */}
      <Footer />

      {/* Compaction Toast */}
      <CompactionToast />

      {/* 全局 Toast（文件上传拒绝等非阻断提示） */}
      <ToastHost />

      {/* 「会话正在运行」停止执行确认（切换/新建会话、fork、切换项目、退出） */}
      <StopRunningConfirm />

      {/* TODO Panel（右上角浮动） */}
      {todoPanelOpen && <TodoPanel open={todoPanelOpen} onClose={() => setTodoPanelOpen(false)} />}

      {/* Settings Modal */}
      {settingsOpen && <SettingsPage />}

      {/* MCP 状态弹窗（/mcp 命令触发） */}
      <McpStatusModal />

      {/* Goal 编辑弹窗 */}
      <GoalEditDialog />
    </div>
  );
}
