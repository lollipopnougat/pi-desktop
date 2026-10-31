/**
 * 渲染进程内的轻量命令总线：全局快捷键（window 级 keydown）需要触发「只存在于组件本地状态里」
 * 的能力时走这里。能直接改 store 的动作不要走总线，避免两套入口。
 *
 * 两处：① 右侧工作区的标签页顺序 / 激活态由 RightWorkspace 自己维护（codeTabs + 浏览器标签
 * 是 local state），数字快捷键（Mod+1..9）只能通过订阅回调让组件自己切换；
 * ② 聊天头部的记忆 / 子 agent 按钮要打开右侧工作区对应标签（同样是 RightWorkspace 的 local state）。
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

const memoryTabListeners = new Set<() => void>();

/** 请求打开（或激活）右侧工作区的「记忆」标签 */
export function requestOpenWorkspaceMemory(): void {
  for (const listener of [...memoryTabListeners]) listener();
}

export function onOpenWorkspaceMemory(listener: () => void): Unsubscribe {
  memoryTabListeners.add(listener);
  return () => {
    memoryTabListeners.delete(listener);
  };
}

const subagentTabListeners = new Set<() => void>();

/** 请求打开（或激活）右侧工作区的「子 agent」标签 */
export function requestOpenWorkspaceSubagents(): void {
  for (const listener of [...subagentTabListeners]) listener();
}

export function onOpenWorkspaceSubagents(listener: () => void): Unsubscribe {
  subagentTabListeners.add(listener);
  return () => {
    subagentTabListeners.delete(listener);
  };
}

const backgroundTaskTabListeners = new Set<() => void>();

/** 请求打开（或激活）右侧工作区的「后台任务」标签 */
export function requestOpenWorkspaceBackgroundTasks(): void {
  for (const listener of [...backgroundTaskTabListeners]) listener();
}

export function onOpenWorkspaceBackgroundTasks(listener: () => void): Unsubscribe {
  backgroundTaskTabListeners.add(listener);
  return () => {
    backgroundTaskTabListeners.delete(listener);
  };
}
