import type { ModelPreset, ModelPresetCost } from '../src/types/model-preset';
import { normalizePresetModelId } from '../src/types/model-preset';
import { getSelectedThinkingLevels } from '../src/types/shared';

/**
 * 模型预设构建（主进程）。
 *
 * 数据源是 SDK 内置模型目录：ModelRuntime.getModels(providerId) 逐 provider 取回
 * 全量 chat 模型（离线、无需鉴权，数据来自 @earendil-works/pi-ai 的 providers/data/*.json）。
 * 内置目录里同一个模型会出现在多个 provider 下（openai/azure/bedrock/openrouter/…），
 * 这里按「provider 优先级 + 规范化 id + 上下文窗口 + 最大输出」去重，只保留最权威的一条，
 * 把 1600+ 条压到 ~1100 条（IPC 载荷 ~110KB），既省内存又避免建议列表被别名刷屏。
 */

/** 优先级越小越靠前：同一模型出现在多个 provider 时保留最权威的那条 */
const PROVIDER_PRIORITY = [
  'openai',
  'anthropic',
  'google',
  'google-vertex',
  'deepseek',
  'xai',
  'mistral',
  'groq',
  'cerebras',
  'moonshotai',
  'moonshotai-cn',
  'kimi-coding',
  'zai',
  'zai-coding-cn',
  'minimax',
  'minimax-cn',
  'meta',
  'nvidia',
  'together',
  'fireworks',
  'baseten',
  'huggingface',
  'ant-ling',
  'xiaomi',
  'openrouter',
  'opencode',
  'opencode-go',
  'radius',
  'typesafe',
  'amazon-bedrock',
  'azure',
  'github-copilot',
  'vercel-ai-gateway',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp'
];

const PRIORITY_INDEX = new Map(PROVIDER_PRIORITY.map((id, i) => [id, i]));

function providerRank(provider: string): number {
  return PRIORITY_INDEX.get(provider) ?? PROVIDER_PRIORITY.length;
}

/**
 * 规范化模型 id：小写 + 去掉 `vendor/` 前缀，用于跨 provider 比对同一模型。
 * 规则与渲染进程共用（见 src/types/model-preset.ts）。
 */
export { normalizePresetModelId };

/** buildModelPresets 的输入：SDK Model 的最小结构子集（便于测试构造） */
export interface RawCatalogModel {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  api?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  input?: unknown;
  reasoning?: unknown;
  cost?: unknown;
  thinkingLevelMap?: unknown;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function toCost(raw: unknown): ModelPresetCost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cost: ModelPresetCost = {
    input: num(c.input),
    output: num(c.output),
    cacheRead: num(c.cacheRead),
    cacheWrite: num(c.cacheWrite)
  };
  // 全 0（免费模型/未收录价格）无信息量，省略以免覆盖用户手填的值
  if (cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0) {
    return undefined;
  }
  return cost;
}

/**
 * 把 SDK 内置模型清单转成预设列表：过滤非法条目 → 按 provider 优先级排序 → 去重。
 * @param providerNames provider id → 展示名（缺省回退 id）
 */
export function buildModelPresets(
  rawModels: readonly RawCatalogModel[],
  providerNames?: Map<string, string> | Record<string, string>
): ModelPreset[] {
  const nameOf = (id: string): string => {
    if (!providerNames) return id;
    if (providerNames instanceof Map) return providerNames.get(id) ?? id;
    return providerNames[id] ?? id;
  };

  const presets: ModelPreset[] = [];
  for (const m of rawModels) {
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;
    const provider = typeof m.provider === 'string' ? m.provider : '';
    const input = Array.isArray(m.input) ? m.input : [];
    const levels = Array.from(
      getSelectedThinkingLevels({ thinkingLevelMap: m.thinkingLevelMap as any })
    );
    const cost = toCost(m.cost);
    presets.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id,
      provider,
      providerName: nameOf(provider),
      api: typeof m.api === 'string' ? m.api : '',
      contextWindow: toPositiveInt(m.contextWindow, 0),
      maxTokens: toPositiveInt(m.maxTokens, 0),
      vision: input.includes('image'),
      reasoning: m.reasoning === true,
      ...(cost ? { cost } : {}),
      levels
    });
  }

  presets.sort(
    (a, b) => providerRank(a.provider) - providerRank(b.provider) || a.id.localeCompare(b.id)
  );

  const seen = new Set<string>();
  return presets.filter((p) => {
    const key = `${normalizePresetModelId(p.id)}|${p.contextWindow}|${p.maxTokens}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
