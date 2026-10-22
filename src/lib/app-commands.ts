/**
 * 渲染进程内的轻量命令总线：全局快捷键（window 级 keydown）需要触发「只存在于组件本地状态里」
 * 的能力时走这里。能直接改 store 的动作不要走总线，避免两套入口。
 *
 * 目前只有一处：右侧工作区的标签页顺序 / 激活态由 RightWorkspace 自己维护（codeTabs + 浏览器标签
 * 是 local state），数字快捷键（Mod+1..9）只能通过订阅回调让组件自己切换。
 */
type Unsubscribe = () => void;

/** 聊天输入框 textarea 的 DOM id：`chat.focusInput` 快捷键靠它聚焦（避开 ref 传递） */
export const CHAT_INPUT_DOM_ID = 'pi-chat-input';

const workspaceTabListeners = new Set<(index: number) => void>();

/** 请求激活右侧工作区第 index 个标签（0 基；越界由订阅方忽略） */
export function requestSelectWorkspaceTab(index: number): void {
  for (const listener of [...workspaceTabListeners]) listener(index);
}

export function onSelectWorkspaceTab(listener: (index: number) => void): Unsubscribe {
  workspaceTabListeners.add(listener);
  return () => {
    workspaceTabListeners.delete(listener);
  };
}
