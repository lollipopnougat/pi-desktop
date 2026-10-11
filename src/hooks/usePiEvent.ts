import { useEffect, useRef } from 'react';
import { usePiStore } from '../store/pi-store';
import { TokenRateTracker } from '../utils/token-rate';
import { t } from '../i18n/zh';

import { messageKey, mergeSessionMessages } from '../utils/session-messages';
import { isCurrentSession } from './loadSession';

/**
 * Subscribes to pi SDK events via IPC and dispatches them to the Zustand store.
 * Mount this once at the app root.
 */
export function usePiEventSubscription() {
  const {
    setStreaming,
    setCompacting,
    setRetry,
    setQueue,
    setMessages,
    setStreamingMessage,
    setThinkingLevel,
    updateToolExecution,
    setGoalSnapshot
  } = usePiStore();

  // 流式输出速率追踪：message_start 重置，message_update 喂入，结束时清零。
  // 放 ref 而非 store：tracker 是可变类实例，且只服务事件层。
  const rateTrackerRef = useRef<TokenRateTracker>(new TokenRateTracker());
  // 限频（500ms）写 store：delta 事件高频，数值本身已 EMA 平滑，
  // 没必要每事件重渲染；间隔 fast 可感知已足够。
  const lastRatePushRef = useRef(0);
  const pushRate = (v: number) => {
    const now = Date.now();
    if (now - lastRatePushRef.current >= 500) {
      lastRatePushRef.current = now;
      usePiStore.getState().setStreamRate(v);
    }
  };

  useEffect(() => {
    const unsubscribe = window.pi.onEvent(async (event: any) => {
      if (!isCurrentSession(event)) return;
      switch (event.type) {
        // === Agent lifecycle ===
        case 'agent_start':
          setStreaming(true);
          // 打点本轮回复开始时间（从用户点击发送 → 回答结束）
          usePiStore.getState().setReplyStartedAt(Date.now());
          break;

        case 'agent_settled': {
          setStreaming(false);
          rateTrackerRef.current.reset();
          lastRatePushRef.current = 0;
          usePiStore.getState().setStreamRate(0);
          usePiStore.getState().setReplyStartedAt(null);
          // 对话轮次完成通知（是否弹出由主进程按通知设置 + 窗口聚焦裁决）
          const label = usePiStore.getState().sessionLabel;
          window.pi
            .notify('turnEnd', t.notifyTurnEndTitle, label ? label : undefined)
            .catch(() => {});
          // 兜底清理 streamingMessage：message_end 正常会清，但若 message_end
          // 因任何原因未到达（IPC 抖动、异常终止等），残留的 streamingMessage
          // 会在历史消息下方悬留一条幽灵流式消息。
          setStreamingMessage(null);
          setRetry(null);
          usePiStore.getState().refreshStats();
          break;
        }

        // === Messages ===
        case 'message_start':
          if (event.message?.role === 'assistant') {
            setStreamingMessage(event.message);
            // 新一轮 assistant 输出：重置滑动窗口并清零速率（本轮 usage 从 0 累计，
            // 若不清零会短暂沿用上一轮速率，窗口重叠导致 dt≈0 出现虚高峰值）。
            rateTrackerRef.current.reset();
            lastRatePushRef.current = 0;
            usePiStore.getState().setStreamRate(0);
          }
          break;

        case 'message_update':
          if (event.assistantMessageEvent) {
            const ame = event.assistantMessageEvent;
            // 喂速率追踪器：ame.partial 是完整 AssistantMessage，含累计 usage/content。
            // event.message 与 partial 通常是同一对象，partial 更可靠（SDK 契约保证存在）。
            rateTrackerRef.current.record(ame.partial ?? event.message);
            // UI 显示 EMA 平滑后的速率，避免原始窗口速率跳变闪烁；限频写 store
            pushRate(rateTrackerRef.current.smoothedRate());
            // Update streaming message partial
            if (event.message) {
              setStreamingMessage(event.message);
            }
          }
          break;

        case 'message_end':
          // /goal 无参数:主进程发 custom 消息通知切模式
          if (
            event.message?.role === 'custom' &&
            (event.message as any).customType === 'goal-mode-activate'
          ) {
            usePiStore.getState().setMode('goal');
            break;
          }
          if (event.message?.role === 'assistant') {
            setStreamingMessage(null);
            lastRatePushRef.current = 0;
            usePiStore.getState().setStreamRate(0);
            // 立即将完成的 assistant 消息追加到列表，避免多 turn 场景下
            // （思考块 → 工具调用 → 继续回复）中间 turn 的内容被刷掉。
            // agent_end 时会增量合并，不会重复。
            const assistantMsg = event.message;
            const cur = usePiStore.getState().messages;
            // 去重：用复合键（见 messageKey），避免仅按 timestamp 误杀同毫秒消息
            if (!cur.some((m: any) => messageKey(m) === messageKey(assistantMsg))) {
              setMessages([...cur, assistantMsg]);
            }
          } else if (event.message?.role === 'user') {
            // 用户消息立即追加到列表，避免发送后看不到自己的输入。
            // agent_end 时会增量合并，不会重复。
            // 但 goal 自动续跑消息（含 <!-- goal-continuation --> marker）不显示
            const userMsg = event.message;
            const text =
              typeof userMsg.content === 'string'
                ? userMsg.content
                : Array.isArray(userMsg.content)
                  ? userMsg.content.map((c: any) => c?.text || '').join('')
                  : '';
            if (/<!-- goal-continuation: [\w:-]+ -->/.test(text)) {
              return; // 隐藏续跑消息
            }
            const cur = usePiStore.getState().messages;
            // 去重：用复合键（见 messageKey）
            if (!cur.some((m: any) => messageKey(m) === messageKey(userMsg))) {
              setMessages([...cur, userMsg]);
            }
            // 新会话首条消息：SDK 有「无 assistant 不写盘」保护，首条 user 消息在
            // assistant 回复前不会落盘，listSessions 扫盘读不到，侧栏/标题区拿不到
            // firstMessage。这里用首条用户消息文本前缀立即设置 sessionLabel，让聊天
            // 区标题即时回显（侧栏会话项仍需等落盘后出现）。
            const store = usePiStore.getState();
            if (!store.sessionLabel) {
              // 纯图片消息（text 为空但有 image block）用占位标题
              const hasImage =
                Array.isArray(userMsg.content) &&
                userMsg.content.some((c: any) => c?.type === 'image');
              const label = text ? text.substring(0, 40) : hasImage ? '[图片]' : '';
              if (label) store.setSessionLabel(label);
            }
          }
          break;

        case 'agent_end':
          // agent_end.messages 只包含本轮新增消息（prompts + assistant 回复）。
          // 增量合并到现有 messages，避免调 getMessages() 全量拉取导致 contextBridge 崩溃。
          // 防重：用消息内容复合键（见 messageKey）。
          // 同时隐藏 goal 自动续跑消息（含 marker）。
          setStreamingMessage(null);
          setMessages(mergeSessionMessages(usePiStore.getState().messages, event.messages || []));
          // 会话内容更新（首条消息等），刷新会话列表
          usePiStore.getState().bumpSessionVersion();
          break;

        // === Tool execution ===
        case 'tool_execution_start':
          updateToolExecution(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            status: 'running'
          });
          break;

        case 'tool_execution_update':
          updateToolExecution(event.toolCallId, {
            result: event.partialResult
          });
          break;

        case 'tool_execution_end':
          updateToolExecution(event.toolCallId, {
            status: event.isError ? 'error' : 'success',
            result: event.result,
            isError: event.isError
          });
          // update_plan 工具返回的任务清单同步到 TodoPanel
          if (event.toolName === 'update_plan' && !event.isError && event.result?.details?.phases) {
            usePiStore.getState().setTodoPhases(event.result.details.phases);
          }
          break;

        // === Queue ===
        case 'queue_update':
          setQueue({
            steering: event.steering || [],
            followUp: event.followUp || []
          });
          break;

        // === Compaction ===
        case 'compaction_start':
          setCompacting(true);
          break;

        case 'compaction_end':
          setCompacting(false);
          break;

        // === Thinking level ===
        case 'thinking_level_changed':
          setThinkingLevel(event.level ?? 'off');
          break;

        // === Retry ===
        case 'auto_retry_start':
          setRetry({
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage
          });
          break;

        case 'auto_retry_end':
          if (event.success) {
            setRetry(null);
          } else {
            setRetry({
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              errorMessage: event.finalError || 'Retry failed'
            });
          }
          break;
      }
    });

    // Goal 状态更新订阅
    const unsubGoal = window.pi.onGoalUpdate((snapshot, identity) => {
      if (!isCurrentSession(identity)) return;
      setGoalSnapshot(snapshot);
    });

    // Plan 状态更新订阅(阶段切换 / pending 变化)
    const unsubPlan = window.pi.onPlanUpdate((snapshot, identity) => {
      if (!isCurrentSession(identity)) return;
      usePiStore.getState().setPlanSnapshot(snapshot);
      // 方案批准后主进程退出 plan 回 idle:同步把渲染端收藏的 mode 切回 standard,
      // 避免停留在「规划模式」UI 标志(误显) — setMode 内部调 setPlanMode(false) 幂等
      if (snapshot.phase === 'idle') {
        const cur = usePiStore.getState().mode;
        if (cur === 'plan') {
          usePiStore.getState().setMode('standard');
        }
      }
    });

    // Subagent 状态更新订阅(run 进度/状态变化)
    const unsubSubagent = window.pi.onSubagentUpdate((snapshot, identity) => {
      if (!isCurrentSession(identity)) return;
      usePiStore.getState().setSubagentSnapshot(snapshot);
    });

    // 后台任务状态以主进程持久快照为真相；推送仅用于实时刷新。
    const unsubBackgroundTasks = window.pi.onBackgroundTaskUpdate((snapshot) => {
      usePiStore.getState().setBackgroundTaskSnapshot(snapshot);
    });
    void window.pi.backgroundTasks
      .getSnapshot()
      .then((snapshot) => usePiStore.getState().setBackgroundTaskSnapshot(snapshot))
      .catch(() => {});

    return () => {
      unsubscribe();
      unsubGoal();
      unsubPlan();
      unsubSubagent();
      unsubBackgroundTasks();
    };
  }, []);
}
