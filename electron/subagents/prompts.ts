/**
 * Subagent 系统提示模板。
 *
 * 子 agent 的系统提示 = 角色定义正文(agents/*.md frontmatter 之后的 body)
 * + 本模块追加的通用契约(submit 优先、单写者约定、任务自包含)。
 * 注入方式:childExtensionFactory 的 before_agent_start 钩子返回拼接后的 systemPrompt。
 */

/** 通用子 agent 契约(追加在每个角色系统提示之后) */
export const CHILD_CONTRACT = `

<subagent-contract>
你是一个被主 agent 委派的子 agent。通用约束:
- 你的任务是自包含的:所需的全部背景都在任务描述中;不要臆测任务外的上下文
- 结果必须通过 submit 工具提交(而不是只在回复里说);不调用 submit 视为未完成
- 多个并行子 agent 共享同一工作目录:除非任务明确授权写操作,否则不要修改任何文件
- 不要调用 submit 之外的任何方式结束任务;submit 之后立即停止工作
</subagent-contract>`;

/** 构建 task 工具的 description(含当前可用 agent 列表) */
export function buildTaskToolDescription(
  agents: Array<{ name: string; description: string }>
): string {
  const lines = agents.map((a) => `  - ${a.name}: ${a.description}`);
  return `把自包含的子任务委派给子 agent 执行,等待结果并汇总返回。适合并行探索、独立审查、机械批量修改等场景。

可用 agent:
${lines.join('\n')}

规则:
- 任务必须自包含:把必要的背景、目标、验证方式、输出格式全部写进 task,子 agent 看不到本会话其他上下文
- 只读调研/检索用 scout;独立审查用 reviewer(fresh 视角);边界明确的修改用 worker;其余用 generalist
- 多个独立子任务用 tasks 批量并行派发;有依赖关系的任务必须串行(分多次调用)
- 并行派发写任务时最多一个写者:其余任务保持只读,避免改动冲突
- 子 agent 结果只是证据,最终结论和交付由你(主 agent)负责综合与验证`;
}

/** 组装子 agent 完整系统提示 */
export function buildChildSystemPrompt(rolePrompt: string): string {
  return `${rolePrompt}\n${CHILD_CONTRACT}`;
}

/** 异步 run 完成后回灌父会话的 followUp 消息 */
export function buildAsyncResultMessage(
  results: Array<{ name: string; agent: string; status: string; output?: string; error?: string }>
): string {
  const parts = results.map((r) => {
    const statusText =
      r.status === 'complete'
        ? '完成'
        : r.status === 'failed'
          ? '失败'
          : r.status === 'stopped'
            ? '被停止'
            : r.status;
    const body = r.error ? `错误: ${r.error}` : r.output || '(无输出)';
    return `[${r.name}(${r.agent}) — ${statusText}]\n${body}`;
  });
  return `[subagent 异步任务完成]\n${parts.join('\n\n')}\n\n请根据以上结果继续处理。`;
}

/** 组装同步 task 工具结果文本(返回给父 agent 模型) */
export function buildSyncResultText(
  results: Array<{
    name: string;
    agent: string;
    status: string;
    output?: string;
    outputSource?: string;
    error?: string;
  }>
): string {
  const parts = results.map((r) => {
    const statusText =
      r.status === 'complete'
        ? '成功'
        : r.status === 'failed'
          ? '失败'
          : r.status === 'stopped'
            ? '被停止'
            : r.status;
    const source = r.outputSource === 'fallback' ? '(子 agent 未调用 submit,取其最后回复)' : '';
    const body = r.error
      ? `错误: ${r.error}`
      : r.output
        ? `${r.output}${source ? ` ${source}` : ''}`
        : '(无输出)';
    return `## ${r.name}(${r.agent}) — ${statusText}\n${body}`;
  });
  return `子 agent 任务结果:\n\n${parts.join('\n\n')}\n\n请综合以上结果继续。`;
}
