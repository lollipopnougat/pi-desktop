/**
 * 「会话正在运行」停止执行确认闸门。
 *
 * 所有会中止在跑回合的操作（切换会话、新建会话、fork/切换节点、切换项目目录、退出应用）
 * 都必须先过这里：
 * - 没有在跑 → 直接放行，不弹窗（零打扰）
 * - 正在跑 → 弹应用内确认框（全局单例 StopRunningConfirm），用户确认后先 abort
 *   并把已生成的部分回复落盘，再执行原操作
 *
 * 弹窗本体挂在 App 根部（唯一实例），Promise resolver 存在模块级变量里，
 * 避免把 resolver 塞进 zustand store。
 */
import { usePiStore } from '../store/pi-store';
import { t } from '../i18n/zh';

type Waiting = (ok: boolean) => void;

/** 当前等待回答的 resolver（同一时刻只允许一个确认框） */
let waiting: Waiting | null = null;

/** 打开确认框并等待用户回答 */
function open(payload: { title: string; message: string; confirmText: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    waiting = resolve;
    usePiStore.getState().setStopRunningConfirm(payload);
  });
}

/** 是否已有确认框在等待回答（弹窗是单例，不允许被后继动作覆盖） */
function isWaiting(): boolean {
  return waiting !== null;
}

/**
 * 会话正在运行时请求用户确认。返回 true 表示可以继续执行原操作。
 * 不在运行时立即返回 true（不弹窗）。
 */
export async function confirmStopRunning(action: string): Promise<boolean> {
  if (!(await isTurnRunning())) return true;
  // 已有确认框在等回答（例如弹出后才从原生菜单触发的动作）：不覆盖，本次动作不继续，
  // 保留用户正在看的那个问题，避免弹窗文案被静默换成另一个动作。
  if (isWaiting()) return false;
  return open({
    title: t.stopRunningTitle,
    message: t.stopRunningMessage(action),
    confirmText: t.stopRunningConfirm(action)
  });
}

/**
 * 当前是否真的有一轮在跑。
 *
 * 以渲染进程 store 的 isStreaming 为主（秒回）；store 说没在跑时再向主进程核对一次，
 * 覆盖「关窗重开 / 状态未同步」这类 store 落后于 session 的情况 —— 否则会静默掐掉
 * 正在跑的回复而不给任何提示。核对失败（IPC 异常）不阻断原操作。
 */
async function isTurnRunning(): Promise<boolean> {
  if (usePiStore.getState().isStreaming) return true;
  try {
    const state = await window.pi.getState();
    return state?.isStreaming === true;
  } catch {
    return false;
  }
}

/** 弹窗回答（由 StopRunningConfirm 组件调用） */
export function resolveStopRunning(ok: boolean): void {
  const resolve = waiting;
  waiting = null;
  usePiStore.getState().setStopRunningConfirm(null);
  resolve?.(ok);
}

/**
 * 主进程请求「退出前确认」：必须给主进程回话（true 才会真正退出）。
 * 已有确认框在等回答时不覆盖，直接回 false（保持当前操作优先，不叠加弹窗）。
 */
export function handleQuitConfirmRequest(): void {
  if (waiting) {
    void window.pi.resolveQuitConfirm(false);
    return;
  }
  waiting = (ok: boolean) => {
    void window.pi.resolveQuitConfirm(ok);
  };
  usePiStore.getState().setStopRunningConfirm({
    title: t.stopRunningTitle,
    message: t.stopRunningMessage(t.stopRunningActionQuit),
    confirmText: t.stopRunningConfirm(t.stopRunningActionQuit)
  });
}

/**
 * 中止当前回合并等待落盘（abort 内部会 waitForIdle 后才返回）。
 * 用户确认「停止执行」后必须先调用它：SDK 的 navigateTree 等在流式中会直接抛错，
 * 其余路径也要靠这段等待把已生成的部分回复写进会话文件。
 */
export async function abortRunningTurn(): Promise<void> {
  try {
    await window.pi.abort();
  } catch {
    // abort 失败不阻断后续操作（切换会话等路径 SDK 内部还会再 abort 一次）
  }
}
