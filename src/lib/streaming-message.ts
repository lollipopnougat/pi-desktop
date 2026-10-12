import type { ChatMessage } from '../components/chat/chat-items';

/**
 * 流式回复（正在生成的 assistant 消息）的承载模块。
 *
 * 为什么不放全局 store：`message_update` 每个 token 一次，往 store 写会通知**所有**订阅者
 * （输入框、页脚、侧栏、工具卡片…）逐个跑 selector，与流式内容无关的组件也被拖进重渲染。
 * 这里把它降级为「模块级状态 + 显式订阅」，只有真正渲染流式内容的组件才订阅；同时用
 * rAF 合帧把更新频率压到每帧一次（主进程侧另有 ~30ms 合帧，见 pi-bridge 的 rebind）。
 */

type Listener = () => void;

let current: ChatMessage | null = null;
let frame: number | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  // 复制一份再遍历：监听器可能在回调里退订
  for (const listener of Array.from(listeners)) listener();
}

function cancelFrame(): void {
  if (frame === null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  else clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
  frame = null;
}

/** 合并同一帧内的多次更新：只保留最后一个快照（事件本身就是全量快照）。 */
function schedule(): void {
  if (frame !== null) return;
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(() => {
      frame = null;
      notify();
    });
  } else {
    // 非浏览器环境（测试/SSR）退化为宏任务
    frame = setTimeout(() => {
      frame = null;
      notify();
    }, 16) as unknown as number;
  }
}

/**
 * 更新流式消息。传 null 表示本轮结束（message_end / agent_settled / 切换会话）。
 *
 * 清空必须同步生效：它与「最终消息入列」是同一次 React 提交，晚一帧会看到
 * 「历史里已有完整回复 + 末尾还挂着一条流式消息」的重复闪动。
 */
export function setStreamingMessage(message: ChatMessage | null): void {
  current = message;
  if (message === null) {
    cancelFrame();
    notify();
    return;
  }
  schedule();
}

export function getStreamingMessage(): ChatMessage | null {
  return current;
}

export function subscribeStreamingMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
