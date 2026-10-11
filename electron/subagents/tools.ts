/**
 * task 工具(注册在父会话):主 agent 委派子任务的唯一入口。
 *
 * flat: { agent, task } 单任务
 * batch: { context, tasks: [{ name, agent, task }] } 多任务并行,共享 context 背景
 * async: true 后台运行,完成时 followUp 回灌父会话(controller 侧)
 *
 * 执行全权委托 SubagentController.executeTask(并发/深度/白名单校验都在那)。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SubagentController } from './controller';
import type { TaskToolDetails } from './types';
import { buildTaskToolDescription } from './prompts';

export function createTaskTool(controller: SubagentController) {
  return defineTool({
    name: 'task',
    label: '委派子任务',
    description: buildTaskToolDescription(
      controller.ensureDefinitionsLoaded().agents.map((a) => ({
        name: a.name,
        description: a.description
      }))
    ),
    promptSnippet: '把自包含子任务委派给子 agent(单任务或批量并行)',
    promptGuidelines: [
      '优先在需要并行探索、独立审查或机械批量工作时使用 task,单文件小改动自己做更快',
      '任务必须自包含:子 agent 看不到本会话上下文,背景/目标/验证方式全部写进 task',
      '有依赖关系的子任务分多次调用串行执行,不要塞进同一批'
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: 'agent 名(flat 单任务模式)' })),
      task: Type.Optional(Type.String({ description: '自包含任务指令(flat 单任务模式)' })),
      context: Type.Optional(
        Type.String({ description: 'batch 模式共享背景:目标/约束/契约,所有子任务可见' })
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.Optional(Type.String({ description: '任务名(结果标识,缺省用 agent 名)' })),
            agent: Type.String({ description: 'agent 名' }),
            task: Type.String({ description: '自包含子任务指令' })
          }),
          { description: 'batch 模式子任务列表(并行执行)', minItems: 1, maxItems: 6 }
        )
      ),
      async: Type.Optional(
        Type.Boolean({
          description: '后台运行(默认 false 阻塞等待)。true 时立即返回,完成后结果自动送达'
        })
      ),
      model: Type.Optional(
        Type.String({ description: '模型覆盖 "provider/modelId";缺省用 agent 定义或当前模型' })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const p = params as {
        agent?: string;
        task?: string;
        context?: string;
        tasks?: Array<{ name?: string; agent: string; task: string }>;
        async?: boolean;
        model?: string;
      };

      const result = await controller.executeTask({
        agent: p.agent,
        task: p.task,
        context: p.context,
        tasks: p.tasks,
        async: p.async,
        model: p.model,
        depth: 0,
        callerAgent: undefined
      });

      const isError = result.text.startsWith('错误:');
      const details: TaskToolDetails = {
        runs:
          result.runIds.length > 0
            ? result.runIds.map((id) => {
                const run = controller.getRun(id);
                return {
                  id,
                  name: run?.name ?? '',
                  agent: run?.agent ?? '',
                  status: run?.status ?? 'failed',
                  output: run?.output,
                  error: run?.error,
                  async: run?.async ?? false
                };
              })
            : []
      };
      const toolResult: AgentToolResult<TaskToolDetails> = {
        content: [{ type: 'text' as const, text: result.text }],
        details
      };
      if (isError) {
        return { ...toolResult, isError: true } as AgentToolResult<TaskToolDetails>;
      }
      return toolResult;
    }
  });
}
