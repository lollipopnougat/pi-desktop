// Type declarations for window.pi
// window.pi 是 preload.ts 通过 contextBridge 暴露的 IPC 封装，
// 每个方法经 ipcRenderer.invoke('pi:xxx') 调用主进程 handler，
// handler 拿到 pi sdk 对象后对返回值做了裁剪/重组/合并，因此多数方法的返回类型
// 并非 sdk 原型，而是 handler 实际加工后的结构。类型尽量复用 sdk 的导出类型。
import type { SessionIdentity, MessageSnapshot } from './session';
import type {
  AgentSessionEvent,
  CompactionResult,
  ModelCycleResult,
  PromptOptions,
  SessionEntry,
  SessionInfo,
  SessionStats,
  SourceInfo
} from '@earendil-works/pi-coding-agent';
import type { ExternalApp, Provider } from './shared';
import type { ModelPreset } from './model-preset';
import type { UsageStatistics, UsageStatisticsQuery } from './usage-statistics';

// ─── 从主包类型推导出的间接类型（这些无法直接 import，借由已 re-export 的类型提取） ───

/** Goal 模式状态 */
type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';

/** 单个目标事件(用于消息标记匹配) */
interface GoalEvent {
  goalMessageTimestamp: number;
  completedMessageTimestamp?: number;
  completedTimeUsed?: number;
  status: string;
}

/** Goal 状态快照（pi:goalUpdate 推送 / window.pi.goal.get 返回） */
interface GoalSnapshot {
  goal: {
    id: string;
    text: string;
    status: GoalStatus;
    tokensUsed: number;
    tokenBudget?: number;
    timeUsedSeconds: number;
    iteration: number;
    automaticModelTurns: number;
    safetyPauseCause?: 'continuation_limit' | 'no_progress';
    goalMessageTimestamp?: number;
    completedMessageTimestamp?: number;
    completedTimeUsed?: number;
  } | null;
  remainingTokens: number | null;
  mode: 'active' | 'exiting' | 'none';
  goalHistory: GoalEvent[];
}

// ===================== Subagent 系统 =====================

/** 子 agent 运行状态 */
type SubagentRunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'stopped';

/** 子 agent 运行记录（pi:subagentUpdate 推送） */
interface SubagentRun {
  id: string;
  name: string;
  agent: string;
  task: string;
  status: SubagentRunStatus;
  output?: string;
  outputData?: unknown;
  outputSource?: 'submit' | 'fallback';
  error?: string;
  async: boolean;
  depth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  progress?: {
    currentTool?: string;
    currentToolArgs?: string;
    recentTools: Array<{ tool: string; endMs: number }>;
    turns: number;
    tokens: number;
    durationMs: number;
  };
  /** 工具调用流水(详情视图) */
  toolCalls?: SubagentToolCall[];
  /** 对话流(详情视图「对话」Tab;运行中实时采集,重启后为空) */
  transcript?: SubagentTranscriptItem[];
  /** 子 agent 会话文件路径(独立目录 subagent-sessions/;终态/重启后回放对话用) */
  sessionFile?: string;
}

/**
 * 子 agent 对话流条目(与 electron/subagents/types.ts 的 ChildTranscriptItem 一致)。
 * 工具条目只存 id,参数/结果由 toolCalls 提供。
 */
type SubagentTranscriptItem =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | { kind: 'tool'; at: number; toolCallId: string }
  | { kind: 'stream'; at: number; text: string; thinking: string; toolCallIds: string[] };

/** 子 agent 工具调用记录(详情视图) */
interface SubagentToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  pending?: boolean;
  startedAt: number;
  endedAt?: number;
}

/** 子 agent 会话文件回放的对话数据(pi:subagent:getSession) */
interface SubagentConversation {
  transcript: SubagentTranscriptItem[];
  toolCalls: SubagentToolCall[];
}

/** Subagent 快照（window.pi.subagents.getSnapshot 返回 / pi:subagentUpdate 推送） */
interface SubagentSnapshot {
  runs: SubagentRun[];
  agents: Array<{
    name: string;
    description: string;
    source: 'builtin' | 'user' | 'project';
    tools?: string[];
  }>;
}

// ===================== 会话槽（多会话后台运行） =====================

/** 一个「活着的会话」在主进程侧的状态投影（window.pi.getSessionSlots / onSessionSlots） */
export interface SessionSlotSnapshot {
  /** 槽键：按会话操作（如 abort）时传它 */
  key: string;
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string;
  /** 是否有工作在飞（在途回合或排队消息待跑） */
  running: boolean;
  /** 后台期间跑完了一轮 → 未读点 */
  unread: boolean;
  /** 挂起的权限审批数 */
  pendingApprovals: number;
  /** 挂起的 ask 提问数（与 pendingApprovals 一起显示「等待审批」） */
  pendingAsks: number;
  /** 因并发上限（同时 3 个会话）排队中的用户回合数 */
  queuedPrompts: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface SessionSlotsPayload {
  focusedKey: string;
  slots: SessionSlotSnapshot[];
}

// ===================== 后台任务 =====================

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'interrupted';

export interface BackgroundTaskSnapshot {
  id: string;
  name: string;
  command: string;
  description?: string;
  status: BackgroundTaskStatus;
  cwd: string;
  projectKey: string;
  sessionId: string;
  outputPath: string;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  bytesWritten: number;
  isAgent: boolean;
  error?: string;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number;
}

export interface BackgroundTaskSnapshotList {
  tasks: BackgroundTaskSnapshot[];
}

/** 清理后台任务记录的返回结构（同主进程 BackgroundTaskRemoveResult + ok/error 包装） */
export interface BackgroundTaskRemoveResult {
  ok: boolean;
  removed: string[];
  failed: Array<{ id: string; error: string }>;
  error?: string;
}

export interface BackgroundTaskLogResult {
  taskId: string;
  content: string;
  outputPath: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
  tail: boolean;
}

// ===================== git-ai 改动溯源 =====================

/** git-ai 上报范围：全部 / 仅文件改动 / 仅 shell 命令 */
export type GitAiScope = 'all' | 'files' | 'shell';

/** git-ai 集成配置（~/.pi-desktop/git-ai.json） */
export interface GitAiConfig {
  /** 总开关：关闭后不再上报任何 checkpoint */
  enabled: boolean;
  /** 二进制路径覆盖：空串 = 自动探测，支持 `~` 写法 */
  binPath: string;
  scope: GitAiScope;
}

/** 二进制路径来源：设置页指定 / 环境变量 / 官方安装目录 / 系统 PATH */
export type GitAiBinSource = 'config' | 'env' | 'installed' | 'path';

/** git-ai 二进制探测结果（设置页「检测结果」行） */
export interface GitAiStatus {
  bin: string;
  source: GitAiBinSource;
  /** 忽略设置页路径后的自动探测结果 */
  autoBin: string;
  autoSource: GitAiBinSource;
  /** 官方安装落点（仅用于提示） */
  installedPath: string;
  /** PI_DESKTOP_GIT_AI_BIN 环境变量的值（未设置 null） */
  envValue: string | null;
  /** --version 解析出的版本号（拿不到 null） */
  version: string | null;
  configPath: string;
}

// ===================== Memory =====================

/** 记忆目标文件 id */
export type MemoryFileId = 'USER.md' | 'MEMORY.md' | 'LESSONS.md' | 'STANDING.md' | 'project';

/** 记忆系统配置（~/.pi-desktop/memory/config.json） */
export interface MemoryConfig {
  enabled: boolean;
  extractModel: { provider: string; modelId: string } | null;
  consolidateThreshold: number;
  userProfileCharLimit: number;
  writePolicy: 'automatic' | 'review' | 'explicit';
}

/** Phase1 提取结果 */
export interface MemoryExtractionResult {
  scanned: number;
  extracted: number;
  skipped: number;
  failed: number;
  pendingConsolidation: number;
}

/** 提取进度（pi:memoryProgress 推送） */
export interface MemoryExtractionProgress {
  kind: 'extraction' | 'consolidation';
  jobId?: string;
  projectId?: string;
  total: number;
  done: number;
  current?: string;
  phase: 'scan' | 'extract' | 'done' | 'error';
  message?: string;
}

/** 记忆文件统计 */
export interface MemoryFileStat {
  id: string;
  size: number;
  entries: number;
  exists: boolean;
}

/** 注入串的分段明细（本会话实际注入的记忆块） */
export interface MemoryInjectionSection {
  id: 'context-header' | 'standing' | 'user-profile' | 'topics' | 'context-footer' | 'policy';
  /** UI 展示名（XML 标签名或说明） */
  label: string;
  /** 来源：记忆文件名或「固定文案」 */
  source: string;
  /** 是否来自固定文案（非记忆文件内容） */
  fixed: boolean;
  content: string;
  /** 字符数（未注入为 0） */
  chars: number;
  /** 是否实际参与注入（来源为空文件或整块被跳过时为 false） */
  included: boolean;
  /** 来源文件是否被截断后注入（仅 user-profile 可能为 true） */
  truncated?: boolean;
  /** 截断前的原始字符数 */
  originalChars?: number;
}

/** 提取失败的会话（水位线里带 error 的条目，再次提取会重试） */
export interface MemoryFailedSession {
  /** 会话文件名 */
  name: string;
  /** 失败时间（ISO） */
  at: string;
  /** 错误信息（LLM 调用失败 / JSON 解析失败等） */
  error: string;
}

/** 本会话注入明细（MemoryStatus.injection） */
export interface MemoryInjectionInfo {
  /** 本会话是否存在注入串（启用后提供最小检索规则） */
  active: boolean;
  /** 快照冻结时间（ISO） */
  frozenAt: string | null;
  totalChars: number;
  /** 固定头/尾标记（<memory-context> 说明与结束标记）字符数 */
  markerChars: number;
  truncated: boolean;
  sections: MemoryInjectionSection[];
}

/** 记忆系统状态（window.pi.memory.getStatus 返回） */
export interface MemoryStatus {
  enabled: boolean;
  extractModel: { provider: string; modelId: string } | null;
  consolidateThreshold: number;
  files: MemoryFileStat[];
  pendingExtractions: number;
  /** 提取失败的会话总数 */
  failedCount: number;
  /** 提取失败的会话明细（最多 20 条，按失败时间倒序） */
  failedSessions: MemoryFailedSession[];
  extractionFiles: string[];
  lastConsolidation: string | null;
  processedCount: number;
  stats: { extractions: number; consolidations: number };
  busy: { extracting: boolean; consolidating: boolean };
  injected: boolean;
  /** 本会话注入串的分段明细（记忆面板展示） */
  injection: MemoryInjectionInfo;
  projectName: string;
  projectId: string;
  job: { id: string; projectId: string } | null;
  candidates: MemoryCandidate[];
  history: MemoryHistory[];
  legacyProjects: string[];
  unassignedExtractions: number;
}

export interface MemoryChange {
  file: string;
  before: string;
  after: string;
}
export interface MemoryCandidate {
  id: string;
  projectId: string;
  createdAt: string;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
  extractionIds: string[];
  changes: MemoryChange[];
  warnings: string[];
}
export interface MemoryHistory {
  id: string;
  at: string;
  reason: string;
  files: string[];
}
export interface MemoryEntryDetail {
  id: string;
  file: string;
  text: string;
  created: string | null;
  status: string;
  sources: Array<{
    id: string;
    content: string;
    session?: string;
    entryIds?: string[];
    sourceTime?: string;
  }>;
}
/** 记忆检索命中 */
export interface MemorySearchHit {
  file: string;
  line: number;
  text: string;
  id: string;
  created: string | null;
  status: string;
  sources: string[];
  scope: 'project' | 'global';
  score: number;
}

/** Plan 模式阶段 */
type PlanPhase = 'idle' | 'planning' | 'executing';

/** 挂起待审批的方案提案(pi:planProposal 推送 / pendingProposal 字段) */
interface PendingProposal {
  id: string;
  content: string;
  variant: number;
  summary?: string;
  createdAt: number;
}

/** Plan 状态快照(pi:planUpdate 推送 / window.pi.plan.get 返回) */
interface PlanSnapshot {
  phase: PlanPhase;
  pendingProposal: PendingProposal | null;
  lastApprovedPlan: string | null;
}

/** 方案审批决策(渲染进程回灌) */
interface PlanDecision {
  approved: boolean;
  /** 编译好的反馈串(驳回时带原文锚点 / 批准附注时为全局 notes) */
  feedback?: string;
}

/** AgentMessage：会话消息（LLM 三类消息 + 自定义消息的 union） */
type AgentMessage = SessionEntry extends { type: 'message'; message: infer M } ? M : never;

/** 单个模型（来自 pi-ai，经 ModelCycleResult.model 提取） */
type Model = ModelCycleResult['model'];

/** AuthStatus：供应商鉴权状态（主包未 re-export，结构与 sdk provider-composer 一致） */
interface AuthStatus {
  configured: boolean;
  source?:
    'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  label?: string;
}

/** AuthCheck：checkAuth 返回（来自 pi-ai auth/types） */
interface AuthCheck {
  source?: string;
  type: 'api_key' | 'oauth';
}

/** ResourceDiagnostic：资源加载诊断（主包未 re-export，结构与 sdk resource-loader 一致） */
interface ResourceDiagnostic {
  type: string;
  message: string;
  path?: string;
}

// ─── IPC handler 加工后的返回类型 ───

/** getBuiltinProviders 返回：内置供应商的展示信息（model-ipc.ts 手工挑字段） */
interface BuiltinProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  modelCount: number;
  /** 决策模型（classifier）数量，chat 与 classifier 在 SDK 里是两套清单 */
  classifierCount?: number;
  authConfigured: boolean;
  authSource?: AuthStatus['source'];
  authLabel?: string;
}

/** getCommands 返回：合并 extension/prompt/skill 三处命令（misc-ipc.ts 组装） */
interface CommandInfo {
  name: string;
  description: string;
  source: 'extension' | 'prompt' | 'skill';
}

/** 会话属性弹窗数据：getSessionInfo 返回（misc-ipc.ts 组装） */
interface SessionInfoDetail {
  /** 当前生效的系统提示词（含 skills/AGENTS 注入后的完整内容） */
  systemPrompt: string;
  /** 系统提示词来源文件（AGENTS.md / 全局 prompt 等） */
  systemPromptSources: { path: string }[];
  /** 注入的工具：全部注册项 + active 标记 */
  tools: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    active: boolean;
    source: string;
  }[];
  /** 注入的 skills（会话可见，含 disableModelInvocation 标记） */
  skills: {
    name: string;
    description: string;
    filePath: string;
    baseDir?: string;
    scope?: string;
    origin?: string;
    disableModelInvocation: boolean;
    /** 内置只读技能（随安装包发布，位于 builtinSkillsDir 之下） */
    builtin?: boolean;
  }[];
  /** 加载的 prompt 模板 */
  prompts: { name: string; description: string; argumentHint: string; filePath: string }[];
  /** 扩展注册的命令 */
  extCommands: { name: string; description: string }[];
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  cwd: string;
  sessionId: string;
  sessionFile: string | null;
  sessionName: string | undefined;
}

/** getState / setCwd 返回的会话状态快照（misc-ipc.ts 组装） */
interface SessionState extends SessionIdentity {
  model: Model | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messages: AgentMessage[];
  sessionId: string;
  sessionFile: string | undefined;
  sessionName?: string;
  cwd: string;
}

/** getContextDetail 返回：上下文详情面板数据 */
interface ContextDetail {
  /** 完整消息历史（结构复杂，面板上仅需访问 role/content 等公共字段） */
  messages: any[];
  systemPrompt: string;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  cost: number | null;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  model: { provider: string; id: string } | null;
  contextWindow: number | null;
}

/** getTree 返回的骨架节点（避免大 entry 超 contextBridge 传输） */
interface SkeletonTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  label?: string;
  tag: string;
  text: string;
}

/** getTree 返回（session-ipc.ts 包一层） */
interface SessionTreeResult {
  /** 已展平的骨架节点列表， renderer 用 parentId 重建树 */
  nodes: SkeletonTreeNode[];
  /** 首个根节点 id（多根场景取第一个为主） */
  rootId: string | null;
  leafId: string | null;
}

/** listSessions 返回（session-ipc.ts 两次 list 合并） */
interface SessionListResult {
  current: SessionInfo[];
  all: SessionInfo[];
}

/** getSkills 返回（skill-ipc.ts 挑字段） */
interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope?: SourceInfo['scope'];
  source?: SourceInfo['source'];
  origin?: string;
  disableModelInvocation: boolean;
  /** 内置只读技能（随安装包发布）：前端隐藏删除/隐藏/编辑按钮 */
  builtin?: boolean;
}

interface SkillsResult {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
}

/** readSkillFile 返回 */
interface SkillFileContent {
  path: string;
  baseDir: string;
  content: string;
}

/** 技能导入结果 */
interface SkillImportResult {
  ok: boolean;
  name: string;
  target: string;
}

/** 从 OpenAI 兼容端点 /v1/models 拉取的模型条目 */
interface FetchedModel {
  id: string;
}

/** fetchModels 返回 */
interface FetchModelsResult {
  ok: boolean;
  models: FetchedModel[];
  error?: string;
}

/** forkByTimestamp 返回 */
interface ForkByTimestampResult {
  ok: boolean;
  entryId: string;
}

/** 通用操作结果 */
interface OperationResult {
  ok: boolean;
}

/** duplicateSession 返回 */
interface DuplicateSessionResult extends OperationResult {
  newSessionPath: string;
}

/** exportSessionJsonl / exportSessionHtml 返回 */
interface ExportResult extends OperationResult {
  filePath: string;
}

/** listFiles 返回的单条条目 */
interface FileEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** saveDialog 的过滤器选项 */
interface FileFilter {
  name: string;
  extensions: string[];
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

/** 终端创建选项 */
interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** 指定运行的 shell（留空走平台自动探测） */
  shell?: string;
}

/** 终端创建返回 */
interface TerminalCreateResult {
  id: string;
  shell?: string;
  cwd?: string;
  error?: string;
}

/** 探测到的可用 shell（设置页下拉用） */
interface DetectedShell {
  id: string;
  label: string;
  path: string;
}

// ─── window.pi 接口 ───

/** 生命周期钩子事件（= pi SDK 扩展事件名，用户可挂载的子集） */
export type HookEvent =
  | 'input'
  | 'before_agent_start'
  | 'message_end'
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'tool_call'
  | 'tool_result'
  | 'session_start'
  | 'session_before_compact'
  | 'session_compact'
  | 'session_before_switch'
  | 'session_before_fork'
  | 'session_shutdown'
  | 'before_provider_request'
  | 'after_provider_response'
  | 'model_select'
  | 'thinking_level_select';

/** 生命周期钩子配置（~/.pi-desktop/hooks.json） */
export interface HookConfig {
  id: string;
  event: HookEvent;
  name: string;
  /** shell 命令，事件 JSON 经 stdin 传入 */
  command: string;
  /** 超时秒数 */
  timeoutSec: number;
  enabled: boolean;
}

/** MCP 服务器配置 */
interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** HTTP 传输类型：streamable-http（默认）或 sse */
  transport?: 'streamable-http' | 'sse';
  /** Bearer token：可直接填值，或用 $VAR 引用环境变量 */
  bearerToken?: string;
  /** 从环境变量读取 bearer token 的变量名 */
  bearerTokenEnv?: string;
  disabled?: boolean;
  /** 运行时内置服务标记，不写入 mcp.json */
  builtin?: boolean;
}

/** MCP 配置 */
interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** MCP 服务器状态 */
interface McpServerStatus {
  name: string;
  entry: McpServerEntry;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/** UI 设置（持久化到 ~/.pi-desktop/ui-config.json） */
interface UiSettings {
  /** 界面字号（px） */
  fontSize?: number;
  /** UI 字体族 */
  uiFontFamily?: string;
  /** 会话侧栏宽度（px） */
  sidebarWidth?: number;
  /** 旧版代码面板宽度（仅迁移读取） */
  codePanelWidth?: number;
  /** 右侧工作区宽度（px） */
  rightPanelWidth?: number;
  /** 是否启用内置浏览器 */
  browserEnabled?: boolean;
  /** 是否开启浏览器调试能力（CDP 抓包 + 执行任意 JS），默认关 */
  browserDevtoolsEnabled?: boolean;
  /** 终端面板高度（px） */
  terminalPanelHeight?: number;
  /** 终端字体族 */
  terminalFontFamily?: string;
  /** 终端字号（px） */
  terminalFontSize?: number;
  /** 终端默认运行的 shell（留空走平台自动探测） */
  terminalShell?: string;
  /** 编辑器主题：'auto' = 跟随应用明暗（深色 vs-dark / 浅色 vs），否则为 Monaco 内置主题名 */
  monacoTheme?: 'auto' | 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  /** 编辑器字体族（空 = Monaco 内置默认，跨平台自适应） */
  monacoFontFamily?: string;
  /** 编辑器字号（px，8~48） */
  monacoFontSize?: number;
  /** 编辑器行高（0 = 自动；1~8 为字号倍数；>=8 为像素） */
  monacoLineHeight?: number;
  /** 编辑器 Tab 宽度（空格数，1~8） */
  monacoTabSize?: number;
  /** 是否启用字体连字（需所选字体支持） */
  monacoLigatures?: boolean;
  /** 是否自动换行 */
  monacoWordWrap?: boolean;
  /** 是否显示右侧小地图 */
  monacoMinimap?: boolean;
  /** 是否显示行号 */
  monacoLineNumbers?: boolean;
  /** 是否启用粘性滚动（顶部悬浮当前作用域） */
  monacoStickyScroll?: boolean;
  /** 是否显示缩进参考线 */
  monacoIndentGuides?: boolean;
  /** TODO 面板宽度（px） */
  todoPanelWidth?: number;
  /** 智能体模式 */
  mode?: 'standard' | 'plan' | 'goal';
  /** 代码面板文件树宽度（px） */
  fileTreeWidth?: number;
  /** 聊天区左侧书签指示器是否展示（默认 true） */
  showBookmarks?: boolean;
  /** 对话中是否显示模型思考块（默认 true） */
  showThinkingBlocks?: boolean;
  /** 连续工具调用默认折叠为摘要（默认 true） */
  collapseToolCalls?: boolean;
  /** 同项目已有其他会话在跑时，输入框是否弹提醒蒙层（默认 true） */
  sameProjectBusyWarn?: boolean;
  /** 模型回复期间发送消息的默认方式（'steer' = 引导消息 / 'followUp' = 排队消息，默认 steer） */
  streamingSendMode?: 'steer' | 'followUp';
  /** 权限沙箱策略（主进程 PermissionController 同步读同一字段） */
  permissionPolicy?: 'ask-all' | 'auto-safe' | 'classifier-auto' | 'allow-all';
  /** auto-safe 自定义白名单（安全工具 + bash 命令） */
  permissionAutoSafeConfig?: { safeTools?: string[]; safeBashCommands?: string[] };
  /** 决策模型自动审批配置（providerId/modelId 必须成对） */
  permissionClassifierConfig?: ClassifierApprovalConfig;
  /** read_img 图片识别模型（null = 不启用该工具） */
  readImgModel?: { provider: string; modelId: string } | null;
}

export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserState {
  enabled: boolean;
  tabs: BrowserTabState[];
  activeTabId: string | null;
}

export interface BrowserViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 可用视觉模型（getVisionModels 返回） */
interface VisionModelInfo {
  provider: string;
  id: string;
  name: string;
}

// === 决策模型（classifier）===

/** 决策模型协议。System One 含内置供应商与本地 llama.cpp /v1/systemone；
 *  llama-cpp-classify 是把普通 chat 模型当分类器用 */
export type ClassifierApiKind = 'typesafe-system-one' | 'llama-cpp-classify';

/** 日志等级（由低到高；配置的等级以下的记录被丢弃） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志功能（频道）：设置页按此渲染开关 */
export type LogChannelId = 'classifier' | 'model' | 'tools' | 'permission' | 'app';

/** 日志配置（存 ~/.pi-desktop/ui-config.json 的 logConfig） */
export interface LogConfig {
  /** 总开关 */
  enabled: boolean;
  /** 等级门槛 */
  level: LogLevel;
  /** 每个功能的开关（缺省视为开启） */
  channels: Record<string, boolean>;
  /** 保留天数（1~365） */
  retentionDays: number;
}

/** 日志文件信息（listLogFiles 返回） */
export interface LogFileInfo {
  name: string;
  channel: string;
  sizeBytes: number;
  mtimeMs: number;
  rotated: boolean;
}

/** 决策模型清单条目（getClassifierModels 返回） */
export interface ClassifierModelInfo {
  provider: string;
  id: string;
  name: string;
  providerName: string;
  api: string;
  apiLabel: string;
  contextWindow?: number;
  supportsImage: boolean;
  /** 凭据是否就绪；未就绪时调用会报「No API key」 */
  available: boolean;
  /** 是否来自自定义配置 ~/.pi-desktop/classifiers.json */
  custom: boolean;
}

/** 自定义决策模型 provider 配置（与 electron/classifier-config.ts 同构） */
interface ClassifierProviderModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  input?: ('text' | 'image')[];
}

export interface ClassifierProviderConfig {
  key: string;
  name?: string;
  baseUrl: string;
  api: ClassifierApiKind;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ClassifierProviderModelConfig[];
}

/** 分类问题定义（choice / score / bool 三种） */
export interface ClassifierQuestion {
  type: 'choice' | 'score' | 'bool';
  instructions: string;
  /** choice: 标签 → 说明；score: 各档说明数组；bool: { true, false } */
  criteria: Record<string, string> | string[];
}

/** classify() 请求 */
export interface ClassifyRequest {
  provider: string;
  id: string;
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
  timeoutMs?: number;
  /** 答案 logits 缩放（仅 llama-cpp-classify 生效，>1 更平缓，<1 更锐利） */
  temperature?: number;
}

/** 单个答案（按问题 type 分支） */
export interface ClassifierAnswer {
  type: 'choice' | 'score' | 'bool';
  choice?: string;
  score?: number;
  probability?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** classify() 结果。stopReason !== 'stop' 时答案不可信，看 errorMessage */
export interface ClassifyResult {
  api?: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: { input: number; output: number; totalTokens: number } | unknown;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

/** 端点探测出的模型 */
export interface DiscoveredClassifierModel {
  id: string;
  contextWindow?: number;
  /** llama.cpp 声明的原生 decisions 输出（architecture.output_modalities） */
  nativeDecisions?: boolean;
  supportsImage?: boolean;
}

/** ask 工具的问题结构 */
interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
  recommended?: number;
}

/** 决策模型自动审批配置（providerId/modelId 成对才有意义） */
export interface ClassifierApprovalConfig {
  /** 决策模型所属 provider（~/.pi-desktop/classifiers.json 的 key 或内置 classifier provider） */
  providerId?: string;
  /** 决策模型 id */
  modelId?: string;
  /** 单次判定超时（毫秒，500~60000） */
  timeoutMs?: number;
  /** 自动放行所需的最低置信度（0~1） */
  minConfidence?: number;
  /** 默认放行工作目录写入：开启后工作目录内的 write/edit 直接放行，不再请决策模型判断 */
  allowWriteInCwd?: boolean;
}

/**
 * 决策模型对一次工具调用的危险等级判定。
 * ok=false（模型不可用/超时/未知等级）时 level/confidence 缺省，UI 按"不可用，已回退人工审批"展示。
 */
export interface ClassifierApprovalVerdict {
  ok: boolean;
  level?: 'safe' | 'risky' | 'dangerous';
  confidence?: number;
  probabilities?: Record<string, number>;
  autoAllowed: boolean;
  /** 失败原因或未达阈值说明 */
  note?: string;
}

/** 危险命令检测结果（与 electron/permission/policy.ts 同构，主进程随审批请求推送） */
interface DangerousBashCheck {
  dangerous: boolean;
  category:
    | 'destructive-remove'
    | 'disk-write'
    | 'privilege-escalation'
    | 'shell-escape'
    | 'self-modify'
    | 'unknown';
  reason: string;
}

/** ask 工具的用户回答 */
interface AskAnswer {
  questionId: string;
  selectedLabels: string[];
  customInput?: string;
}

export interface PiAPI {
  // === Prompting ===
  /** 返回 queued=true 表示已达并发上限、该回合在排队等待空位 */
  prompt(text: string, opts?: any): Promise<{ queued: boolean }>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(sessionKey?: string | null): Promise<void>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /** 撤回单条排队消息到聊天框（clearQueue + 其余重新入队），返回被撤回文本 */
  revokeQueuedMessage(
    kind: 'steering' | 'followUp',
    index: number
  ): Promise<{ ok: boolean; revoked: string }>;
  /** 删除单条排队消息（只删这一条，不是清空队列），返回被删除文本 */
  removeQueuedMessage(
    kind: 'steering' | 'followUp',
    index: number
  ): Promise<{ ok: boolean; removed: string }>;
  /** 切换单条排队消息的投递方式（引导 ↔ 排队），成功后队列由 queue_update 事件同步 */
  switchQueuedMessage(
    kind: 'steering' | 'followUp',
    index: number
  ): Promise<{ ok: boolean; text?: string }>;
  /** 同队列内拖拽排序：把第 from 条移到插入点 to（to === 队列长度表示落到队尾） */
  reorderQueuedMessage(
    kind: 'steering' | 'followUp',
    from: number,
    to: number
  ): Promise<{ ok: boolean; moved: string }>;

  // === Session lifecycle ===
  newSession(cwd?: string): Promise<void>;
  switchSession(sessionPath: string): Promise<void>;
  fork(entryId: string, pos?: string): Promise<void>;
  forkByTimestamp(timestamp: number, pos?: string): Promise<ForkByTimestampResult>;
  duplicateSession(sessionPath: string): Promise<DuplicateSessionResult>;
  renameSession(sessionPath: string, name: string): Promise<OperationResult>;
  exportSessionJsonl(sessionPath: string, outputPath: string): Promise<ExportResult>;
  exportSessionHtml(sessionPath: string, outputPath: string): Promise<ExportResult>;
  deleteSession(sessionPath: string): Promise<OperationResult>;
  removeProject(cwd: string): Promise<OperationResult>;
  listSessions(): Promise<SessionListResult>;
  /** 所有会话槽的状态投影（侧栏徽标：在跑/未读/等待审批） */
  getSessionSlots(): Promise<SessionSlotsPayload>;
  /** 槽状态变化推送（主进程节流 ~120ms） */
  onSessionSlots(cb: (payload: SessionSlotsPayload) => void): () => void;
  getTree(): Promise<SessionTreeResult | null>;
  getSessionEntry(entryId: string): Promise<any>;
  navigateTree(id: string, summarize?: boolean): Promise<void>;
  setSessionName(name: string): Promise<void>;
  exportHtml(path?: string): Promise<{ sessionFile: string; outputPath?: string } | null>;

  // === Models & thinking ===
  getAvailableModels(): Promise<Model[]>;
  getAllModels(): Promise<Model[]>;
  /** 切换模型，返回切换后会话的最新 model / thinkingLevel（用于 renderer 同步 UI） */
  setModel(
    provider: string,
    modelId: string
  ): Promise<{
    model: Model | undefined;
    thinkingLevel: string;
  } | null>;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  setThinkingLevel(level: string): Promise<void>;
  cycleThinkingLevel(): Promise<string | undefined>;
  getThinkingLevels(): Promise<string[]>;
  /** 读取默认模型（settings.json 的 defaultProvider/defaultModel，未设置则 null） */
  getDefaultModel(): Promise<{ provider: string; modelId: string } | null>;
  /** 设置/清除默认模型（null = 清除，回落到 SDK 内置 provider 默认表）；仅影响新建会话 */
  setDefaultModel(
    provider: string | null,
    modelId: string | null
  ): Promise<{
    ok: boolean;
    config?: { provider: string; modelId: string } | null;
    error?: string;
  }>;

  // === State & messages ===
  getState(): Promise<SessionState>;
  getMessages(snapshotId: string, offset: number, limit: number): Promise<AgentMessage[]>;
  getMessageSnapshot(identity: SessionIdentity): Promise<MessageSnapshot>;
  releaseMessageSnapshot(snapshotId: string): Promise<void>;
  /** 从会话历史重建 todo 阶段（最后一条 update_plan 结果，无则空） */
  getTodoPhases(): Promise<{ phases: import('./store/pi-store').TodoPhase[]; found: boolean }>;
  getCommands(): Promise<CommandInfo[]>;
  getSessionInfo(): Promise<SessionInfoDetail>;
  getSessionStats(): Promise<SessionStats | null>;
  getUsageStatistics(
    query: UsageStatisticsQuery,
    requestId: string
  ): Promise<UsageStatistics | null>;
  cancelUsageStatistics(requestId: string): void;
  compact(instructions?: string): Promise<CompactionResult>;
  reloadSession(): Promise<void>;
  getContextDetail(): Promise<ContextDetail>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  getCompactionSettings(): Promise<{
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  }>;
  setCompactionEnabled(enabled: boolean): Promise<void>;
  setCompactionTokens(reserveTokens?: number, keepRecentTokens?: number): Promise<void>;
  /** 发送系统通知（turnEnd 对话轮次完成 / ask 模型提问）；主进程按通知设置 + 窗口聚焦裁决 */
  notify(kind: 'turnEnd' | 'ask', title: string, body?: string): Promise<void>;
  /** 读取全局自定义指令（~/.pi-desktop/AGENTS.md，无则空串） */
  getGlobalInstructions(): Promise<string>;
  /** 保存全局自定义指令；空文本删除文件；写入后重载当前会话资源 */
  setGlobalInstructions(text: string): Promise<void>;

  // === Providers ===
  getProviders(): Promise<{ providers: Record<string, Provider> }>;
  saveProvider(config: Provider): Promise<void>;
  removeProvider(key: string): Promise<void>;
  setApiKey(provider: string, key: string): Promise<void>;
  checkAuth(provider: string): Promise<AuthCheck | { status: 'unknown' }>;
  getBuiltinProviders(): Promise<BuiltinProviderInfo[]>;
  /** 手动刷新供应商与模型清单（允许网络，重新拉取远端模型目录） */
  refreshProviders(): Promise<{ ok: boolean; error?: string }>;
  setProviderApiKey(providerId: string, key: string): Promise<OperationResult>;
  removeProviderApiKey(providerId: string): Promise<OperationResult>;
  /** 读取 auth.json 里已保存的内置供应商 Key（编辑表单回填；未保存/非 api_key 凭证返回 ''） */
  getProviderApiKey(providerId: string): Promise<string>;

  // === 从 OpenAI 兼容端点拉取模型列表 ===
  fetchModels(baseUrl: string, apiKey?: string): Promise<FetchModelsResult>;
  /**
   * SDK 内置模型目录（离线、无鉴权、随 SDK 升级自动更新），用于自定义 Provider 的
   * 模型预设：按模型 id 给建议 / 预设下拉 / 拉取结果自动补齐参数。
   */
  getModelPresets(): Promise<ModelPreset[]>;

  // === Skills ===
  getSkills(): Promise<SkillsResult>;
  getProjectSkills(cwd?: string): Promise<SkillsResult>;
  reloadSkills(): Promise<SkillsResult>;
  readSkillFile(skillName: string): Promise<SkillFileContent>;
  writeSkillFile(skillName: string, content: string): Promise<OperationResult>;
  deleteSkill(skillName: string): Promise<OperationResult>;
  toggleSkill(
    skillName: string,
    disable: boolean
  ): Promise<OperationResult & { disableModelInvocation: boolean }>;
  /** 从技能目录导入（校验+选目标+复制） */
  importSkillFromDir(sourceDir: string): Promise<SkillImportResult>;
  /** 从技能 zip 导入（解压+校验+选目标+复制） */
  importSkillFromZip(zipPath: string): Promise<SkillImportResult>;
  /** 项目级导入：目标 <cwd>/.agents/skills 或 <cwd>/.pi-desktop/skills */
  importProjectSkillFromDir(sourceDir: string, projectCwd: string): Promise<SkillImportResult>;
  importProjectSkillFromZip(zipPath: string, projectCwd: string): Promise<SkillImportResult>;

  // === File operations (for Monaco Code Panel) ===
  readFile(filePath: string): Promise<string>;
  listFiles(dir?: string): Promise<FileEntryInfo[]>;
  detectApps(): Promise<ExternalApp[]>;
  openWith(filePath: string, appId: string): Promise<{ ok: boolean }>;
  showInFolder(filePath: string): Promise<{ ok: boolean }>;
  /** 主题明暗联动窗口材质（macOS vibrancy 刷新 / Windows overlay 符号色） */
  setThemeAppearance(mode: 'dark' | 'light' | 'system'): Promise<{ ok: boolean }>;
  /** 用系统默认浏览器打开外部 URL（markdown 链接点击等场景） */
  openExternal(url: string): Promise<{ ok: boolean }>;

  // === Git ===
  gitStatus(
    cwd?: string
  ): Promise<{ installed: boolean; isRepo: boolean; currentBranch: string | null }>;
  gitBranches(cwd?: string): Promise<{
    installed: boolean;
    isRepo: boolean;
    branches: { name: string; current: boolean }[];
  }>;
  gitSwitchBranch(branch: string, cwd?: string): Promise<{ ok: boolean; error?: string }>;
  /** 跨平台取路径最后一段（项目名/目录名），等价于 node path.basename */
  baseName(p: string): Promise<string>;
  getCwd(): Promise<string>;
  setCwd(cwd: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  selectFile(opts?: { title?: string; filters?: FileFilter[] }): Promise<string | null>;
  saveDialog(opts: SaveDialogOptions): Promise<string | null>;
  setPlanMode(enabled: boolean): Promise<{ ok: boolean }>;
  askUserResponse(sessionId: string, answers: AskAnswer[] | null): Promise<{ ok: boolean }>;
  /** 焦点会话挂起的交互（提问/审批）：切换/刷新会话状态后拉取，补上被事件过滤丢掉的面板 */
  getPendingInteractions(): Promise<{
    ask: { sessionId: string; questions: AskQuestion[] } | null;
    permission: PermissionRequest | null;
  }>;
  onAskUser(cb: (questions: AskQuestion[], identity: SessionIdentity) => void): () => void;

  // === 权限沙箱 ===
  /** 查询当前权限策略 */
  getPermissionPolicy(): Promise<'ask-all' | 'auto-safe' | 'classifier-auto' | 'allow-all'>;
  /** 设置权限策略（立即生效） */
  setPermissionPolicy(
    policy: 'ask-all' | 'auto-safe' | 'classifier-auto' | 'allow-all'
  ): Promise<{ ok: boolean; policy?: string; error?: string }>;
  /** 查询 auto-safe 自定义白名单 */
  getAutoSafeConfig(): Promise<{ safeTools?: string[]; safeBashCommands?: string[] }>;
  /** 设置 auto-safe 自定义白名单（立即生效并持久化） */
  setAutoSafeConfig(config: {
    safeTools?: string[];
    safeBashCommands?: string[];
  }): Promise<{ ok: boolean; config?: { safeTools?: string[]; safeBashCommands?: string[] } }>;
  /** 查询决策模型自动审批配置 */
  getClassifierApprovalConfig(): Promise<ClassifierApprovalConfig>;
  /** 设置决策模型自动审批配置（归一化后立即生效并持久化） */
  setClassifierApprovalConfig(
    config: ClassifierApprovalConfig
  ): Promise<{ ok: boolean; config?: ClassifierApprovalConfig; error?: string }>;
  /** 回传审批决策（allow-session = 本次会话内同名工具自动放行） */
  permissionResponse(
    id: string,
    decision: 'allow' | 'deny' | 'allow-session'
  ): Promise<{ ok: boolean }>;
  /** 查询本会话内已「本次会话允许」的工具名列表 */
  getSessionAllowedTools(): Promise<string[]>;
  /** 撤销「本次会话允许」状态（恢复逐次审批） */
  clearSessionAllowedTools(): Promise<{ ok: boolean }>;
  /** 订阅审批请求推送 */
  onPermissionRequest(
    cb: (
      request: {
        id: string;
        toolName: string;
        preview: string;
        requestedAt: number;
        danger?: DangerousBashCheck;
        /** classifier-auto 策略下的模型判定（ok=false 表示已回退人工审批） */
        classifier?: ClassifierApprovalVerdict;
      },
      identity: SessionIdentity
    ) => void
  ): () => void;

  // === UI Settings (persisted to ~/.pi-desktop/ui-config.json) ===
  getUiSettings(): Promise<UiSettings>;
  setUiSettings(patch: Partial<UiSettings>): Promise<{ ok: boolean }>;
  // === 生命周期钩子（~/.pi-desktop/hooks.json） ===
  /** 获取全部钩子 */
  getHooks(): Promise<HookConfig[]>;
  /** 新增/更新钩子（有 id 且存在则更新） */
  upsertHook(
    hook: Partial<HookConfig> & { event: HookEvent; command: string }
  ): Promise<{ ok: boolean; hook?: HookConfig; error?: string }>;
  /** 删除钩子 */
  deleteHook(id: string): Promise<{ ok: boolean }>;
  /** 启用/禁用钩子 */
  setHookEnabled(
    id: string,
    enabled: boolean
  ): Promise<{ ok: boolean; hook?: HookConfig; error?: string }>;
  /** 可用视觉模型列表（已鉴权且支持图片输入） */
  getVisionModels(): Promise<VisionModelInfo[]>;

  // === 决策模型（classifier）===
  /** 全部决策模型（含未配置凭据的），带 available 标记 */
  getClassifierModels(): Promise<{
    models: ClassifierModelInfo[];
    errors: { key: string; message: string }[];
  }>;
  /** 执行一次分类。classify 不 reject，错误在返回值的 stopReason/errorMessage 里 */
  classify(request: ClassifyRequest): Promise<ClassifyResult>;
  /** 决策模型调用日志位置（~/.pi-desktop/logs/classifier-YYYY-MM-DD.log）；enabled=false 表示日志未启用（不会写文件） */
  getClassifierLogPath(): Promise<{ dir: string; file: string; enabled: boolean }>;
  /** 自定义决策模型 provider 列表（~/.pi-desktop/classifiers.json） */
  getClassifierProviders(): Promise<{
    providers: ClassifierProviderConfig[];
    path: string;
    apiKinds: ClassifierApiKind[];
    defaultContextWindow: number;
    errors: { key: string; message: string }[];
  }>;
  saveClassifierProvider(
    config: ClassifierProviderConfig
  ): Promise<{ ok: boolean; key?: string; error?: string }>;
  removeClassifierProvider(key: string): Promise<{ ok: boolean; error?: string }>;
  /** 从端点探测模型列表（llama.cpp /v1/models，读 n_ctx 与 output_modalities） */ fetchClassifierModels(
    baseUrl: string,
    apiKey?: string
  ): Promise<{ ok: boolean; models: DiscoveredClassifierModel[]; error?: string }>;
  /** 设置/清除 read_img 图片识别模型（null = 不配置） */
  setReadImgModel(
    provider: string | null,
    modelId: string | null
  ): Promise<{
    ok: boolean;
    config?: { provider: string; modelId: string } | null;
    error?: string;
  }>;
  /** Windows/Linux 关于弹窗 */
  showAbout(): Promise<{ ok: boolean }>;
  /** 打开「开源许可」清单窗口；清单未生成时返回 { ok: false } */
  openThirdPartyNotices(): Promise<{ ok: boolean; error?: string }>;
  /** 菜单栏「打开文件夹」事件 */
  onMenuOpenFolder(cb: () => void): () => void;
  /** 菜单栏「设置」事件（macOS App 菜单） */
  onMenuOpenSettings(cb: () => void): () => void;

  // === Goal Mode ===
  goal: {
    create(text: string, tokenBudget?: number): Promise<{ ok: boolean; queued?: boolean }>;
    pause(): Promise<{ ok: boolean }>;
    resume(): Promise<{ ok: boolean }>;
    clear(): Promise<{ ok: boolean }>;
    edit(text?: string, tokenBudget?: number | null): Promise<{ ok: boolean }>;
    get(): Promise<GoalSnapshot>;
  };
  onGoalUpdate(cb: (snapshot: GoalSnapshot, identity: SessionIdentity) => void): () => void;

  // === Plan Mode ===
  plan: {
    enter(): Promise<{ ok: boolean }>;
    exit(): Promise<{ ok: boolean }>;
    get(): Promise<PlanSnapshot>;
    submitResponse(id: string, decision: PlanDecision): Promise<{ ok: boolean }>;
  };
  /** 方案提交(propose_plan 工具 → 主进程 → 渲染进程弹评审面板) */
  onPlanProposal(cb: (proposal: PendingProposal, identity: SessionIdentity) => void): () => void;
  /** plan 状态更新(阶段切换 / pending 变化) */
  onPlanUpdate(cb: (snapshot: PlanSnapshot, identity: SessionIdentity) => void): () => void;

  // === MCP ===
  getMcpConfig(): Promise<McpConfig>;
  saveMcpConfig(config: McpConfig): Promise<{ ok: boolean; error?: string }>;
  /** 读取项目级 MCP 配置（<cwd>/.mcp.json） */
  getProjectMcpConfig(cwd?: string): Promise<McpConfig>;
  /** 保存项目级 MCP 配置（<cwd>/.mcp.json） */
  saveProjectMcpConfig(config: McpConfig, cwd?: string): Promise<{ ok: boolean; error?: string }>;
  connectMcpServer(name: string, entry: McpServerEntry): Promise<McpServerStatus>;
  disconnectMcpServer(name: string): Promise<{ ok: boolean }>;
  getMcpStatus(): Promise<McpServerStatus[]>;
  getMcpTools(): Promise<{ name: string; label: string; description: string }[]>;
  getMcpAutoConnect(): Promise<boolean>;
  setMcpAutoConnect(v: boolean): Promise<{ ok: boolean }>;

  // === 内置浏览器 ===
  browser: {
    getState(): Promise<BrowserState>;
    setEnabled(enabled: boolean): Promise<BrowserState>;
    setDevtoolsEnabled(enabled: boolean): Promise<BrowserState>;
    open(url?: string): Promise<BrowserTabState>;
    close(tabId?: string): Promise<BrowserState>;
    activate(tabId: string): Promise<BrowserTabState>;
    navigate(tabId: string | undefined, input: string): Promise<BrowserTabState>;
    back(tabId?: string): Promise<BrowserTabState>;
    forward(tabId?: string): Promise<BrowserTabState>;
    reload(tabId?: string): Promise<BrowserTabState>;
    stop(tabId?: string): Promise<BrowserTabState>;
    setViewport(viewport: BrowserViewport): Promise<{ ok: boolean }>;
    setVisible(visible: boolean): Promise<{ ok: boolean }>;
    clearData(): Promise<{ ok: boolean }>;
  };
  onBrowserStateChanged(cb: (state: BrowserState) => void): () => void;
  onBrowserFocusRequested(cb: (tabId: string) => void): () => void;

  // === Platform / events ===
  platform: NodeJS.Platform;
  /** 用户家目录（面包屑缩写、Git 家目录跳过探测用） */
  homeDir: string;
  onEvent(callback: (event: AgentSessionEvent & SessionIdentity) => void): () => void;
  /** 主进程请求「运行中退出」确认（关窗/cmd+Q/菜单退出），返回退订函数 */
  onQuitConfirmRequest(cb: () => void): () => void;
  /** 回答退出确认：true 主进程才真正退出 */
  resolveQuitConfirm(confirmed: boolean): Promise<void>;

  // === git-ai 改动溯源 ===
  gitAi: {
    getConfig(): Promise<GitAiConfig>;
    setConfig(
      patch: Partial<GitAiConfig>
    ): Promise<{ ok: boolean; config?: GitAiConfig; error?: string }>;
    detect(): Promise<GitAiStatus>;
  };

  // === Memory ===
  memory: {
    getConfig(): Promise<MemoryConfig>;
    setConfig(patch: Partial<MemoryConfig>): Promise<MemoryConfig>;
    readFile(
      fileId: MemoryFileId,
      projectName?: string
    ): Promise<{ content: string; revision: string; projectId: string }>;
    writeFile(
      fileId: MemoryFileId,
      content: string,
      projectName: string | undefined,
      baseRevision: string
    ): Promise<{ ok: boolean; content: string; revision: string }>;
    getDir(): Promise<string>;
    getFilePath(fileId: MemoryFileId, projectName?: string): Promise<string>;
    extract(): Promise<{ ok: boolean; result?: MemoryExtractionResult; error?: string }>;
    consolidate(): Promise<{ ok: boolean; merged: number; candidateId?: string; error?: string }>;
    cancel(): Promise<void>;
    review(
      id: string,
      projectId: string,
      accept: boolean,
      edits?: Record<string, string>
    ): Promise<void>;
    rollback(id: string, projectId: string): Promise<MemoryCandidate>;
    migrateLegacy(name: string, projectId: string): Promise<MemoryCandidate>;
    readEntry(id: string): Promise<MemoryEntryDetail | null>;
    getStatus(): Promise<MemoryStatus>;
    search(query: string): Promise<MemorySearchHit[]>;
    readExtraction(fileName: string): Promise<string>;
  };
  onMemoryProgress(cb: (progress: MemoryExtractionProgress) => void): () => void;

  // === Subagent 系统 ===
  subagents: {
    getSnapshot(): Promise<SubagentSnapshot>;
    stop(runId: string): Promise<{ ok: boolean }>;
    steer(runId: string, text: string): Promise<{ ok: boolean }>;
    reload(): Promise<SubagentSnapshot>;
    /** 读取子 agent 会话文件里的完整对话(终态/重启后);无文件返回 null */
    getSession(runId: string): Promise<SubagentConversation | null>;
  };
  onSubagentUpdate(cb: (snapshot: SubagentSnapshot, identity: SessionIdentity) => void): () => void;

  // === 后台任务 ===
  backgroundTasks: {
    getSnapshot(): Promise<BackgroundTaskSnapshotList>;
    kill(taskId: string): Promise<{ ok: boolean; task?: BackgroundTaskSnapshot; error?: string }>;
    remove(taskIds: string[]): Promise<BackgroundTaskRemoveResult>;
    readLogs(
      taskId: string,
      options?: { tail?: boolean; maxBytes?: number }
    ): Promise<BackgroundTaskLogResult>;
  };
  onBackgroundTaskUpdate(cb: (snapshot: BackgroundTaskSnapshotList) => void): () => void;

  // === 日志（~/.pi-desktop/logs）===
  /** 读日志配置 + 目录 + 已登记的功能清单 */
  getLogConfig(): Promise<{ config: LogConfig; dir: string; channels: LogChannelId[] }>;
  /** 保存日志配置（部分字段即可；保存后立即生效） */
  setLogConfig(
    patch: Partial<LogConfig>
  ): Promise<{ ok: boolean; config?: LogConfig; error?: string }>;
  /** 列出日志文件（名称/大小/修改时间） */
  listLogFiles(): Promise<{ dir: string; files: LogFileInfo[] }>;
  /** 读某功能当天日志的最后 n 行（设置页预览） */
  readLogTail(
    channel: string,
    maxLines?: number
  ): Promise<{ ok: boolean; lines?: string[]; error?: string }>;
  /** 用系统默认程序打开单个日志文件（只接受日志目录内的 `.log` / `.log.N` 名字） */
  openLogFile(name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除单个日志文件 */
  deleteLogFile(name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除所有日志文件 */
  clearLogs(): Promise<{ ok: boolean; removed?: number; error?: string }>;

  // === Terminal (node-pty) ===
  terminalCreate(opts?: TerminalCreateOptions): Promise<TerminalCreateResult>;
  terminalWrite(id: string, data: string): Promise<boolean>;
  terminalResize(id: string, cols: number, rows: number): Promise<boolean>;
  terminalKill(id: string): Promise<boolean>;
  terminalList(): Promise<string[]>;
  terminalDetectShells(): Promise<DetectedShell[]>;
  /** 终端主题色表；key 为 '<family>-<dark|light>'，返回 xterm ITheme 或 null */
  terminalTheme(key: string): Promise<Record<string, string> | null>;
  onTerminalData(id: string, cb: (data: string) => void): () => void;
  onTerminalExit(id: string, cb: (exitCode: number) => void): () => void;
}

declare global {
  interface Window {
    pi: PiAPI;
  }
}

export {};
