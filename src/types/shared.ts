/**
 * 共享类型定义，集中管理，减少散落在各组件里的 interface
 */

/** 本机已安装的外部打开程序；图标由主进程读取，以 PNG data URL 传输。 */
export interface ExternalApp {
  id: string;
  name: string;
  icon?: string;
}

/** 自定义 provider 配置 */
export interface Provider {
  key: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  /**
   * 是否使用 Bearer 方式认证（Authorization: Bearer <apiKey>）。
   * 仅对 api === 'anthropic-messages' 生效：默认走 Anthropic 原生 x-api-key，
   * 勾选后改用 Bearer，适配 OpenAI 兼容代理转发 Anthropic 协议的场景。
   * SDK ProviderConfig.authHeader 透传，勾选时 SDK 注入 Bearer 头。
   */
  authHeader?: boolean;
  models: ProviderModel[];
}

/** 思考等级选项（SDK ModelThinkingLevel 中暴露给用户配置的子集） */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevelOption = (typeof THINKING_LEVELS)[number];

/**
 * 从 thinkingLevelMap 解析勾选状态。
 * SDK getSupportedThinkingLevels 语义：map[level] === null → 不支持；
 * xhigh/max 需显式映射（undefined → 不支持），其余等级缺省即支持。
 */
export function getSelectedThinkingLevels(m: {
  thinkingLevelMap?: Record<string, string | null>;
}): Set<string> {
  const map = m.thinkingLevelMap;
  if (!map) return new Set(THINKING_LEVELS.filter((l) => l !== 'xhigh' && l !== 'max'));
  return new Set(THINKING_LEVELS.filter((l) => map[l] !== null && map[l] !== undefined));
}

/** 由勾选状态构造 thinkingLevelMap（全量写：勾选 → identity 映射，未勾选 → null） */
export function buildThinkingLevelMap(selected: Set<string>): Record<string, string | null> {
  return Object.fromEntries(THINKING_LEVELS.map((l) => [l, selected.has(l) ? l : null])) as Record<
    string,
    string | null
  >;
}

export interface ProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  /**
   * 思考等级映射：勾选的等级 → 等级名（identity），未勾选 → null。
   * SDK 据此过滤模型选择器里可选的思考等级。
   */
  thinkingLevelMap?: Record<string, string | null>;
  /**
   * 该模型的默认思考等级：切换到此模型时自动应用（会 clamp 到支持的等级）。
   * SDK 不消费此字段，由主进程 pi:setModel handler 读取应用。
   */
  defaultThinkingLevel?: string;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, any>;
}

/** 思考格式选项（SDK thinkingFormat 枚举，对应不同的 reasoning 参数发送方式） */
export type ThinkingFormat =
  | 'openai' // reasoning_effort
  | 'deepseek' // thinking: {type} + reasoning_effort
  | 'zai' // thinking: {type}
  | 'qwen' // top-level enable_thinking
  | 'openrouter' // reasoning: {effort}
  | 'auto'; // 不写 compat，SDK 按 baseUrl 自动检测

export const THINKING_FORMAT_OPTIONS: { value: ThinkingFormat; label: string }[] = [
  { value: 'auto', label: '自动（SDK 检测）' },
  { value: 'openai', label: 'OpenAI（reasoning_effort）' },
  { value: 'deepseek', label: 'DeepSeek（thinking: {type}）' },
  { value: 'zai', label: 'Zai（thinking: {type}）' },
  { value: 'qwen', label: 'Qwen（enable_thinking）' },
  { value: 'openrouter', label: 'OpenRouter（reasoning: {effort}）' }
];

/** API 类型选项 */
export const API_OPTIONS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'openai-responses', label: 'OpenAI Responses' }
] as const;

/** 会话分组（SessionSidebar 用） */
export interface SessionGroup {
  cwd: string;
  /** 项目目录名（baseName(cwd)），用于会话列表展示，避免显示完整路径 */
  name: string;
  sessions: any[];
}

/** mention 候选项（ChatInput 用） */
export interface MentionItem {
  label: string;
  detail?: string;
  value: string;
}

/**
 * 一轮对话里被 agent 改动过的一个文件（聊天「本次改动」卡片 + 右侧审核面板用）。
 *
 * `patches` 是该文件在本轮内的全部 unified patch（按发生顺序），可能多于一个：
 * 同一个文件被连续 edit 多次时，每次 patch 都基于各自时刻的文件内容生成，不能简单拼接，
 * 需要时由 `src/lib/turn-diff.ts` 从当前文件内容倒序反向应用还原改动前内容。
 */
export interface TurnFileChange {
  /** 工具上报的路径（相对 cwd 或绝对路径），可直接交给 pi:readFile */
  path: string;
  patches: string[];
  additions: number;
  deletions: number;
  /** edit = 精确 patch；write = 整文件写入（工具不返回 patch，按整文件内容计新增） */
  kind: 'edit' | 'write';
}

/** 一轮对话的全部文件改动 */
export interface TurnChanges {
  files: TurnFileChange[];
  additions: number;
  deletions: number;
}

/**
 * 右侧工作区「打开文件 / 打开 diff / 打开本轮审核」请求（`store.pendingFile`）。
 * 由聊天里的按钮写入，`RightWorkspace` 消费后立即清空。
 */
export interface PendingFileRequest {
  path: string;
  mode: 'file' | 'diff' | 'review';
  /** 单个工具调用的 diff（ToolCard 的「查看 diff」） */
  toolCallId?: string;
  edits?: any[];
  /** 一轮里某个文件的改动（「本次改动」卡片点文件名） */
  change?: TurnFileChange;
  /** 一轮里全部改动文件（「本次改动」卡片点「审核」） */
  changes?: TurnFileChange[];
}

/** 代码面板 tab（CodePanel / RightWorkspace 用） */
export interface CodeTab {
  id: string;
  type: 'file' | 'diff' | 'review';
  title: string;
  filePath: string;
  content?: string;
  patch?: string;
  beforeContent?: string;
  originalContent?: string;
  modifiedContent?: string;
  /** type='review'：本次审核的文件列表（左侧列表 + 右侧 diff） */
  changes?: TurnFileChange[];
}

/** 会话树节点（TreeView 用） */
export interface TreeNode {
  entry: {
    id: string;
    parentId: string | null;
    type: string;
    timestamp?: string;
    message?: any;
  };
  children: TreeNode[];
  label?: string;
  labelTimestamp?: string;
}
