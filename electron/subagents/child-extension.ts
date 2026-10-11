/**
 * 子 agent 会话的内联扩展工厂。
 *
 * 每个子 session 创建时注入一个专属实例,职责:
 * - before_agent_start:角色系统提示 + 通用契约注入(每轮重注入,goal 模式同款)
 * - 注册 submit 工具(显式结果契约);深度未到顶时注册 task 工具(递归委派)
 * - tool_call 钩子:submit 完成后拦截后续工具调用,推动子 agent 尽快收束
 *
 * 参考设计:oh-my-pi 的 yield 契约(显式提交优于解析最后一句话)
 *          + omp 的深度上限(到顶移除 task 工具,能力层面阻断无限递归)。
 */
import type {
  ExtensionAPI,
  InlineExtension,
  ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SubmitPayload } from './types';
import { buildChildSystemPrompt, buildTaskToolDescription } from './prompts';

/** 子 session 运行上下文(executor 创建时传入) */
export interface ChildRunContext {
  /** 角色 agent 名 */
  agentName: string;
  /** 角色系统提示(定义正文) */
  rolePrompt: string;
  /** 递归深度(父会话 = 0,子 = 1,孙 = 2) */
  depth: number;
  /** 深度上限(到顶不再注册 task 工具) */
  maxDepth: number;
  /** submit 提交后的落点(executor 持有的 resolver) */
  onSubmit: (payload: SubmitPayload) => void;
  /** 递归派生入口(executor 提供;为空表示不可递归) */
  spawnChild?: (args: {
    agent: string;
    task: string;
    context?: string;
    tasks?: Array<{ name?: string; agent: string; task: string }>;
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** 可派生的子 agent 名单描述(渲染进 task 工具 description) */
  spawnableAgents?: Array<{ name: string; description: string }>;
}

/**
 * 子 agent 的**契约工具**:submit 是 CHILD_CONTRACT 强制的唯一正式出口,
 * task 是递归委派入口(深度未到顶且角色允许派生时注册)。
 *
 * 为什么需要单独导出:角色定义里的 `tools` 是能力白名单(如 reviewer/scout 的
 * `read, grep, find, ls`),但 SDK 的 `tools` 选项是**硬白名单**——不在名单里的工具
 * (包括内联扩展注册的工具)会被直接移出工具注册表(agent-session.js 的 `_isAllowedTool`,
 * 见 `_refreshToolRegistry` 的 `allCustomTools.filter(...)`)。因此白名单必须与契约工具取并集,
 * 否则只读角色会被系统提示要求调用一个自己看不见的 submit(表现为「子 agent 看不到 submit 工具」)。
 */
export const CHILD_CONTRACT_TOOLS = ['submit', 'task'] as const;

/**
 * 把角色定义的 tools 白名单与契约工具合并;`undefined`(角色未声明 tools)保持不限制。
 * 名单里多出的名字(如深度到顶时未注册的 task)会被 SDK 忽略,不影响行为。
 */
export function withContractTools(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  return [...new Set([...tools, ...CHILD_CONTRACT_TOOLS])];
}

/** submit 工具:子 agent 显式提交结果 */
function createSubmitTool(ctx: ChildRunContext): ToolDefinition {
  return defineTool({
    name: 'submit',
    label: '提交任务结果',
    description: `提交任务结果并结束本次任务。这是任务完成的唯一正式出口。
规则:
- status=success 仅在任务目标真正达成时使用;summary 如实描述交付物与验证结果
- 无法完成时 status=failed,summary 说明卡在哪一步、原因、已尝试的路径
- summary 是给主 agent 看的:直接给结论/产物/文件路径,不要过程叙述`,
    promptSnippet: '提交任务结果(任务完成的唯一出口)',
    promptGuidelines: [
      '任务完成后必须调用 submit 提交结果,不要只在回复文本里总结',
      'summary 直接给结论与证据(文件路径/命令输出),主 agent 只能看到 submit 的内容'
    ],
    parameters: Type.Object({
      status: Type.Union([Type.Literal('success'), Type.Literal('failed')], {
        description: '任务结果状态'
      }),
      summary: Type.String({
        description: '结果摘要:交付物/结论/文件路径/验证结果;失败时说明原因与卡点',
        minLength: 1
      }),
      data: Type.Optional(Type.Unknown({ description: '可选结构化数据(JSON 可序列化)' }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ectx) {
      const { status, summary, data } = params as SubmitPayload;
      ctx.onSubmit({ status, summary, data });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              status === 'success'
                ? '结果已提交,任务结束。请停止进一步操作。'
                : '失败结果已提交,任务结束。请停止进一步操作。'
          }
        ],
        details: undefined
      };
    }
  });
}

/**
 * 子 session 的 task 工具(递归委派)。
 * 到达深度上限时不注册,子 agent 自然无法继续派生。
 */
function createChildTaskTool(ctx: ChildRunContext): ToolDefinition {
  return defineTool({
    name: 'task',
    label: '委派子任务',
    description: buildTaskToolDescription(ctx.spawnableAgents ?? []),
    promptSnippet: '把子任务委派给子 agent 执行',
    promptGuidelines: ['任务必须自包含;子 agent 看不到你的会话上下文'],
    parameters: Type.Object({
      agent: Type.String({ description: 'agent 名(见上方可用列表)' }),
      task: Type.String({ description: '自包含的任务指令' })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ectx) {
      const { agent, task } = params as { agent: string; task: string };
      if (!ctx.spawnChild) {
        return {
          content: [{ type: 'text' as const, text: '错误:当前子 agent 不支持继续派生任务。' }],
          isError: true,
          details: undefined
        };
      }
      const result = await ctx.spawnChild({ agent, task });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `错误: ${result.error}` }],
          isError: true,
          details: undefined
        };
      }
      return { content: [{ type: 'text' as const, text: result.text }], details: undefined };
    }
  });
}

export function childExtensionFactory(ctx: ChildRunContext): InlineExtension {
  return {
    name: `subagent-child-${ctx.agentName}`,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(createSubmitTool(ctx));
      // 深度未到顶且定义允许派生时,提供递归 task 工具
      if (ctx.depth < ctx.maxDepth && ctx.spawnChild && (ctx.spawnableAgents?.length ?? 0) > 0) {
        pi.registerTool(createChildTaskTool(ctx));
      }

      // 角色系统提示 + 通用契约(每轮重注入;替换 SDK 默认编码提示,
      // 子 agent 的身份由角色定义决定,不叠加主会话的 pi 编码助手提示)
      pi.on('before_agent_start', (_event, _ectx) => {
        return {
          systemPrompt: buildChildSystemPrompt(ctx.rolePrompt)
        };
      });
    }
  };
}
