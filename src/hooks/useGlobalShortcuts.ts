/**
 * 全局快捷键监听（在 App 根挂载一次）。
 *
 * 设计要点：
 * - **capture 阶段挂在 window 上**：窗口内任何焦点（聊天输入框 / Monaco / 下拉菜单）里按下的
 *   组合键都能先到这里；因为所有默认绑定都带修饰键（Mod = ⌘ / Ctrl），不会影响正常输入。
 * - **每次 keydown 都从 `usePiStore.getState()` 取绑定表**：设置页改键后立即生效，
 *   不需要重新订阅，也不存在闭包里的过期快照。
 * - **改键捕获期间让路**：设置页录制按键时 `shortcutCaptureId` 非空，这里直接 return，
 *   否则「按 ⌘N 改键」会顺手新建一个会话。
 * - **全屏浮层（设置页 / 会话树）里只放行对应开关**，避免在浮层遮住界面时误触后台面板。
 * - 数字快捷键（Mod+1..9）不写进绑定表：它是「一类按键」而不是单个动作，
 *   由 `shortcutNumberKeys` 单独开关，用户自定义绑定优先于它。
 */
import { useEffect } from 'react';
import { usePiStore } from '../store/pi-store';
import { SHORTCUT_ACTIONS, bindingFromKeyboardEvent, normalizeBinding } from '../lib/shortcuts';
import { runShortcutAction } from '../lib/shortcut-commands';
import { requestSelectWorkspaceTab } from '../lib/app-commands';

const DIGIT_BINDING_RE = /^Mod\+([1-9])$/;

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const isMac = window.pi?.platform === 'darwin';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const store = usePiStore.getState();
      // 设置页正在录键：全局快捷键必须完全让路
      if (store.shortcutCaptureId) return;

      const binding = bindingFromKeyboardEvent(event, isMac);
      if (!binding) return;

      const overlay = store.settingsOpen ? 'settings' : store.treeViewOpen ? 'tree' : null;

      // 用户自定义绑定优先（含把某个动作绑到 Mod+1 的场景）
      let actionId: string | null = null;
      for (const action of SHORTCUT_ACTIONS) {
        const value = store.shortcuts[action.id];
        if (!value) continue;
        if (normalizeBinding(value) === binding) {
          actionId = action.id;
          break;
        }
      }

      if (actionId) {
        if (overlay === 'settings' && actionId !== 'view.settings') return;
        if (overlay === 'tree' && actionId !== 'session.tree' && actionId !== 'view.settings') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void runShortcutAction(actionId as Parameters<typeof runShortcutAction>[0]);
        return;
      }

      // 数字快捷键：切换右侧工作区标签
      const digit = DIGIT_BINDING_RE.exec(binding);
      if (digit && store.shortcutNumberKeys === 'workspace' && !overlay) {
        event.preventDefault();
        event.stopPropagation();
        if (!store.rightPanelOpen) store.setRightPanelOpen(true);
        requestSelectWorkspaceTab(Number(digit[1]) - 1);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
