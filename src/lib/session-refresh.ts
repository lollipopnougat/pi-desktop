/**
 * 会话列表 / 聊天标题 / 会话树的刷新调度器。
 *
 * 一次 `agent_end` 会 `bumpSessionVersion()`，而侧栏、标题栏、会话树各自监听它 ——
 * 三个消费者会各拉一次 IPC、各自重渲染；多会话后台运行时会叠成一片抖动。
 * 这里把「版本驱动的刷新」合并：短时间去抖（最长不超过 1s）后只刷一次。
 *
 * 用户主动操作（切换 / 新建 / 删除 / 重命名 / 复制）应调用 `flushSessionRefresh()`：
 * 立即通知并取消挂起的定时器，避免随后再来一次重复刷新。
 */
const DEBOUNCE_MS = 300;
const MAX_DELAY_MS = 1000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;
let firstScheduledAt = 0;

function notify(): void {
  // 复制一份：回调里可能退订 / 订阅
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (e) {
      console.error('session refresh listener failed:', e);
    }
  }
}

/** 订阅刷新通知（返回退订函数） */
export function subscribeSessionRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 请求一次刷新：300ms 内的多次请求合并成一次；从第一次请求算起最长 1s 必定刷一次 */
export function scheduleSessionRefresh(): void {
  const now = Date.now();
  if (timer === null) firstScheduledAt = now;
  else clearTimeout(timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstScheduledAt + MAX_DELAY_MS - now));
  timer = setTimeout(() => {
    timer = null;
    notify();
  }, wait);
}

/** 立即刷新并取消挂起的定时器（用户主动操作后调用） */
export function flushSessionRefresh(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  notify();
}
