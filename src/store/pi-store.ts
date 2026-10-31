import { create } from 'zustand';
import { sameSession } from '../types/session';
import type {
  BackgroundTaskSnapshotList,
  ClassifierApprovalVerdict,
  SessionSlotSnapshot
} from '../types/pi';
import { applyTheme } from '../theme/applyTheme';
import type { PendingFileRequest } from '../types/shared';
// 流式消息不进 store：逐 token 写入会通知所有订阅者（见 lib/streaming-message.ts）
import { setStreamingMessage } from '../lib/streaming-message';
import { scheduleSessionRefresh } from '../lib/session-refresh';
import { isExtendedMonacoThemeId, type ExtendedMonacoThemeId } from '../lib/monaco-themes';
import {
  DEFAULT_SHORTCUTS,
  isShortcutActionId,
  resolveShortcutMap,
  type ShortcutMap
} from '../lib/shortcuts';
import type { SettingsTabKey } from '../components/settings/settings-nav';
import {
  DEFAULT_COLOR_MODE,
  DEFAULT_THEME_FAMILY,
  isColorMode,
  isThemeFamilyId,
  type ColorMode
} from '../theme/themes';

/** Goal 模式状态快照（与 src/types/pi.d.ts 的 GoalSnapshot 一致） */
export interface GoalEvent {
  goalMessageTimestamp: number;
  completedMessageTimestamp?: number;
  completedTimeUsed?: number;
  status: string;
}

export interface GoalSnapshot {
  goal: {
    id: string;
    text: string;
    status: 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';
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

/** Plan 模式阶段(与 src/types/pi.d.ts 的 PlanPhase 一致) */
export type PlanPhase = 'idle' | 'planning' | 'executing';

/** Subagent 快照(与 src/types/pi.d.ts 的 SubagentSnapshot 一致) */
export interface SubagentRunState {
  id: string;
  name: string;
  agent: string;
  task: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'stopped';
  output?: string;
  error?: string;
  outputSource?: 'submit' | 'fallback';
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
  toolCalls?: SubagentToolCallState[];
  /** 对话流(详情视图「对话」Tab;运行中实时采集,重启后为空) */
  transcript?: SubagentTranscriptItem[];
  /** 子 agent 会话文件路径(独立目录 subagent-sessions/;终态/重启后回放对话用) */
  sessionFile?: string;
}

/** 子 agent 会话文件回放的对话数据(window.pi.subagents.getSession) */
export interface SubagentConversationState {
  transcript: SubagentTranscriptItem[];
  toolCalls: SubagentToolCallState[];
}

/**
 * 子 agent 对话流条目(与 electron/subagents/types.ts 的 ChildTranscriptItem 一致)。
 * 工具条目只存 id,参数/结果由 toolCalls 提供。
 */
export type SubagentTranscriptItem =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | { kind: 'tool'; at: number; toolCallId: string }
  | { kind: 'stream'; at: number; text: string; thinking: string; toolCallIds: string[] };

/** 子 agent 工具调用记录(与 pi.d.ts 的 SubagentToolCall 一致) */
export interface SubagentToolCallState {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  pending?: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentSnapshot {
  runs: SubagentRunState[];
  agents: Array<{
    name: string;
    description: string;
    source: 'builtin' | 'user' | 'project';
    tools?: string[];
  }>;
}

/** Plan 状态快照(与 src/types/pi.d.ts 的 PlanSnapshot 一致) */
export interface PlanSnapshot {
  phase: PlanPhase;
  pendingProposal: PendingProposal | null;
  lastApprovedPlan: string | null;
}

export interface PendingProposal {
  id: string;
  content: string;
  variant: number;
  summary?: string;
  createdAt: number;
}

export type AgentMode = 'standard' | 'plan' | 'goal';

/** 权限沙箱策略（与 electron/permission/policy.ts 同构；经 ui-config.json 持久化） */
export type PermissionPolicy = 'ask-all' | 'auto-safe' | 'classifier-auto' | 'allow-all';

/**
 * 模型回复期间发送消息的默认投递方式（经 ui-config.json 持久化）：
 * - 'steer'：引导消息，当前轮工具调用结束后、下一次 LLM 调用前注入
 * - 'followUp'：排队消息，agent 本来要停下来时才作为新一轮发出
 */
export type PendingSendMode = 'steer' | 'followUp';

/** 主进程推送的审批请求 */
export interface PermissionRequest {
  id: string;
  toolName: string;
  preview: string;
  requestedAt: number;
  /** 危险命令检测结果（命中 denylist 时非空） */
  danger?: DangerousBashCheck;
  /** classifier-auto 策略下的决策模型判定（ok=false 表示已回退人工审批） */
  classifier?: ClassifierApprovalVerdict;
}

/** 危险命令检测结果（与 electron/permission/policy.ts 同构） */
export interface DangerousBashCheck {
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

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

/** ask 工具的问题结构（与 pi.d.ts 中 AskQuestion 一致） */
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

/** ask 工具的用户回答 */
export interface AskAnswer {
  questionId: string;
  selectedLabels: string[];
  customInput?: string;
}

/** 会话可用的命令（来自 extension/prompt/skill，由 getCommands 返回） */
export interface CommandInfo {
  name: string;
  description: string;
  source: 'extension' | 'prompt' | 'skill';
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
}

export interface ToolExecutionState {
  toolCallId: string;
  toolName: string;
  args: any;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: any;
  isError?: boolean;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export interface SessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextPercent: number;
}

/** 全局 Toast 提示 */
export type ToastVariant = 'info' | 'error' | 'success' | 'warning';
export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  /** 自动关闭毫秒数，0 表示不自动关闭 */
  duration: number;
}

export interface PiState {
  // Messages
  messages: any[];

  // Toast（全局轻提示，自动消失，可手动关闭）
  toasts: ToastItem[];
  showToast: (message: string, opts?: { variant?: ToastVariant; duration?: number }) => void;
  dismissToast: (id: number) => void;

  // Streaming state
  isStreaming: boolean;
  /** 流式输出速率（token/s），0 表示无流或样本不足；仅在流式窗口内有效，由事件层写入 */
  streamRate: number;
  /** agent_start 时打点（Date.now()），agent_settled 清零；
      供「助手 回答中…」状态行显示本轮回复耗时（从点击发送到现在）。 */
  replyStartedAt: number | null;
  isCompacting: boolean;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage: string } | null;

  // Agent mode
  mode: AgentMode;

  // Queue
  queue: QueueState;

  // Model
  model: any | null;
  thinkingLevel: string;
  availableModels: any[];

  // Session
  sessionId: string | null;
  sessionRevision: number | null;
  sessionLoadVersion: number;
  isSessionLoading: boolean;
  sessionFile: string | null;
  /**
   * 所有会话槽的状态投影（主进程 sessionSlots()）：侧栏据此显示「后台运行中/未读/等待审批」。
   * 只含标量，不含聊天内容——后台槽不推消息（见 lib/streaming-message.ts 的按会话分键）。
   */
  sessionSlots: SessionSlotSnapshot[];
  cwd: string;
  sessionName: string | null;
  /** 当前会话标题文本（name 或 firstMessage 摘要），切换会话时由侧栏写入，避免标题区再扫盘 */
  sessionLabel: string | null;
  // Commands / skills (refreshed on session switch)
  commands: CommandInfo[];

  // Stats
  stats: SessionStats | null;

  // Tool executions (keyed by toolCallId)
  toolExecutions: Record<string, ToolExecutionState>;

  // UI state
  rightPanelOpen: boolean;
  /** 右侧工作区占满聊天区域（左侧会话栏保持原状态） */
  rightPanelMaximized: boolean;
  activeTab: string | null;
  pendingFile: PendingFileRequest | null;
  /**
   * 「会话正在运行」停止执行确认框（切换/新建会话、fork、切换项目、退出前统一走这里）。
   * null = 不显示。由 src/lib/stopRunningConfirm.ts 驱动，App 根挂载唯一实例 StopRunningConfirm。
   */
  stopRunningConfirm: { title: string; message: string; confirmText: string } | null;
  setStopRunningConfirm: (
    v: { title: string; message: string; confirmText: string } | null
  ) => void;
  /** 待审核记忆候选数（记忆按钮角标；由 refreshMemoryPendingReviews 刷新） */
  memoryPendingReviews: number;
  refreshMemoryPendingReviews: () => Promise<void>;
  settingsOpen: boolean;
  /** 打开设置页时要定位的 tab（深链；消费后由 SettingsPage 清空，不持久化） */
  settingsTab: SettingsTabKey | null;
  setSettingsTab: (v: SettingsTabKey | null) => void;
  sidebarOpen: boolean;
  /** 会话树全屏面板打开（标题栏按钮隐藏用） */
  treeViewOpen: boolean;
  // 会话结构变更版本号（fork/newSession/navigateTree 等后递增，触发列表/树刷新）
  sessionVersion: number;
  /** git 分支变更版本号：任一 GitBranchButton 切换分支成功后递增，
   * 所有实例订阅重新探测，保证状态栏与聊天区两处按钮展示同步 */
  gitBranchVersion: number;

  // UI preferences (persisted)
  /** 主题族 id（atom-one / vscode / github /...） */
  themeFamily: string;
  /** 明暗颜色模式：system 随系统，dark/light 强制 */
  colorMode: ColorMode;
  fontSize: number;
  uiFontFamily: string;
  /** 毛玻璃半透明：标题栏/侧栏/状态栏透出窗口原生材质（false = 铺不透明底色） */
  translucentPanels: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  browserEnabled: boolean;
  browserDevtoolsEnabled: boolean;
  // 终端面板
  terminalPanelOpen: boolean;
  terminalPanelHeight: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  /** 终端默认运行的 shell（留空 = 平台自动探测） */
  terminalShell: string;
  // 编辑器（Monaco）偏好
  /** 编辑器主题：'auto' = 跟随应用明暗，否则为内置主题名 */
  monacoTheme: MonacoThemeChoice;
  /** 编辑器字体族（空 = Monaco 内置默认） */
  monacoFontFamily: string;
  monacoFontSize: number;
  /** 行高（0 = 自动；1~8 为字号倍数；>=8 为像素） */
  monacoLineHeight: number;
  /** Tab 宽度（空格数） */
  monacoTabSize: number;
  monacoLigatures: boolean;
  monacoWordWrap: boolean;
  monacoMinimap: boolean;
  monacoLineNumbers: boolean;
  monacoStickyScroll: boolean;
  monacoIndentGuides: boolean;
  // 聊天区书签指示器
  showBookmarks: boolean;
  /** 显示模型思考块（false = 对话中隐藏 thinking block） */
  showThinkingBlocks: boolean;
  /** 连续工具活动默认收起为摘要 */
  collapseToolCalls: boolean;
  /** 同项目已有其他会话在跑时，输入框是否弹提醒蒙层 */
  sameProjectBusyWarn: boolean;
  /** 模型回复期间发送消息的默认方式（Enter / 发送按钮），Alt+Enter 走另一种 */
  streamingSendMode: PendingSendMode;
  /** 通知总开关（false 一律不发） */
  notifyEnabled: boolean;
  /** 通知时机：always 总是 / unfocused 仅窗口失焦 / never 从不 */
  notifyMode: 'always' | 'unfocused' | 'never';
  /** 对话轮次完成（模型回复结束）时通知 */
  notifyOnTurnEnd: boolean;
  /** ask 工具提问等待回答时通知 */
  notifyOnAsk: boolean;
  // TODO 面板
  todoPanelOpen: boolean;
  todoPanelWidth: number;
  todoPhases: TodoPhase[];
  // Ask 用户提问
  askQuestions: AskQuestion[] | null;
  /** 挂起提问所属会话（回传答案时告诉主进程是哪个会话的提问） */
  askSessionId: string | null;
  // 权限沙箱策略 + 挂起的审批请求（来自主进程 pi:permissionRequest）
  permissionPolicy: PermissionPolicy;
  pendingPermissionRequest: PermissionRequest | null;
  setPendingPermissionRequest: (r: PermissionRequest | null) => void;
  // 本会话内已「本次会话允许」的工具名（内存态，与主进程同步；切换会话清空）
  sessionAllowedTools: string[];
  setSessionAllowedTools: (tools: string[]) => void;
  // MCP 状态弹窗
  mcpStatusOpen: boolean;
  // Goal 模式状态快照（来自主进程 pi:goalUpdate）
  goalSnapshot: GoalSnapshot | null;
  // Subagent 系统快照（来自主进程 pi:subagentUpdate）
  subagentSnapshot: SubagentSnapshot | null;
  // 后台 shell 任务快照（来自主进程 pi:backgroundTaskUpdate）
  backgroundTaskSnapshot: BackgroundTaskSnapshotList | null;
  setBackgroundTaskSnapshot: (s: BackgroundTaskSnapshotList | null) => void;
  // Subagent 进度面板开关
  // Goal 编辑弹窗
  goalEditDialogOpen: boolean;
  setGoalEditDialogOpen: (v: boolean) => void;
  // Plan 模式状态快照(来自主进程 pi:planUpdate / window.pi.plan.get)
  planPhase: PlanPhase;
  planPendingProposal: PendingProposal | null;
  planLastApproved: string | null;
  setPlanSnapshot: (s: PlanSnapshot) => void;
  setPlanPendingProposal: (p: PendingProposal | null) => void;
  // Goal 创建/编辑弹窗

  // Actions
  setStreaming: (v: boolean) => void;
  /** 节流写入，仅在变化 >=0.1 时触发 set（事件层 token-rate tracker 调用） */
  setStreamRate: (v: number) => void;
  setReplyStartedAt: (t: number | null) => void;
  setCompacting: (v: boolean) => void;
  setRetry: (info: any | null) => void;
  setMode: (m: AgentMode) => void;
  setQueue: (q: QueueState) => void;
  setModel: (m: any) => void;
  setThinkingLevel: (l: string) => void;
  setAvailableModels: (m: any[]) => void;
  setSessionInfo: (info: any) => void;
  /** 更新会话槽状态投影（推送/主动拉取共用） */
  setSessionSlots: (slots: SessionSlotSnapshot[]) => void;
  setSessionLabel: (label: string | null) => void;
  setStats: (s: SessionStats | null) => void;
  /** 先清空 stats，再异步拉取当前会话的 token 用量（切换/新建/fork/导航会话后调用） */
  refreshStats: () => void;
  setCommands: (c: CommandInfo[]) => void;
  setRightPanelOpen: (v: boolean) => void;
  setRightPanelMaximized: (v: boolean) => void;
  setActiveTab: (id: string | null) => void;
  setPendingFile: (f: PendingFileRequest | null) => void;
  setSettingsOpen: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  setTreeViewOpen: (v: boolean) => void;
  setThemeFamily: (id: string) => void;
  setColorMode: (m: ColorMode) => void;
  /** 毛玻璃半透明开关（持久化到 ui-config.json，仅影响渲染层，不改窗口材质） */
  setTranslucentPanels: (v: boolean) => void;
  bumpSessionVersion: () => void;
  bumpGitBranchVersion: () => void;
  setFontSize: (n: number) => void;
  setUiFontFamily: (s: string) => void;
  setSidebarWidth: (n: number) => void;
  setRightPanelWidth: (n: number) => void;
  setBrowserEnabled: (v: boolean) => void;
  setBrowserDevtoolsEnabled: (v: boolean) => void;
  setTerminalPanelOpen: (v: boolean) => void;
  setTerminalPanelHeight: (n: number) => void;
  setTerminalFontFamily: (s: string) => void;
  setTerminalFontSize: (n: number) => void;
  setTerminalShell: (s: string) => void;
  // 编辑器（Monaco）偏好 setter
  setMonacoTheme: (v: MonacoThemeChoice) => void;
  setMonacoFontFamily: (s: string) => void;
  setMonacoFontSize: (n: number) => void;
  setMonacoLineHeight: (n: number) => void;
  setMonacoTabSize: (n: number) => void;
  setMonacoLigatures: (v: boolean) => void;
  setMonacoWordWrap: (v: boolean) => void;
  setMonacoMinimap: (v: boolean) => void;
  setMonacoLineNumbers: (v: boolean) => void;
  setMonacoStickyScroll: (v: boolean) => void;
  setMonacoIndentGuides: (v: boolean) => void;
  /** 聊天区书签指示器开关（持久化到 ui-config.json） */
  setShowBookmarks: (v: boolean) => void;
  setShowThinkingBlocks: (v: boolean) => void;
  setCollapseToolCalls: (v: boolean) => void;
  /** 同项目并发提醒开关（持久化到 ui-config.json） */
  setSameProjectBusyWarn: (v: boolean) => void;
  /** 设置模型回复期间消息的默认投递方式（持久化到 ui-config.json） */
  setStreamingSendMode: (m: PendingSendMode) => void;
  setNotifyEnabled: (v: boolean) => void;
  setNotifyMode: (v: 'always' | 'unfocused' | 'never') => void;
  setNotifyOnTurnEnd: (v: boolean) => void;
  setNotifyOnAsk: (v: boolean) => void;
  setTodoPanelOpen: (v: boolean) => void;
  setTodoPanelWidth: (n: number) => void;
  setTodoPhases: (phases: TodoPhase[]) => void;
  setAskQuestions: (q: AskQuestion[] | null, sessionId?: string | null) => void;
  /** 切换权限沙箱策略（持久化 + 同步主进程闸门，立即生效） */
  setPermissionPolicy: (p: PermissionPolicy) => void;
  /** 注入聊天输入框文本（设置页“创建技能”等场景使用，ChatInput 消费后清空） */
  pendingChatInput: string | null;
  setPendingChatInput: (v: string | null) => void;
  setMcpStatusOpen: (v: boolean) => void;
  // === 键盘快捷键 ===
  /** 动作 id → 绑定串（空串 = 未分配）；持久化到 ui-config.json 的 shortcuts */
  shortcuts: ShortcutMap;
  /** 数字快捷键（Mod+1..9）的用途：切换右侧工作区标签 / 关闭 */
  shortcutNumberKeys: 'workspace' | 'off';
  /** 正在改键的动作 id：非空时全局快捷键监听让路，由设置页捕获按键 */
  shortcutCaptureId: string | null;
  /** 会话搜索弹窗开关（侧栏按钮与快捷键共用） */
  sessionSearchOpen: boolean;
  setSessionSearchOpen: (v: boolean) => void;
  setShortcutCaptureId: (id: string | null) => void;
  /** 改绑单个动作；传空串 = 未分配 */
  setShortcut: (id: string, binding: string) => void;
  /** 单个动作恢复默认值 */
  resetShortcut: (id: string) => void;
  /** 全部动作恢复默认值 */
  resetAllShortcuts: () => void;
  setShortcutNumberKeys: (v: 'workspace' | 'off') => void;
  setGoalSnapshot: (s: GoalSnapshot | null) => void;
  setSubagentSnapshot: (s: SubagentSnapshot | null) => void;
  addMessage: (msg: any) => void;
  setMessages: (msgs: any[]) => void;
  updateToolExecution: (id: string, update: Partial<ToolExecutionState>) => void;
  /** 从 messages 重建 toolExecutions（切会话/加载历史时调用） */
  rebuildToolExecutions: (messages: any[]) => void;
  reset: () => void;
}

// UI preference constants + ui-config.json helpers
//
// UI 偏好持久化到 ~/.pi-desktop/ui-config.json（经 window.pi.getUiSettings / setUiSettings IPC），
// 不再使用 localStorage。store 初始化时用默认值（避免启动闪烁），
// App 挂载后调用 loadUiSettings() 异步拉取真实值覆盖。
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 999; // 不限制上限，仅作为 clamp 上界防止异常值
export const FONT_SIZE_DEFAULT = 14;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const RIGHT_PANEL_WIDTH_MIN = 360;
export const RIGHT_PANEL_WIDTH_MAX = 1200;
export const RIGHT_PANEL_WIDTH_DEFAULT = 560;

export const TERMINAL_PANEL_HEIGHT_MIN = 100;
export const TERMINAL_PANEL_HEIGHT_MAX = 1200;
export const TERMINAL_PANEL_HEIGHT_DEFAULT = 260;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 48;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_FAMILY_DEFAULT = "Menlo, Monaco, 'Courier New', monospace";
// 终端默认 shell 占位：留空表示走平台自动探测（win => powershell/cmd，其余 => $SHELL 或 /bin/zsh）
export const TERMINAL_SHELL_DEFAULT = '';
// 整体界面默认字体：等宽字体优先，中文回退到苹方/微软雅黑等系统字体（与 src/index.css 中 --ui-font 的默认值保持一致）
export const UI_FONT_FAMILY_DEFAULT =
  "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Menlo', 'PingFang SC', 'Microsoft YaHei', '微软雅黑', 'Noto Sans CJK SC', monospace";

export const TODO_PANEL_WIDTH_MIN = 220;
export const TODO_PANEL_WIDTH_MAX = 600;
export const TODO_PANEL_WIDTH_DEFAULT = 300;

// 编辑器（Monaco）偏好：设置页「编辑器」section + src/lib/monaco-options.ts 消费
/** 编辑器字号范围（px） */
export const MONACO_FONT_SIZE_MIN = 8;
export const MONACO_FONT_SIZE_MAX = 48;
export const MONACO_FONT_SIZE_DEFAULT = 13;
/** 空串 = 不传 fontFamily，走 Monaco 内置默认（跨平台自适应，不硬编码字体名） */
export const MONACO_FONT_FAMILY_DEFAULT = '';
/**
 * 行高：0 = 按字号自动；否则为「字号倍数」（Monaco 把 1~8 解释为倍数、>=8 为像素）。
 * 对外只暴露倍数区间：像素区间写进同一个输入框会产生「填 4 结果是 4 倍还是 4px」
 * 的歧义；而倍数是随字号自动缩放的那个。小于 1 会让行重叠，收敛到 1。
 */
export const MONACO_LINE_HEIGHT_MIN = 0;
export const MONACO_LINE_HEIGHT_MAX = 3;
export const MONACO_LINE_HEIGHT_DEFAULT = 0;
/** Tab 宽度（空格数） */
export const MONACO_TAB_SIZE_MIN = 1;
export const MONACO_TAB_SIZE_MAX = 8;
export const MONACO_TAB_SIZE_DEFAULT = 4;

/**
 * 编辑器主题：'auto' = 跟随应用明暗（深色 vs-dark / 浅色 vs），
 * 其余为 Monaco 内置主题名或 monaco-themes 扩展主题 id（见 src/lib/monaco-themes.ts）
 */
export type BuiltinMonacoThemeChoice = 'auto' | 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
export type MonacoThemeChoice = BuiltinMonacoThemeChoice | ExtendedMonacoThemeId;
export const MONACO_THEME_DEFAULT: MonacoThemeChoice = 'auto';

/** 应用内置主题（不含扩展主题），设置页下拉框的第一组 */
export const MONACO_BUILTIN_THEME_CHOICES: readonly BuiltinMonacoThemeChoice[] = [
  'auto',
  'vs',
  'vs-dark',
  'hc-black',
  'hc-light'
];

export function isMonacoThemeChoice(v: unknown): v is MonacoThemeChoice {
  if (typeof v !== 'string') return false;
  return (
    (MONACO_BUILTIN_THEME_CHOICES as readonly string[]).includes(v) || isExtendedMonacoThemeId(v)
  );
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** 行高归一化：保留一位小数，0 = 自动，非零值不低于 1（见 MONACO_LINE_HEIGHT_MIN 注释） */
function normalizeMonacoLineHeight(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  const v = rounded > 0 && rounded < 1 ? 1 : rounded;
  return clamp(v, MONACO_LINE_HEIGHT_MIN, MONACO_LINE_HEIGHT_MAX);
}

/** ui-config.json 支持的 UI 设置字段（与 src/types/pi.d.ts 的 UiSettings 一致） */
export interface UiSettings {
  themeFamily?: string;
  colorMode?: ColorMode;
  fontSize?: number;
  uiFontFamily?: string;
  translucentPanels?: boolean;
  sidebarWidth?: number;
  /** 旧字段，仅用于迁移 */
  codePanelWidth?: number;
  rightPanelWidth?: number;
  browserEnabled?: boolean;
  browserDevtoolsEnabled?: boolean;
  terminalPanelHeight?: number;
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalShell?: string;
  // 编辑器（Monaco）偏好
  monacoTheme?: MonacoThemeChoice;
  monacoFontFamily?: string;
  monacoFontSize?: number;
  monacoLineHeight?: number;
  monacoTabSize?: number;
  monacoLigatures?: boolean;
  monacoWordWrap?: boolean;
  monacoMinimap?: boolean;
  monacoLineNumbers?: boolean;
  monacoStickyScroll?: boolean;
  monacoIndentGuides?: boolean;
  todoPanelWidth?: number;
  mode?: AgentMode;
  fileTreeWidth?: number;
  showBookmarks?: boolean;
  showThinkingBlocks?: boolean;
  collapseToolCalls?: boolean;
  sameProjectBusyWarn?: boolean;
  streamingSendMode?: PendingSendMode;
  // 通知设置（主进程 readNotifyConfig 读同一份文件裁决是否发送）
  notifyEnabled?: boolean;
  notifyMode?: 'always' | 'unfocused' | 'never';
  notifyOnTurnEnd?: boolean;
  notifyOnAsk?: boolean;
  // 权限沙箱策略（主进程 PermissionController 读同一份文件恢复）
  permissionPolicy?: PermissionPolicy;
  /** 键盘快捷键：动作 id → 绑定串（空串 = 未分配；缺失的动作走默认值） */
  shortcuts?: ShortcutMap;
  /** 数字快捷键（Mod+1..9）的用途：切换右侧工作区标签 / 关闭 */
  shortcutNumberKeys?: 'workspace' | 'off';
}

/** 数值字段的 clamp 边界，key 为 ui-config.json 字段名（不写显式类型，让 keyof 推断为字面量键集） */
const SETTING_RANGES = {
  fontSize: { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX },
  sidebarWidth: { min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX },
  rightPanelWidth: { min: RIGHT_PANEL_WIDTH_MIN, max: RIGHT_PANEL_WIDTH_MAX },
  terminalPanelHeight: { min: TERMINAL_PANEL_HEIGHT_MIN, max: TERMINAL_PANEL_HEIGHT_MAX },
  terminalFontSize: { min: TERMINAL_FONT_SIZE_MIN, max: TERMINAL_FONT_SIZE_MAX },
  monacoFontSize: { min: MONACO_FONT_SIZE_MIN, max: MONACO_FONT_SIZE_MAX },
  monacoTabSize: { min: MONACO_TAB_SIZE_MIN, max: MONACO_TAB_SIZE_MAX },
  todoPanelWidth: { min: TODO_PANEL_WIDTH_MIN, max: TODO_PANEL_WIDTH_MAX }
};

/** 字符串字段的白名单（不存在时用默认值） */
const SETTING_STRING_KEYS = {
  uiFontFamily: UI_FONT_FAMILY_DEFAULT,
  terminalFontFamily: TERMINAL_FONT_FAMILY_DEFAULT,
  terminalShell: TERMINAL_SHELL_DEFAULT,
  monacoFontFamily: MONACO_FONT_FAMILY_DEFAULT
};

function saveSetting(key: keyof UiSettings, value: number | string | boolean) {
  if (typeof window === 'undefined' || !window.pi?.setUiSettings) return;
  window.pi.setUiSettings({ [key]: value }).catch(() => {});
}

/** 写入非标量字段（对象/数组，如快捷键表）：整份替换，主进程侧是浅合并 */
function saveSettings(patch: Record<string, unknown>) {
  if (typeof window === 'undefined' || !window.pi?.setUiSettings) return;
  // 这里的 patch 只用于对象字段（目前只有 shortcuts），宽类型到具体 UiSettings 需要一次转换
  window.pi.setUiSettings(patch as Parameters<typeof window.pi.setUiSettings>[0]).catch(() => {});
}

/**
 * 从 ~/.pi-desktop/ui-config.json 加载 UI 偏好并覆盖 store（App 挂载后调用一次）。
 * 数值 clamp 到合法区间、字符串校验类型，非法字段忽略。
 */
export async function loadUiSettings(): Promise<void> {
  try {
    const ui = await window.pi.getUiSettings();
    if (!ui || typeof ui !== 'object') return;
    const patch = normalizeUiSettings(ui);
    usePiStore.setState(patch);
    // plan 模式由 App init 末尾统一同步（setMode 内部调 setPlanMode），
    // 这里不重复调用，避免双重 setPlanMode
  } catch {
    // 读失败时保持默认值
  }
}

export function normalizeUiSettings(ui: UiSettings): Partial<UiSettings> {
  const patch: Partial<UiSettings> = {};
  for (const [field, value] of Object.entries(ui)) {
    // 行高单独处理：通用区间 clamp 表达不了「0 或 >=1」这条规则
    if (field === 'monacoLineHeight' && typeof value === 'number' && Number.isFinite(value)) {
      patch.monacoLineHeight = normalizeMonacoLineHeight(value);
      continue;
    }
    const range = SETTING_RANGES[field as keyof typeof SETTING_RANGES];
    if (range && typeof value === 'number' && Number.isFinite(value)) {
      patch[field as keyof typeof SETTING_RANGES] = clamp(value, range.min, range.max);
      continue;
    }
    if (field in SETTING_STRING_KEYS && typeof value === 'string') {
      patch[field as keyof typeof SETTING_STRING_KEYS] = value;
      continue;
    }
    if (field === 'mode' && (value === 'plan' || value === 'goal' || value === 'standard')) {
      patch.mode = value;
      continue;
    }
    if (
      field === 'permissionPolicy' &&
      (value === 'ask-all' ||
        value === 'auto-safe' ||
        value === 'classifier-auto' ||
        value === 'allow-all')
    ) {
      patch.permissionPolicy = value;
      continue;
    }
    if (field === 'fileTreeWidth' && typeof value === 'number' && Number.isFinite(value)) {
      patch.fileTreeWidth = Math.max(80, value);
    }
    if (field === 'translucentPanels' && typeof value === 'boolean')
      patch.translucentPanels = value;
    if (field === 'showBookmarks' && typeof value === 'boolean') patch.showBookmarks = value;
    if (field === 'showThinkingBlocks' && typeof value === 'boolean')
      patch.showThinkingBlocks = value;
    if (field === 'collapseToolCalls' && typeof value === 'boolean')
      patch.collapseToolCalls = value;
    if (field === 'sameProjectBusyWarn' && typeof value === 'boolean')
      patch.sameProjectBusyWarn = value;
    if (field === 'streamingSendMode' && (value === 'steer' || value === 'followUp')) {
      patch.streamingSendMode = value;
    }
    if (field === 'browserEnabled' && typeof value === 'boolean') patch.browserEnabled = value;
    if (field === 'browserDevtoolsEnabled' && typeof value === 'boolean')
      patch.browserDevtoolsEnabled = value;
    if (field === 'notifyEnabled' && typeof value === 'boolean') patch.notifyEnabled = value;
    if (
      field === 'notifyMode' &&
      (value === 'always' || value === 'unfocused' || value === 'never')
    ) {
      patch.notifyMode = value;
    }
    if (field === 'notifyOnTurnEnd' && typeof value === 'boolean') patch.notifyOnTurnEnd = value;
    if (field === 'notifyOnAsk' && typeof value === 'boolean') patch.notifyOnAsk = value;
    // 快捷键表：只认对象；逐动作校验（缺失补默认、空串保持未分配、非法回退默认）
    if (field === 'shortcuts' && value && typeof value === 'object' && !Array.isArray(value)) {
      patch.shortcuts = resolveShortcutMap(value);
      continue;
    }
    if (field === 'shortcutNumberKeys' && (value === 'workspace' || value === 'off')) {
      patch.shortcutNumberKeys = value;
      continue;
    }
    // 编辑器（Monaco）：布尔开关 + 主题枚举。漏掉这些分支会静默丢弃磁盘值、
    // 每次启动回退默认值（AGENTS.md 明确提醒过）
    if (field === 'monacoLigatures' && typeof value === 'boolean') patch.monacoLigatures = value;
    if (field === 'monacoWordWrap' && typeof value === 'boolean') patch.monacoWordWrap = value;
    if (field === 'monacoMinimap' && typeof value === 'boolean') patch.monacoMinimap = value;
    if (field === 'monacoLineNumbers' && typeof value === 'boolean')
      patch.monacoLineNumbers = value;
    if (field === 'monacoStickyScroll' && typeof value === 'boolean')
      patch.monacoStickyScroll = value;
    if (field === 'monacoIndentGuides' && typeof value === 'boolean')
      patch.monacoIndentGuides = value;
    if (field === 'monacoTheme' && isMonacoThemeChoice(value)) patch.monacoTheme = value;
    if (field === 'themeFamily' && isThemeFamilyId(value)) patch.themeFamily = value;
    if (field === 'colorMode' && isColorMode(value)) patch.colorMode = value;
  }
  if (
    patch.rightPanelWidth === undefined &&
    typeof ui.codePanelWidth === 'number' &&
    Number.isFinite(ui.codePanelWidth)
  ) {
    patch.rightPanelWidth = clamp(ui.codePanelWidth, RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX);
  }
  return patch;
}

const initialState = {
  messages: [],
  toasts: [],
  isStreaming: false,
  streamRate: 0,
  replyStartedAt: null,
  isCompacting: false,
  retryInfo: null,
  // 启动时先用默认值，App 挂载后 loadUiSettings() 从 ~/.pi-desktop/ui-config.json 异步覆盖
  mode: 'standard' as AgentMode,
  queue: { steering: [], followUp: [] },
  model: null,
  // 与 SDK 的 DEFAULT_THINKING_LEVEL 对齐，避免启动时 UI(store='off') 和 SDK(state='medium') desync
  thinkingLevel: 'medium',
  availableModels: [],
  sessionId: null,
  sessionRevision: null,
  sessionLoadVersion: 0,
  isSessionLoading: true,
  sessionFile: null,
  sessionSlots: [],
  cwd: '',
  sessionName: null,
  sessionLabel: null,
  stats: null,
  commands: [],
  toolExecutions: {},
  backgroundTaskSnapshot: null,
  rightPanelOpen: false,
  rightPanelMaximized: false,
  activeTab: null,
  pendingFile: null,
  stopRunningConfirm: null,
  memoryPendingReviews: 0,
  settingsOpen: false,
  settingsTab: null,
  sidebarOpen: true,
  treeViewOpen: false,
  sessionVersion: 0,
  gitBranchVersion: 0,
  // 非持久化的瞬时 UI 状态
  shortcutCaptureId: null,
  sessionSearchOpen: false
};

const initialPreferences = {
  themeFamily: DEFAULT_THEME_FAMILY,
  colorMode: DEFAULT_COLOR_MODE,
  fontSize: FONT_SIZE_DEFAULT,
  uiFontFamily: UI_FONT_FAMILY_DEFAULT,
  // 默认保留毛玻璃：标题栏/侧栏/状态栏不铺底色，露出窗口原生材质
  translucentPanels: true,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  rightPanelWidth: RIGHT_PANEL_WIDTH_DEFAULT,
  browserEnabled: false,
  browserDevtoolsEnabled: false,
  terminalPanelOpen: false,
  terminalPanelHeight: TERMINAL_PANEL_HEIGHT_DEFAULT,
  terminalFontFamily: TERMINAL_FONT_FAMILY_DEFAULT,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalShell: TERMINAL_SHELL_DEFAULT,
  // 编辑器（Monaco）默认值：除小地图/自动换行外取 Monaco 原生默认，
  // 小地图与自动换行沿用改动前的硬编码行为（关 / 开）
  monacoTheme: MONACO_THEME_DEFAULT,
  monacoFontFamily: MONACO_FONT_FAMILY_DEFAULT,
  monacoFontSize: MONACO_FONT_SIZE_DEFAULT,
  monacoLineHeight: MONACO_LINE_HEIGHT_DEFAULT,
  monacoTabSize: MONACO_TAB_SIZE_DEFAULT,
  monacoLigatures: true,
  monacoWordWrap: true,
  monacoMinimap: false,
  monacoLineNumbers: true,
  monacoStickyScroll: false,
  monacoIndentGuides: true,
  showBookmarks: true,
  showThinkingBlocks: true,
  collapseToolCalls: true,
  // 同项目已有其他会话在跑时提醒一次（输入框蒙层，可在设置页关闭）
  sameProjectBusyWarn: true,
  // 保持既有行为：Enter 默认发送引导消息（排队消息走 Alt+Enter）
  streamingSendMode: 'steer' as PendingSendMode,
  // 通知设置（默认：开 / 仅窗口失焦时 / 轮次完成开 / 提问开）
  notifyEnabled: true,
  notifyMode: 'unfocused' as 'always' | 'unfocused' | 'never',
  notifyOnTurnEnd: true,
  notifyOnAsk: true,
  todoPanelOpen: false,
  todoPanelWidth: TODO_PANEL_WIDTH_DEFAULT,
  todoPhases: [],
  askQuestions: null,
  askSessionId: null,
  // 键盘快捷键：默认绑定 + 数字键默认切换右侧工作区标签（Mod+1..9）
  shortcuts: { ...DEFAULT_SHORTCUTS },
  shortcutNumberKeys: 'workspace' as 'workspace' | 'off',
  // 权限沙箱：默认自动审批安全指令（主进程侧同默认，loadUiSettings 后覆盖）
  permissionPolicy: 'auto-safe' as PermissionPolicy,
  pendingPermissionRequest: null,
  sessionAllowedTools: [],
  pendingChatInput: null,
  mcpStatusOpen: false,
  goalSnapshot: null,
  subagentSnapshot: null,
  goalEditDialogOpen: false,
  planPhase: 'idle' as PlanPhase,
  planPendingProposal: null,
  planLastApproved: null
};

export const usePiStore = create<PiState>((set, get) => ({
  ...initialState,
  ...initialPreferences,

  showToast: (message, opts) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const variant = opts?.variant ?? 'info';
    const duration = opts?.duration ?? 4000;
    set((s) => ({ toasts: [...s.toasts, { id, message, variant, duration }] }));
    if (duration > 0) {
      setTimeout(() => {
        usePiStore.getState().dismissToast(id);
      }, duration);
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((tt) => tt.id !== id) })),

  setStreaming: (v) => set({ isStreaming: v }),
  setStreamRate: (v) => {
    // 节流：高频 message_update 事件下避免每 delta 重渲染
    if (Math.abs(v - get().streamRate) >= 0.1 || (v === 0 && get().streamRate !== 0)) {
      set({ streamRate: v });
    }
  },
  setReplyStartedAt: (t) => set({ replyStartedAt: t }),
  setCompacting: (v) => set({ isCompacting: v }),
  setRetry: (info) => set({ retryInfo: info }),
  setMode: (m) => {
    saveSetting('mode', m);
    set({ mode: m });
    // plan 模式需要主进程裁剪工具集;goal/standard 恢复全部工具
    window.pi.setPlanMode(m === 'plan').catch(() => {});
  },
  setQueue: (q) => set({ queue: q }),
  setModel: (m) => set({ model: m }),
  setThinkingLevel: (l) => set({ thinkingLevel: l }),
  setAvailableModels: (m) => {
    set({ availableModels: m });
    // 当前模型为空、或不在新的可用模型列表中（如首次配 key、清除 key 后占位失效），
    // 自动选中第一个可用模型，避免切换区停留在未知/占位。
    if (m.length === 0) return;
    const cur = get().model;
    const curAvailable = !!cur && m.some((x) => x.provider === cur.provider && x.id === cur.id);
    if (curAvailable) return;
    const first = m[0];
    const source = get();
    window.pi
      .setModel(first.provider, first.id)
      .then((res) => {
        if (
          res?.model &&
          sameSession(get(), source) &&
          get().sessionLoadVersion === source.sessionLoadVersion
        ) {
          get().setModel(res.model);
          get().setThinkingLevel(res.thinkingLevel ?? 'off');
        }
      })
      .catch(() => {});
  },
  setSessionSlots: (slots) => set({ sessionSlots: slots }),
  setSessionInfo: (info) => {
    // 流式消息是模块级状态（见 lib/streaming-message.ts，避免逐 token 写 store 拖累所有订阅者），
    // 切会话时必须一并清空，否则旧会话的流式条会悬留在新会话底部。
    setStreamingMessage(null);
    set((s) => ({
      sessionId: info.sessionId,
      sessionRevision: info.sessionRevision,
      sessionFile: info.sessionFile,
      sessionName: info.sessionName ?? null,
      cwd: info.cwd,
      model: info.model,
      thinkingLevel: info.thinkingLevel,
      messages: info.messages || [],
      isStreaming: info.isStreaming ?? false,
      isCompacting: false,
      retryInfo: null,
      queue: { steering: [], followUp: [] },
      streamRate: 0,
      replyStartedAt: null,
      toolExecutions: {},
      stats: null,
      commands: [],
      goalSnapshot: null,
      planPhase: 'idle',
      planLastApproved: null,
      planPendingProposal: null,
      todoPhases: [],
      subagentSnapshot: null,
      askQuestions: null,
      askSessionId: null,
      pendingPermissionRequest: null,
      // 会话身份变更时清空「本次会话允许」状态（与主进程 clearPending 对齐；
      // 同一 sessionId 重拉（初始化/目录切换）不受影响）
      sessionAllowedTools: !sameSession(s, info) ? [] : s.sessionAllowedTools
    }));
  },
  setSessionLabel: (label: string | null) => set({ sessionLabel: label }),
  setStats: (s) => set({ stats: s }),
  refreshStats: () => {
    const source = get();
    if (source.sessionRevision === null) return;
    set({ stats: null });
    window.pi
      .getSessionStats()
      .then((s) => {
        if (
          s &&
          sameSession(get(), source) &&
          get().sessionLoadVersion === source.sessionLoadVersion
        ) {
          set({
            stats: {
              tokens: s.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: s.cost || 0,
              contextPercent: s.contextUsage?.percent || 0
            }
          });
        }
      })
      .catch(() => {});
  },
  setCommands: (c) => set({ commands: c }),
  setRightPanelOpen: (v) =>
    set(v ? { rightPanelOpen: true } : { rightPanelOpen: false, rightPanelMaximized: false }),
  setRightPanelMaximized: (v) => set({ rightPanelMaximized: v, rightPanelOpen: true }),
  setActiveTab: (id) => set({ activeTab: id }),
  setPendingFile: (f) => set({ pendingFile: f }),
  setStopRunningConfirm: (v) => set({ stopRunningConfirm: v }),
  refreshMemoryPendingReviews: async () => {
    try {
      const count = await window.pi.memory.pendingReviews();
      if (typeof count === 'number' && count !== get().memoryPendingReviews) {
        set({ memoryPendingReviews: count });
      }
    } catch {
      /* 记忆关闭或主进程忙：保持旧值 */
    }
  },
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettingsTab: (v) => set({ settingsTab: v }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTreeViewOpen: (v: boolean) => set({ treeViewOpen: v }),
  setThemeFamily: (id: string) => {
    if (!isThemeFamilyId(id)) return;
    saveSetting('themeFamily', id);
    applyTheme(id, get().colorMode);
    set({ themeFamily: id });
  },
  setColorMode: (m: ColorMode) => {
    if (!isColorMode(m)) return;
    saveSetting('colorMode', m);
    applyTheme(get().themeFamily, m);
    set({ colorMode: m });
  },
  setTranslucentPanels: (v: boolean) => {
    saveSetting('translucentPanels', v);
    set({ translucentPanels: v });
  },
  // 会话列表 / 标题 / 会话树的刷新走共享去抖：一次 run 结算只刷一次，
  // 而不是侧栏、标题栏、会话树各拉一次 IPC、各自重渲染
  bumpSessionVersion: () => {
    scheduleSessionRefresh();
    set((s) => ({ sessionVersion: s.sessionVersion + 1 }));
  },
  bumpGitBranchVersion: () => set((s) => ({ gitBranchVersion: s.gitBranchVersion + 1 })),
  setFontSize: (n) => {
    const v = clamp(Math.round(n), FONT_SIZE_MIN, FONT_SIZE_MAX);
    saveSetting('fontSize', v);
    set({ fontSize: v });
  },
  setUiFontFamily: (s) => {
    saveSetting('uiFontFamily', s);
    set({ uiFontFamily: s });
  },
  setSidebarWidth: (n) => {
    const v = clamp(Math.round(n), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
    saveSetting('sidebarWidth', v);
    set({ sidebarWidth: v });
  },
  setRightPanelWidth: (n) => {
    const v = clamp(Math.round(n), RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX);
    saveSetting('rightPanelWidth', v);
    set({ rightPanelWidth: v });
  },
  setBrowserEnabled: (v) => {
    set({ browserEnabled: v });
    window.pi.browser.setEnabled(v).catch(() => set({ browserEnabled: !v }));
  },
  setBrowserDevtoolsEnabled: (v) => {
    set({ browserDevtoolsEnabled: v });
    window.pi.browser.setDevtoolsEnabled(v).catch(() => set({ browserDevtoolsEnabled: !v }));
  },
  setTerminalPanelOpen: (v) => set({ terminalPanelOpen: v }),
  setTerminalPanelHeight: (n) => {
    const v = clamp(Math.round(n), TERMINAL_PANEL_HEIGHT_MIN, TERMINAL_PANEL_HEIGHT_MAX);
    saveSetting('terminalPanelHeight', v);
    set({ terminalPanelHeight: v });
  },
  setTerminalFontFamily: (s) => {
    saveSetting('terminalFontFamily', s);
    set({ terminalFontFamily: s });
  },
  setTerminalFontSize: (n) => {
    const v = clamp(Math.round(n), TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);
    saveSetting('terminalFontSize', v);
    set({ terminalFontSize: v });
  },
  setTerminalShell: (s) => {
    // 留空白表示自动探测；去首尾空白避免误填
    const v = s.trim();
    saveSetting('terminalShell', v);
    set({ terminalShell: v });
  },
  setMonacoTheme: (v) => {
    if (!isMonacoThemeChoice(v)) return;
    saveSetting('monacoTheme', v);
    set({ monacoTheme: v });
  },
  setMonacoFontFamily: (s) => {
    saveSetting('monacoFontFamily', s);
    set({ monacoFontFamily: s });
  },
  setMonacoFontSize: (n) => {
    const v = clamp(Math.round(n), MONACO_FONT_SIZE_MIN, MONACO_FONT_SIZE_MAX);
    saveSetting('monacoFontSize', v);
    set({ monacoFontSize: v });
  },
  setMonacoLineHeight: (n) => {
    const v = normalizeMonacoLineHeight(n);
    saveSetting('monacoLineHeight', v);
    set({ monacoLineHeight: v });
  },
  setMonacoTabSize: (n) => {
    const v = clamp(Math.round(n), MONACO_TAB_SIZE_MIN, MONACO_TAB_SIZE_MAX);
    saveSetting('monacoTabSize', v);
    set({ monacoTabSize: v });
  },
  setMonacoLigatures: (v) => {
    saveSetting('monacoLigatures', v);
    set({ monacoLigatures: v });
  },
  setMonacoWordWrap: (v) => {
    saveSetting('monacoWordWrap', v);
    set({ monacoWordWrap: v });
  },
  setMonacoMinimap: (v) => {
    saveSetting('monacoMinimap', v);
    set({ monacoMinimap: v });
  },
  setMonacoLineNumbers: (v) => {
    saveSetting('monacoLineNumbers', v);
    set({ monacoLineNumbers: v });
  },
  setMonacoStickyScroll: (v) => {
    saveSetting('monacoStickyScroll', v);
    set({ monacoStickyScroll: v });
  },
  setMonacoIndentGuides: (v) => {
    saveSetting('monacoIndentGuides', v);
    set({ monacoIndentGuides: v });
  },
  setShowBookmarks: (v) => {
    saveSetting('showBookmarks', v);
    set({ showBookmarks: v });
  },
  setShowThinkingBlocks: (v) => {
    saveSetting('showThinkingBlocks', v);
    set({ showThinkingBlocks: v });
  },
  setCollapseToolCalls: (v) => {
    saveSetting('collapseToolCalls', v);
    set({ collapseToolCalls: v });
  },
  setSameProjectBusyWarn: (v) => {
    saveSetting('sameProjectBusyWarn', v);
    set({ sameProjectBusyWarn: v });
  },
  setStreamingSendMode: (m) => {
    saveSetting('streamingSendMode', m);
    set({ streamingSendMode: m });
  },
  setNotifyEnabled: (v) => {
    saveSetting('notifyEnabled', v);
    set({ notifyEnabled: v });
  },
  setNotifyMode: (v) => {
    saveSetting('notifyMode', v);
    set({ notifyMode: v });
  },
  setNotifyOnTurnEnd: (v) => {
    saveSetting('notifyOnTurnEnd', v);
    set({ notifyOnTurnEnd: v });
  },
  setNotifyOnAsk: (v) => {
    saveSetting('notifyOnAsk', v);
    set({ notifyOnAsk: v });
  },
  setTodoPanelOpen: (v) => set({ todoPanelOpen: v }),
  setTodoPanelWidth: (n) => {
    const v = clamp(Math.round(n), TODO_PANEL_WIDTH_MIN, TODO_PANEL_WIDTH_MAX);
    saveSetting('todoPanelWidth', v);
    set({ todoPanelWidth: v });
  },
  setTodoPhases: (phases) => set({ todoPhases: phases }),
  setAskQuestions: (q, sessionId) =>
    set({ askQuestions: q, askSessionId: q ? (sessionId ?? null) : null }),
  setPendingPermissionRequest: (r) => set({ pendingPermissionRequest: r }),
  setSessionAllowedTools: (tools) => set({ sessionAllowedTools: tools }),
  setPermissionPolicy: (p) => {
    saveSetting('permissionPolicy', p);
    set({ permissionPolicy: p });
    // 同步主进程闸门（立即生效，含流式中的下一次工具调用）
    window.pi.setPermissionPolicy(p).catch(() => {});
  },
  setPendingChatInput: (v) => set({ pendingChatInput: v }),
  setMcpStatusOpen: (v) => set({ mcpStatusOpen: v }),
  // === 键盘快捷键 ===
  setSessionSearchOpen: (v) => set({ sessionSearchOpen: v }),
  setShortcutCaptureId: (id) => set({ shortcutCaptureId: id }),
  setShortcut: (id, binding) => {
    if (!isShortcutActionId(id)) return;
    const next: ShortcutMap = { ...get().shortcuts, [id]: binding };
    set({ shortcuts: next });
    saveSettings({ shortcuts: next });
  },
  resetShortcut: (id) => {
    if (!isShortcutActionId(id)) return;
    const next: ShortcutMap = { ...get().shortcuts, [id]: DEFAULT_SHORTCUTS[id] ?? '' };
    set({ shortcuts: next });
    saveSettings({ shortcuts: next });
  },
  resetAllShortcuts: () => {
    const next: ShortcutMap = { ...DEFAULT_SHORTCUTS };
    set({ shortcuts: next });
    saveSettings({ shortcuts: next });
  },
  setShortcutNumberKeys: (v) => {
    saveSetting('shortcutNumberKeys', v);
    set({ shortcutNumberKeys: v });
  },
  setGoalSnapshot: (s) => set({ goalSnapshot: s }),
  setSubagentSnapshot: (s) => set({ subagentSnapshot: s }),
  setBackgroundTaskSnapshot: (s) => set({ backgroundTaskSnapshot: s }),
  setGoalEditDialogOpen: (v) => set({ goalEditDialogOpen: v }),
  setPlanSnapshot: (s) =>
    set({
      planPhase: s.phase,
      planPendingProposal: s.pendingProposal,
      planLastApproved: s.lastApprovedPlan
    }),
  setPlanPendingProposal: (p) => set({ planPendingProposal: p }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setMessages: (msgs) => set({ messages: msgs }),
  updateToolExecution: (id, update) =>
    set((s) => ({
      toolExecutions: {
        ...s.toolExecutions,
        [id]: { ...s.toolExecutions[id], ...update }
      }
    })),
  rebuildToolExecutions: (messages) => {
    const execs: Record<string, ToolExecutionState> = {};
    for (const m of messages || []) {
      if (m && m.role === 'toolResult' && m.toolCallId) {
        execs[m.toolCallId] = {
          toolCallId: m.toolCallId,
          toolName: m.toolName || '',
          args: {},
          status: m.isError ? 'error' : 'success',
          result: { content: m.content, details: m.details },
          isError: !!m.isError
        };
      }
    }
    set({ toolExecutions: execs });
  },
  reset: () => set({ ...initialState })
}));
