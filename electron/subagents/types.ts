/**
 * Subagent 系统类型定义。
 *
 * 设计参考(见 plans/subagents.md):
 * - oh-my-pi:in-process 子 session + 显式 submit 契约 + 深度上限移除 task 工具
 * - pi-subagents:agent 定义三级优先级合并、单写者约定
 * - codex-rs V2:并发/深度限制、结构化结果回传
 *
 * 首版边界(不做):worktree 隔离、横向通信(hub)、park/revive 保活、
 * 子 session 持久化。ChildRun 预留 sessionFile 字段供后续扩展。
 */

/** Agent 定义来源(优先级:builtin < user < project,同名高优先级覆盖) */
export type AgentDefinitionSource = 'builtin' | 'user' | 'project';

/** Markdown + YAML frontmatter 定义的 agent */
export interface AgentDefinition {
  /** 唯一标识,task 工具的 agent 参数引用它 */
  name: string;
  /** 给主 agent 看的选型说明(渲染进 task 工具 description) */
  description: string;
  source: AgentDefinitionSource;
  /** 定义文件绝对路径(builtin 为虚拟标记) */
  filePath: string;
  /** 模型引用 "provider/modelId";缺省继承父会话当前模型 */
  model?: string;
  /** 推理强度 */
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 工具白名单(逗号分隔解析后);缺省全量内置工具 */
  tools?: string[];
  /** 可派生的子 agent 名单:'' = 不可派生;'*' = 任意;或逗号分隔白名单 */
  spawns: string;
  /** 角色系统提示(frontmatter 正文) */
  systemPrompt: string;
}

/** 子 agent 运行状态 */
export type ChildRunStatus =
  | 'queued' // 排队等待并发槽
  | 'running' // 子 agent 循环执行中
  | 'complete' // submit(status=success) 或正常结束
  | 'failed' // submit(status=failed) / 异常 / 被停止
  | 'stopped'; // 用户手动停止

/** submit 工具提交的结构化结果 */
export interface SubmitPayload {
  status: 'success' | 'failed';
  summary: string;
  /** 可选结构化数据(JSON 可序列化) */
  data?: unknown;
}

/** 单个子 agent 运行记录(= 一个逻辑 run) */
export interface ChildRun {
  /** 稳定 run id(sa-xxxx) */
  id: string;
  /** batch 模式下的任务名(flat 模式为 agent 名) */
  name: string;
  agent: string;
  /** 自包含任务指令 */
  task: string;
  status: ChildRunStatus;
  /** submit 提交的摘要;未调 submit 时兜底取最后一条 assistant 消息 */
  output?: string;
  /** submit 的结构化数据 */
  outputData?: unknown;
  /** 结果来源:submit 工具 / 最后一条 assistant 文本兜底 */
  outputSource?: 'submit' | 'fallback';
  error?: string;
  /** 是否后台运行(父 agent 不阻塞) */
  async: boolean;
  /** 递归深度(父会话 = 0) */
  depth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 实时进度(推渲染进程) */
  progress?: AgentProgress;
  /** 工具调用流水(详情视图;上限 200 条防膨胀) */
  toolCalls?: ChildToolCall[];
  /** 对话流(详情视图「对话」Tab;仅内存,不落盘;上限 300 条) */
  transcript?: ChildTranscriptItem[];
  /** 子 session 文件路径(inMemory 时为空;预留给 fork/持久化) */
  sessionFile?: string;
}

/**
 * 子 agent 对话流条目(详情视图「对话」Tab)。
 *
 * 顺序 = 模型实际输出顺序;正文/思考直接内联文本,工具调用只存 id
 * (参数与结果仍由 `ChildRun.toolCalls` 提供,单一数据源避免重复传输)。
 */
export type ChildTranscriptItem =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | { kind: 'tool'; at: number; toolCallId: string }
  /** 流式占位:message_start 创建、message_update 就地更新、message_end 替换为最终条目 */
  | { kind: 'stream'; at: number; text: string; thinking: string; toolCallIds: string[] };

/** 实时进度快照 */
export interface AgentProgress {
  /** 当前正在执行的工具 */
  currentTool?: string;
  currentToolArgs?: string;
  /** 最近完成的工具(最多 5 个) */
  recentTools: Array<{ tool: string; endMs: number }>;
  /** 累计 assistant 轮次 */
  turns: number;
  /** 累计 token(input+output) */
  tokens: number;
  /** 累计耗时 ms */
  durationMs: number;
}

/** 子 agent 工具调用记录(详情视图用) */
export interface ChildToolCall {
  toolCallId: string;
  toolName: string;
  /** 参数(JSON 序列化摘要) */
  args?: unknown;
  /** 执行结果(tool_execution_end 的 result) */
  result?: unknown;
  isError?: boolean;
  /** 未完成时 true */
  pending?: boolean;
  startedAt: number;
  endedAt?: number;
}

/** 推送给渲染进程的快照(pi:subagentUpdate) */
export interface SubagentSnapshot {
  /** 所有活跃与最近结束的 run(按创建时间倒序,上限 50) */
  runs: ChildRun[];
  /** 内置+用户+项目 agent 定义列表(task 工具选型参考) */
  agents: Array<{
    name: string;
    description: string;
    source: AgentDefinitionSource;
    tools?: string[];
  }>;
}

/** task 工具 batch 模式的子任务项 */
export interface TaskItem {
  name?: string;
  agent: string;
  task: string;
}

/** task 工具返回的 details(工具卡片渲染用) */
export interface TaskToolDetails {
  runs: Array<{
    id: string;
    name: string;
    agent: string;
    status: ChildRunStatus;
    output?: string;
    error?: string;
    async: boolean;
  }>;
}
