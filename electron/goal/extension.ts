/**
 * Goal 模式内联扩展工厂。
 *
 * 关键事实(经 SDK 源码核实):
 * - noExtensions: true 只关闭"用户/CLI 扩展"加载,extensionFactories 内联扩展始终加载
 * - 内联扩展获得全部 ExtensionAPI 能力:pi.on(可拦截事件)/registerTool/registerCommand
 *   /sendUserMessage/appendEntry/setActiveTools
 * - ctx(ExtensionContext)提供 isIdle/abort/hasPendingMessages/getContextUsage/sessionManager
 *
 * 注册的事件钩子是自主推进引擎:
 * - before_agent_start: 注入 goal 系统提示(每轮自动重注入,无脆弱点)
 * - tool_call: 停止态/budget wrap-up 拦截工具(block + abort 防循环)
 * - agent_end: 分类 stopReason,请求续跑
 * - agent_settled: 派发续跑 followUp
 * - input: 区分用户输入 vs 自己的续跑(重置 safety epoch)
 * - session_start: 从 session entry 恢复 goal 状态
 * - session_before_compact: flush 用量
 * - message_end: 取 assistant 文本做无进展指纹
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { GoalController } from './controller';
import { createGoalTools } from './tools';
import { buildGoalSystemPrompt, buildContinuePrompt, buildGoalActivationPrompt } from './prompts';

export function goalExtensionFactory(controller: GoalController): InlineExtension {
  return {
    name: 'goal',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const rt = controller.rt;

      // ─── 注册工具 ───
      const { goalCompleteTool, goalBlockedTool } = createGoalTools(controller);
      pi.registerTool(goalCompleteTool);
      pi.registerTool(goalBlockedTool);

      // ─── before_agent_start:系统提示注入 + run 归属判定 ───
      pi.on('before_agent_start', (event, _ctx) => {
        const goal = controller.rt.goal;
        if (!goal) return;

        // 判定 run origin:输入文本是否是续跑 marker。
        // 注意:SDK 1.2.0 起本事件是 user | custom 联合(自定义消息 + triggerTurn 也会触发),
        // 只有 user run 带 prompt;custom run 不可能是自己的续跑 → 按 manual 记账。
        const prompt = event.messageType === 'user' ? event.prompt : '';
        const isContinuation = prompt !== '' && rt.isOwnContinuation(prompt);
        const origin = isContinuation ? 'automatic' : 'manual';
        rt.beginAgentRun(origin);

        // 认领续跑票据
        if (isContinuation) {
          rt.claimContinuation(prompt);
        }

        // 注入 goal 系统提示(每轮重新拼接,SDK 自动合并)
        const sp = buildGoalSystemPrompt(goal);
        return {
          systemPrompt: `${event.systemPrompt}\n\n${sp}`
        };
      });

      // ─── tool_call:停止态/budget wrap-up 拦截(block + abort) ───
      pi.on('tool_call', (event, ctx) => {
        const goal = rt.goal;
        if (!goal) return;
        if (rt.shouldBlockToolCall(event.toolName)) {
          // 仅 block 会触发又一次 model call 形成循环烧 quota,必须同时 abort
          ctx.abort();
          return {
            block: true,
            reason:
              goal.status === 'budget_limited'
                ? '预算耗尽,只允许收尾(goal_complete)或总结进展,不允许实质性工具调用'
                : `目标当前状态为 ${goal.status},已停止,不允许工具调用`
          };
        }
        rt.markToolAttempted();
      });

      // ─── tool_execution_end:增量记账 ───
      pi.on('tool_execution_end', (_event, _ctx) => {
        if (!rt.goal) return;
        rt.flushUsage();
      });

      // ─── message_end:取 assistant 文本做无进展指纹 ───
      pi.on('message_end', (event, _ctx) => {
        if (!rt.goal) return;
        const msg = event.message as any;
        if (msg?.role === 'assistant') {
          const text =
            typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter((c: any) => c?.type === 'text')
                    .map((c: any) => c.text || '')
                    .join('')
                : '';
          rt.setLastAssistantText(text);
        }
      });

      // ─── agent_end:分类 + 请求续跑 ───
      pi.on('agent_end', (event, ctx) => {
        if (!rt.goal) return;
        // finishAgentRun 记账 + 安全限额检查
        const { shouldContinue } = rt.finishAgentRun();
        if (shouldContinue) {
          rt.requestContinuation(buildContinuePrompt);
        }
      });

      // ─── agent_settled:派发续跑 followUp ───
      pi.on('agent_settled', (event, ctx) => {
        if (!rt.goal) return;
        const prompt = rt.dispatchContinuation(ctx.isIdle(), ctx.hasPendingMessages());
        if (prompt) {
          // 用 followUp 投递续跑消息(不进用户可见输入框)
          pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
        }
      });

      // ─── input:区分用户输入 vs 自己的续跑 ───
      pi.on('input', (event, ctx) => {
        if (!rt.goal) return;
        // 自己的续跑消息:不做任何处理(不重置 safety epoch)
        if (rt.isOwnContinuation(event.text)) {
          return { action: 'continue' };
        }
        // 用户主动输入:重置 safety epoch(限额重算)
        if (event.source === 'interactive' || event.source === 'rpc') {
          rt.resetSafetyEpoch();
          rt.clearDeferral();
        }
        return { action: 'continue' };
      });

      // ─── session_start:从 session entry 恢复 goal 状态 ───
      pi.on('session_start', (event, ctx) => {
        // 会话切换/启动时恢复 goal 状态
        controller.onSessionSwitch();
      });

      // ─── session_compact:压缩后重新加载 goal 状态(goal-state 是 custom entry,压缩保留) ───
      pi.on('session_compact', (event, _ctx) => {
        if (!rt.goal) return;
        // 压缩后 entries 结构变化,重新从 session 加载确保一致
        controller.onSessionSwitch();
      });

      // ─── session_before_compact:flush 用量 + budget_limited 时可 cancel ───
      pi.on('session_before_compact', (event, _ctx) => {
        if (!rt.goal) return;
        // 先 flush,确保压缩前用量准确
        rt.flushUsage();
        // budget_limited 且是 overflow 重试型压缩时,取消压缩(避免压缩重试再烧 token)
        if (rt.goal.status === 'budget_limited' && event.willRetry) {
          return { cancel: true };
        }
      });

      // ─── /goal 命令注册 ───
      pi.registerCommand('goal', {
        description: '目标模式:设定/管理长期目标(/goal [create <目标> | pause | resume | clear])',
        handler: async (args, ctx) => {
          const raw = (args || '').trim();
          const sub = raw.toLowerCase();
          // /goal 无参数:进入目标模式
          if (!raw) {
            // 通过 sendCustomMessage 通知渲染进程切换 mode(或直接靠 UI 操作)
            // 这里无法直接改 store,改用发消息让渲染进程处理
            pi.sendMessage({
              customType: 'goal-mode-activate',
              content: '',
              display: false,
              details: {}
            });
            return;
          }
          // /goal pause|resume|clear:管理命令
          if (sub === 'pause') {
            controller.pauseGoal();
            return;
          }
          if (sub === 'resume') {
            controller.resumeGoal();
            return;
          }
          if (sub === 'clear') {
            controller.clearGoal();
            return;
          }
          // /goal <描述>:直接创建目标,描述作为首条消息
          controller.createGoal(raw);
          // 用描述文本作为首条 user 消息启动 agent(不用 marker followUp,避免标题变 marker)
          try {
            pi.sendUserMessage(raw);
          } catch {}
        }
      });
    }
  };
}

/** 目标激活后立即触发一次续跑,启动自治循环 */
function triggerActivation(pi: ExtensionAPI, controller: GoalController) {
  const rt = controller.rt;
  if (!rt.goal) return;
  // 生成一个激活 prompt 作为首次 followUp
  rt.requestContinuation((_goal, marker) => buildGoalActivationPrompt(rt.goal!, marker));
  // 立即派发(session 应处于 idle)
  const prompt = rt.dispatchContinuation(true, false);
  if (prompt) {
    pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
  }
}
