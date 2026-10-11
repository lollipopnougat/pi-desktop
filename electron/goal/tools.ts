/**
 * goal_complete / goal_blocked 工具定义。
 *
 * 参考 oh-my-pi / pi-goal 的多重校验闸门:
 * - goal_id 陈旧轮次守卫(必须传当前系统提示展示的 id)
 * - 矛盾检测(模型嘴上说完成实际说没完成)
 * - goal_blocked 需 repeated_turns >= 3
 *
 * 工具经 pi.registerTool 注册(内联扩展内),execute 的 ctx 是 ExtensionContext。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { GoalController } from './controller';

/** 自相矛盾完成摘要检测(防止模型嘴上说完成实际说没完成) */
const CONTRADICTORY_COMPLETION_PATTERNS = [
  /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
  /\bstill\s+(?:incomplete|failing|fails?)\b/i,
  /\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
  /\bnot\s+all\s+(?:requirements|tests|checks)\s+(?:pass|passed)\b/i
];

function isContradictoryCompletionSummary(summary: string): boolean {
  return CONTRADICTORY_COMPLETION_PATTERNS.some((p) => p.test(summary));
}

export function createGoalTools(controller: GoalController) {
  const goalCompleteTool = defineTool({
    name: 'goal_complete',
    label: '完成目标',
    description: `声明当前长期目标已完成。只能在严格完成审计通过后调用。
规则:
- 调用前必须逐条核查每个明确需求/产物/命令/测试/门禁的当前证据(读文件、跑命令,禁止凭会话记忆)
- 验证范围匹配声明范围(单个单测通过不能证明端到端可用)
- 不确定 = 未完成(间接证据、部分覆盖、缺失工件 → 继续工作)
- 预算耗尽不是完成
- summary 必须如实描述已完成的交付物与验证结果,不能自相矛盾(如"not yet complete")`,
    promptSnippet: '声明长期目标完成(需逐条证据审计)',
    promptGuidelines: [
      '只在目标真正完成、所有需求都有权威证据时调用 goal_complete',
      '调用前用 read/bash 核查当前仓库状态,不要凭记忆判断',
      'summary 如实描述已完成交付物,不能出现"not yet complete"等矛盾措辞',
      'goal_id 必须使用系统提示 <goal_id> 块展示的当前 id'
    ],
    parameters: Type.Object({
      goal_id: Type.String({ description: '当前目标的 goal_id(来自系统提示 <goal_id> 块)' }),
      summary: Type.String({
        description: '完成摘要:已完成的交付物、验证结果、范围',
        minLength: 1
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { goal_id, summary } = params as { goal_id: string; summary: string };
      const rt = controller.rt;

      // 1. 无 active goal → 拒绝
      if (!rt.goal) {
        return {
          content: [{ type: 'text' as const, text: '错误:当前没有活跃的 goal,无法完成。' }],
          isError: true,
          details: undefined
        };
      }

      // 2. 当前 run 不拥有该 goal → 拒绝
      if (!rt.canRecordGoalUsage()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '错误:当前 run 不归属该 goal,无法完成。'
            }
          ],
          isError: true,
          details: undefined
        };
      }

      // 3. goal_id 不匹配 → 拒绝(陈旧轮次守卫)
      if (rt.goal.id !== goal_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `错误:goal_id 不匹配。当前目标 id 为 ${rt.goal.id},你传入的是 ${goal_id}。这是陈旧轮次守卫:必须使用系统提示 <goal_id> 块展示的当前 id。`
            }
          ],
          isError: true,
          details: undefined
        };
      }

      // 4. goal 状态非 active → 拒绝
      if (rt.goal.status !== 'active' && !rt.isBudgetWrapUpActive()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `错误:goal 当前状态为 ${rt.goal.status},非 active,无法完成。`
            }
          ],
          isError: true,
          details: undefined
        };
      }

      // 5. summary 为空或自相矛盾 → 拒绝
      if (!summary.trim()) {
        return {
          content: [{ type: 'text' as const, text: '错误:summary 不能为空。' }],
          isError: true,
          details: undefined
        };
      }
      if (isContradictoryCompletionSummary(summary)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '错误:summary 自相矛盾(包含"not yet complete/still failing/tests fail"等措辞),这表明目标尚未真正完成。请继续工作直到所有需求有权威证据后再调用。'
            }
          ],
          isError: true,
          details: undefined
        };
      }

      // 全通过 → 迁移 complete、记录完成消息、刷新工具可见性
      rt.transitionGoal('complete');
      controller.markCompletedMessage();
      controller.refreshGoalToolVisibility();
      const result: AgentToolResult<unknown> = {
        content: [
          {
            type: 'text' as const,
            text: `目标已标记完成。\n\n摘要: ${summary}\n\n请向用户简要汇报完成情况。`
          }
        ],
        details: undefined
      };
      return result;
    }
  });

  const goalBlockedTool = defineTool({
    name: 'goal_blocked',
    label: '目标阻塞',
    description: `声明当前目标遇到无法绕过的阻塞。只能在确认真实 impasse 后调用。
规则:
- 同一阻塞必须连续重复出现至少 3 轮(repeated_turns >= 3)
- 必须有具体证据说明为什么无法推进
- 必须明确需要用户或外部行动才能解除
- resume 后重新开始三轮审计
- 不是"我想问用户一个问题"或"这个任务很难"`,
    promptSnippet: '声明目标阻塞(需连续 3 轮同阻塞)',
    promptGuidelines: [
      '只在同一阻塞连续 3 轮复现、且无用户/外部输入就无法推进时调用 goal_blocked',
      'evidence 必须是具体的(错误信息、缺失的依赖、权限问题等),不是笼统描述',
      'reason 说明需要用户做什么才能解除阻塞'
    ],
    parameters: Type.Object({
      goal_id: Type.String({ description: '当前目标的 goal_id' }),
      reason: Type.String({
        description: '阻塞原因:为什么无法推进,需要用户/外部做什么',
        minLength: 1,
        maxLength: 1000
      }),
      evidence: Type.String({
        description: '具体证据:错误信息、命令输出、缺失的工件等',
        minLength: 1,
        maxLength: 4000
      }),
      repeated_turns: Type.Integer({
        description: '同一阻塞已连续重复的轮数(必须 >= 3)',
        minimum: 3
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { goal_id, reason, evidence, repeated_turns } = params as {
        goal_id: string;
        reason: string;
        evidence: string;
        repeated_turns: number;
      };
      const rt = controller.rt;

      if (!rt.goal) {
        return {
          content: [{ type: 'text' as const, text: '错误:当前没有活跃的 goal。' }],
          isError: true,
          details: undefined
        };
      }
      if (!rt.canRecordGoalUsage()) {
        return {
          content: [{ type: 'text' as const, text: '错误:当前 run 不归属该 goal。' }],
          isError: true,
          details: undefined
        };
      }
      if (rt.goal.id !== goal_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `错误:goal_id 不匹配。当前目标 id 为 ${rt.goal.id}。`
            }
          ],
          isError: true,
          details: undefined
        };
      }
      if (rt.goal.status !== 'active') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `错误:goal 当前状态为 ${rt.goal.status},非 active。`
            }
          ],
          isError: true,
          details: undefined
        };
      }
      if (!Number.isInteger(repeated_turns) || repeated_turns < 3) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '错误:repeated_turns 必须是整数且 >= 3。同一阻塞必须连续重复至少 3 轮才能声明 blocked。如果还未达到 3 轮,请继续尝试其他路径。'
            }
          ],
          isError: true,
          details: undefined
        };
      }

      rt.transitionGoal('blocked');
      controller.markCompletedMessage();
      controller.refreshGoalToolVisibility();
      const result: AgentToolResult<unknown> = {
        content: [
          {
            type: 'text' as const,
            text: `目标已标记阻塞。\n\n原因: ${reason}\n证据: ${evidence}\n\n请向用户汇报阻塞情况与所需的外部行动。`
          }
        ],
        details: undefined
      };
      return result;
    }
  });

  return { goalCompleteTool, goalBlockedTool };
}
