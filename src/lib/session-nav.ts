/**
 * 会话导航历史（标题栏左上角的前进/后退按钮）。
 *
 * 语义与浏览器一致：每打开一个会话压一条历史；从历史中间跳转后再打开新会话会丢掉「前进」
 * 分支；最多保留 MAX_SESSION_NAV 条。
 *
 * 两条约定（改之前先读）：
 * 1. **记录点只有 `transitionSession` 成功之后一处**（`recordCurrentSessionNav`）。
 *    不要在 `setSessionInfo` 里记——同一 sessionId 的 reload / navigateTree / fork 也会走它，
 *    那会把「重载一次」记成一条新历史，后退键就退到同一个会话上了。
 * 2. **前进/后退自己不能再压历史**：`navigateSessionHistory` 传 `recordNav: false`，
 *    成功后才把下标挪过去。否则点一次后退会新增一条记录，历史立刻长成环。
 *
 * 历史不持久化（重启后从当前会话重新开始）：后台会话在重启后没有槽，退回去也切不到。
 */
import { transitionSession } from '../hooks/loadSession';
import { usePiStore } from '../store/pi-store';

export function canGoBack(index: number): boolean {
  return index > 0;
}

export function canGoForward(index: number, length: number): boolean {
  return index >= 0 && index < length - 1;
}

/**
 * 沿历史跳到指定下标（后退/前进与「最近会话」菜单共用）。
 * `recordNav: false` 是关键：跳历史不能把自己再记成一步，否则历史会成环。
 */
export async function jumpToSessionNav(index: number): Promise<boolean> {
  const state = usePiStore.getState();
  const entry = state.sessionNav[index];
  if (!entry) return false;
  if (index === state.sessionNavIndex) return false; // 已经在这一项上
  const ok = await transitionSession(() => window.pi.switchSession(entry.target), entry.label, {
    recordNav: false
  });
  if (ok) usePiStore.getState().setSessionNavIndex(index);
  return ok;
}

/**
 * 沿历史前进/后退一格。
 * @param direction -1 后退，1 前进
 * @returns 是否真的切过去了（已在两端 / 切换失败均为 false）
 */
export async function navigateSessionHistory(direction: -1 | 1): Promise<boolean> {
  return jumpToSessionNav(usePiStore.getState().sessionNavIndex + direction);
}
