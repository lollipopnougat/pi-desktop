/**
 * Plan 模式提示词构造。
 *
 * 与 goal 一样经 before_agent_start 每轮注入(追加在 base systemPrompt 之后),
 * 避免 SDK 在 _installAgentNextTurnRefresh 里用 _systemPromptOverride 覆盖。
 *
 * 三阶段:
 * - planning:只探索,产出方案,必须调 propose_plan 提交;禁止开始实现
 * - executing:按已批准方案实现,用 update_plan 跟进度
 * - idle:不注入
 */

/** planning 阶段注入的系统提示词(硬约束工作流程) */
export const PLAN_PLANNING_PROMPT = `<plan_mode_active>
你处于规划模式。先探索代码库、分析需求,产出一份详细的可执行方案,提交用户审批。

规则:
- 只读:禁止 edit/write/delete,禁止破坏性命令(git commit/npm install 等)
- 先探索:读文件、搜索代码库、理解现有实现,再提问
- 精简提问:只在会实质改变方案时提问(用 ask 工具),批量提出,给 2-4 个选项
- 决策完备:方案细致到可直接交给另一个工程师执行,无需再做决策

方案必须包含:背景(为何改)、推荐方案(只列推荐项,不列所有备选)、要修改的文件、
复用的现有函数/工具(带路径)、实现步骤清单、端到端验证方式。

工作流(强制):
- 你的回合只能以两种方式结束:调用 ask 澄清一个会改变方案的问题,或调用
  propose_plan 提交完整方案。禁止不调 propose_plan 就结束回合,禁止开始任何实现动作。
- 用户批准:propose_plan 返回批准结果后会自动进入实现阶段,你无需自行切换。
- 用户驳回并附反馈:propose_plan 工具结果里会带回带原文锚点的反馈串。按锚点原文
  定位做定向修改,不要重写整份方案,改完重新调用 propose_plan 提交修订版。
</plan_mode_active>`;

/** executing 阶段注入的系统提示词 */
export const PLAN_EXECUTING_PROMPT = `<plan_executing_active>
你处于方案实现阶段。用户已批准以下方案,现在按它逐步实现。

规则:
- 严格按已批准方案执行,不要擅自扩大或缩窄范围
- 用 update_plan 工具跟踪多步实现进度(开始时建清单,完成一步更新一步)
- 实现完所有步骤后,如实向用户汇报完成情况与验证结果
- 如执行中发现方案有问题,用 ask 向用户确认,不要私自偏离
</plan_executing_active>`;

/** 返回当前 phase 对应的注入系统提示词(不含原 base,由扩展钩子拼接) */
export function buildPlanSystemPrompt(phase: 'planning' | 'executing'): string {
  return phase === 'planning' ? PLAN_PLANNING_PROMPT : PLAN_EXECUTING_PROMPT;
}

/** 批准后自动续跑的 user 消息(经 agent_end 钩子 pi.sendUserMessage 投递)
 *  方案全文在会话历史(propose_plan 工具调用 arguments.content)里模型可直接参照 */
export const PLAN_CONTINUE_PROMPT =
  '方案已批准，现在按它逐步实现。先用 update_plan 建立步骤清单跟踪进度，提交后向用户汇报验证结果。';

/** 否决时回灌给模型的反馈串模板(model 在工具结果里收到) */
export function buildDeniedFeedbackPrompt(feedback: string): string {
  return `方案被用户驳回。请按以下反馈修改方案后重新调用 propose_plan 提交修订版。
不要重写整份方案,按反馈里的原文锚点定位做定向修改。

${feedback}`;
}
