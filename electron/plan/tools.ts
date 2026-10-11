/**
 * propose_plan 工具:plan 模式的状态流转卡点。
 *
 * 设计:
 * - execute() 调 controller.startProposal(content) 拿到永不自动 resolve 的 promise,
 *   把 agent 循环钉在等待用户决策这一步(确保方案审批是物理卡点,不靠提示词自觉)
 * - 批准:controller 退出 plan 回标准模式 + 续跑旗标;工具返回 terminate:true 结束本回合,
 *   扩展 agent_end 钩子轮询 ctx.isIdle() 后投递续跑消息(pi.sendUserMessage)
 * - 驳回:工具返回否决提示+反馈串(同回合,模型据锚点修订方案再调本工具)
 *
 * 工具复用 controller 的 round-trip;本身不持有状态。
 * 注册在 expansion 工厂(pi.registerTool);可见性由 PLAN_PLANNING_TOOLS 白名单控制。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { PlanController } from './controller';
import { buildDeniedFeedbackPrompt } from './prompts';

export interface ProposePlanDetails {
  proposalId: string;
  variant: number;
  approved: boolean;
  feedback?: string;
}

export function createProposePlanTool(controller: PlanController) {
  return defineTool({
    name: 'propose_plan',
    label: '提交方案',
    description: `提交你的完整方案给用户审批。仅在规划模式下、方案完备时调用。
规则:
- 传入方案 markdown 全文(content),需包含背景/推荐方案/要修改文件/复用项/步骤清单/验证方式
- 调用后用户在评审面板中批准或驳回(可对方案某段原文加批注)
- 批准:自动退出规划模式进入实现阶段,无需再做什么
- 驳回并附反馈:工具结果里会带回带原文锚点的反馈串,据锚点定向修改后重新调本工具`,
    promptSnippet: '提交方案给用户审批(规划模式)',
    promptGuidelines: [
      '规划模式下,设计方案完备后必须调用 propose_plan 提交,不要结束回合不提交',
      '禁止开始任何实现动作(edit/write),只有方案被批准后才进入实现',
      '被驳回后按反馈里的原文锚点定向修订,不要重写整份方案,改完重新调 propose_plan'
    ],
    parameters: Type.Object({
      content: Type.String({
        description: '方案 markdown 全文(背景/推荐方案/要修改文件/复用项/步骤清单/验证方式)',
        minLength: 1
      }),
      summary: Type.Optional(
        Type.String({ description: '一句话方案标题(评审面板 header 用,可选)' })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { content, summary } = params as { content: string; summary?: string };

      // 规划态校验:非 planning 下拒绝(防止模型在别处误调)
      if (!controller.isPlanning) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '错误:当前不在规划模式,无法提交方案。请用规划模式重新发起。'
            }
          ],
          isError: true,
          details: undefined
        } as const;
      }

      if (!content.trim()) {
        return {
          content: [{ type: 'text' as const, text: '错误:content 不能为空。' }],
          isError: true,
          details: undefined
        } as const;
      }

      // 阻塞等待用户审批决策(卡点)
      const decision = await controller.startProposal(content, summary);

      const details: ProposePlanDetails = {
        proposalId: '', // 由 controller 填也可,这里留空
        variant: 0,
        approved: decision.approved,
        feedback: decision.feedback
      };

      if (decision.approved) {
        const notesLine = decision.feedback ? `\n\n附注:\n${decision.feedback}` : '';
        const result: AgentToolResult<ProposePlanDetails> = {
          content: [
            {
              type: 'text' as const,
              text: `方案已批准。现在退出规划模式进入实现:先用 update_plan 建步骤清单跟踪进度,再逐步实现。${notesLine}`
            }
          ],
          details,
          terminate: true
        };
        return result;
      }

      // 驳回:同回合回流反馈,不加 terminate(模型据反馈修订再提交)
      const feedback = decision.feedback || '方案被用户驳回,请修订后重新提交。';
      const result: AgentToolResult<ProposePlanDetails> = {
        content: [{ type: 'text' as const, text: buildDeniedFeedbackPrompt(feedback) }],
        details
      };
      return result;
    }
  });
}
