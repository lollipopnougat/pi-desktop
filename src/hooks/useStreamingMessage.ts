import { startTransition, useEffect, useState } from 'react';
import { getStreamingMessage, subscribeStreamingMessage } from '../lib/streaming-message';
import type { ChatMessage } from '../components/chat/chat-items';

/**
 * 订阅流式回复。只有真正渲染流式内容的组件才用它（见 ChatStream 的 StreamingTail）。
 *
 * - 内容增长走 `startTransition`：渲染优先级让给输入框，流式期间打字不再被抢占。
 * - 清空走同步 setState：message_end / agent_settled 必须和「最终消息入列」同一帧提交。
 * - 函数式更新读「应用时」的最新值：被中断或合并掉的旧 transition 不会把过期快照写回。
 */
export function useStreamingMessage(): ChatMessage | null {
  const [message, setMessage] = useState<ChatMessage | null>(() => getStreamingMessage());
  useEffect(
    () =>
      subscribeStreamingMessage(() => {
        if (getStreamingMessage() === null) {
          setMessage(null);
          return;
        }
        startTransition(() => setMessage(() => getStreamingMessage()));
      }),
    []
  );
  return message;
}
