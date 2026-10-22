/**
 * 快捷键执行层：动作 id → 具体行为。
 *
 * 与 `src/lib/shortcuts.ts`（纯函数：解析/格式化/冲突）分开，是为了让绑定规则
 * 可以在 node 下单测，而这里依赖 store、IPC 与 DOM。
 *
 * 约定：每个分支都从 `usePiStore.getState()` 取**执行时**的最新状态，
 * 不缓存渲染期的快照（全局监听只挂一次，闭包里拿到的状态会过期）。
 */
import { usePiStore } from '../store/pi-store';
import { transitionSession } from '../hooks/loadSession';
import { systemPrefersDark } from '../theme/applyTheme';
import { CHAT_INPUT_DOM_ID } from './app-commands';
import { sessionLabel } from './session-label';
import { t } from '../i18n/zh';
import type { ShortcutActionId } from './shortcuts';

/** 聚焦聊天输入框（ChatInput 的 textarea 带了固定 id） */
function focusChatInput(): void {
  document.getElementById(CHAT_INPUT_DOM_ID)?.focus();
}

/** 深浅色切换：system 时按当前解析结果取反，避免「点了没反应」 */
function toggleColorMode(): void {
  const { colorMode, setColorMode } = usePiStore.getState();
  const isDark = colorMode === 'dark' || (colorMode === 'system' && systemPrefersDark());
  setColorMode(isDark ? 'light' : 'dark');
}

/** 中止当前回合；goal 模式运行中与聊天区停止按钮一致（暂停目标） */
async function stopRunningTurn(): Promise<void> {
  const { mode, goalSnapshot, isStreaming } = usePiStore.getState();
  if (!isStreaming) return;
  if (mode === 'goal' && goalSnapshot?.goal?.status === 'active') {
    await window.pi.goal.pause();
    return;
  }
  await window.pi.abort();
}

/** 导出当前会话为 HTML（与侧栏右键菜单同一套 IPC，未落盘会话直接提示） */
async function exportCurrentSessionHtml(): Promise<void> {
  const { sessionFile, sessionName, showToast } = usePiStore.getState();
  if (!sessionFile) {
    showToast(t.shortcutsExportNoSession, { variant: 'error' });
    return;
  }
  // 文件名去掉非法字符；Windows 的会话路径用反斜杠，两种分隔符都要切
  const fileBase = sessionFile.split(/[\\/]/).pop() ?? '';
  const base = (sessionName || sessionLabel({ id: fileBase }))
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 60);
  try {
    const outputPath = await window.pi.saveDialog({
      title: t.ctxExportHtml,
      defaultPath: `${base || 'session'}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    });
    if (!outputPath) return;
    const result = await window.pi.exportSessionHtml(sessionFile, outputPath);
    if (!result?.ok) showToast(t.shortcutsActionFailed, { variant: 'error' });
  } catch (error) {
    showToast(t.shortcutsActionFailedWith(String(error)), { variant: 'error' });
  }
}

/** 重新加载当前会话（等价于聊天头部刷新按钮） */
async function reloadCurrentSession(): Promise<void> {
  try {
    await window.pi.reloadSession();
    usePiStore.getState().setSessionLabel(null);
  } catch (error) {
    usePiStore
      .getState()
      .showToast(t.shortcutsActionFailedWith(String(error)), { variant: 'error' });
  }
}

/**
 * 执行一个快捷键动作。调用方（useGlobalShortcuts / 设置页「测试」入口）
 * 已负责修饰键与焦点守卫，这里只管干活。
 */
export async function runShortcutAction(id: ShortcutActionId): Promise<void> {
  const store = usePiStore.getState();
  switch (id) {
    // === 会话 ===
    case 'session.new':
      // 与侧栏「新建会话」一致：旧会话留在后台继续跑完，不中止、不需要确认
      await transitionSession(() => window.pi.newSession());
      break;
    case 'session.search':
      store.setSessionSearchOpen(true);
      break;
    case 'session.tree':
      store.setTreeViewOpen(!store.treeViewOpen);
      break;
    case 'session.reload':
      await reloadCurrentSession();
      break;
    case 'session.exportHtml':
      await exportCurrentSessionHtml();
      break;

    // === 视图 ===
    case 'view.sidebar':
      store.setSidebarOpen(!store.sidebarOpen);
      break;
    case 'view.workspace':
      store.setRightPanelOpen(!store.rightPanelOpen);
      break;
    case 'view.workspaceMax':
      store.setRightPanelMaximized(!store.rightPanelMaximized);
      break;
    case 'view.terminal':
      store.setTerminalPanelOpen(!store.terminalPanelOpen);
      break;
    case 'view.todo':
      store.setTodoPanelOpen(!store.todoPanelOpen);
      break;
    case 'view.settings':
      store.setSettingsOpen(!store.settingsOpen);
      break;
    case 'view.theme':
      toggleColorMode();
      break;

    // === 对话 ===
    case 'chat.focusInput':
      focusChatInput();
      break;
    case 'chat.stop':
      await stopRunningTurn();
      break;
  }
}

export { CHAT_INPUT_DOM_ID };
