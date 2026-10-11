/**
 * update_plan 工具：让 agent 维护结构化任务清单。
 *
 * 参考 codex-rs 的 update_plan 设计：
 * - 全量替换语义：每次调用传入完整 plan 列表
 * - 工具无状态：不持有状态，仅把 plan 作为 details 返回，由消费端（UI）渲染
 * - 返回固定成功消息给模型，不泄露内部状态
 *
 * 工具结果通过 tool_execution_end 事件广播，前端 usePiEvent 监听后更新 TodoPanel。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** 单个任务状态 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';

/** 工具返回的 details 结构（前端据此渲染 TodoPanel） */
export interface UpdatePlanDetails {
  explanation?: string;
  phases: Array<{
    name: string;
    tasks: Array<{
      id: string;
      content: string;
      status: TodoStatus;
    }>;
  }>;
}

/** update_plan 工具定义 */
export const updatePlanTool = defineTool({
  name: 'update_plan',
  label: '任务清单',
  description: `维护任务清单（Todo）。传入完整的任务列表以替换当前清单。
规则：
- 每次调用传入完整列表（全量替换，非增量）
- status 只能是 pending / in_progress / completed / abandoned
- 同一时间最多一个 in_progress 任务
- 在开始多步任务时建清单，完成/变更状态时更新
- 任务描述简短（5-15词），说"做什么"不说"怎么做"`,
  promptSnippet: '维护任务清单，跟踪多步任务进度',
  promptGuidelines: [
    '用户给出多步任务时，先用 update_plan 建立完整任务清单',
    '完成一个步骤后立即用 update_plan 更新状态，不要批量更新',
    'update_plan 应与实际工作（读/编辑）打包在同一轮调用，不要单独调用'
  ],
  parameters: Type.Object({
    explanation: Type.Optional(Type.String({ description: '本次更新的简要说明（可选）' })),
    plan: Type.Array(
      Type.Object({
        phase: Type.Optional(Type.String({ description: '阶段名称（可选，默认 Tasks）' })),
        steps: Type.Array(
          Type.Object({
            step: Type.String({ description: '任务描述' }),
            status: Type.Union(
              [
                Type.Literal('pending'),
                Type.Literal('in_progress'),
                Type.Literal('completed'),
                Type.Literal('abandoned')
              ],
              { description: '任务状态' }
            )
          }),
          { description: '任务列表' }
        )
      }),
      { description: '完整的任务阶段列表（全量替换）' }
    )
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { explanation, plan } = params as {
      explanation?: string;
      plan: Array<{ phase?: string; steps: Array<{ step: string; status: string }> }>;
    };

    // 将工具参数转换为前端渲染用的 phases 结构
    const phases = (plan || []).map(
      (p: { phase?: string; steps: Array<{ step: string; status: string }> }, pi: number) => ({
        name: p.phase || (plan.length > 1 ? `Phase ${pi + 1}` : 'Tasks'),
        tasks: (p.steps || []).map((s: { step: string; status: string }, si: number) => ({
          id: `todo-${pi}-${si}-${s.step.substring(0, 20)}`,
          content: s.step,
          status: s.status as TodoStatus
        }))
      })
    );

    const details: UpdatePlanDetails = { explanation, phases };

    const result: AgentToolResult<UpdatePlanDetails> = {
      content: [{ type: 'text', text: 'Plan updated' }],
      details
    };
    return result;
  }
});
