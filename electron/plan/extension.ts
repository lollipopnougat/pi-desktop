/**
 * Plan 模式内联扩展工厂。
 *
 * 关键事实(经 SDK 源码核实,与 goal extension 同):
 * - 直接赋值 session.agent.state.systemPrompt 会被 _installAgentNextTurnRefresh 每轮
 *   用 _systemPromptOverride ?? _baseSystemPrompt 覆盖 → plan 指令到不了模型。
 *   这是 pi-desktop 旧 setPlanMode 失效的根因。
 * - 唯一稳健注入点:before_agent_start 钩子返回 { systemPrompt },SDK 写入
 *   _systemPromptOverride 并每轮重新应用(agent-session.js:898-905)。
 *
 * 注册的钩子:
 * - before_agent_start: planning/executing 阶段注入对应提示词
 * - agent_end:         批准后(needsContinue)轮询 ctx.isIdle() 投递续跑消息,
 *                       复刻 plannotator continueWhenIdle 模式
 * - session_start:     会话切换恢复 plan phase(工具集白名单/全量)
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { PlanController } from './controller';
import { createProposePlanTool } from './tools';
import { buildPlanSystemPrompt, PLAN_CONTINUE_PROMPT } from './prompts';

export function planExtensionFactory(controller: PlanController): InlineExtension {
  return {
    name: 'plan-mode',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // ─── 注册工具(propose_plan) ───
      pi.registerTool(createProposePlanTool(controller));

      // ─── before_agent_start:注入阶段提示词(每轮重注入,SDK 自动合并 override) ───
      pi.on('before_agent_start', (event, _ctx) => {
        const phase = controller.currentPhase;
        if (phase === 'idle') return; // 不注入,SDK 用 base
        const sp = buildPlanSystemPrompt(phase);
        return {
          systemPrompt: `${event.systemPrompt}\n\n${sp}`
        };
      });

      // ─── agent_end:批准后续跑(轮询 idle 投递消息) ───
      pi.on('agent_end', (_event, ctx) => {
        if (!controller.consumeContinue()) return;
        // 复刻 plannotator continueWhenIdle:轮询 ctx.isIdle() 后投递续跑,
        // 避免在工具结果未结算、agent 还没 idle 时提前 sendUserMessage
        let attempts = 0;
        const continueWhenIdle = (): void => {
          try {
            if (!ctx.isIdle || !ctx.isIdle()) {
              attempts += 1;
              if (attempts <= 200) setTimeout(continueWhenIdle, 50);
              return;
            }
            pi.sendUserMessage(PLAN_CONTINUE_PROMPT);
          } catch (err) {
            // ctx 失效(session 被替换/销毁)时静默放弃,不抛(避免杀进程)
            console.error(
              `[plan] could not continue after approval: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        };
        setTimeout(continueWhenIdle, 0);
      });

      // ─── session_start:恢复 plan phase ───
      pi.on('session_start', (_event, _ctx) => {
        controller.onSessionSwitch();
      });
    }
  };
}
