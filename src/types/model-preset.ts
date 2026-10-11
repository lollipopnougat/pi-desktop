/**
 * 模型预设类型（主进程 electron/model-presets.ts 产出，渲染进程 src/lib/model-presets.ts 消费）。
 *
 * 数据源是 SDK 内置模型目录（@earendil-works/pi-ai 的 providers/data/*.json，
 * 经 ModelRuntime.getModels() 读取）：离线、无需鉴权、随 SDK 升级自动更新。
 * 用户在新填自定义 provider 的模型时，可直接选一条预设带出上下文窗口 / 视觉 / 推理 /
 * 价格 / 思考等级，避免手填默认值（原先一律 1000000 / 128000 / 全开）。
 */
export interface ModelPresetCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPreset {
  /** 内置目录里的原始模型 id（可能是 openrouter 风格的 `vendor/model`） */
  id: string;
  /** 展示名（如 GPT-6 Astra） */
  name: string;
  /** 来源内置 provider id（如 openai），仅用于展示与排序 */
  provider: string;
  /** 来源内置 provider 展示名 */
  providerName: string;
  /** 内置条目使用的 api（仅供比对，不写回自定义 provider） */
  api: string;
  contextWindow: number;
  maxTokens: number;
  /** 是否支持图片输入（input 含 image） */
  vision: boolean;
  reasoning: boolean;
  /** 价格（$/M tokens）；内置条目未提供时省略 */
  cost?: ModelPresetCost;
  /** 该模型支持的思考等级（已按 SDK thinkingLevelMap 过滤，取值见 THINKING_LEVELS） */
  levels: string[];
}

/**
 * 规范化模型 id：小写 + 去掉 `vendor/` 前缀（openrouter / vercel-ai-gateway 风格）。
 * 主进程构建预设去重与渲染进程匹配都走这里，保证两侧同一套规则。
 */
export function normalizePresetModelId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!trimmed) return '';
  const segments = trimmed.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : trimmed;
}
