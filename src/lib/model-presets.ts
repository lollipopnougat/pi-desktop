import type { ModelPreset } from '../types/model-preset';
import { normalizePresetModelId } from '../types/model-preset';
import { THINKING_LEVELS, buildThinkingLevelMap, type ProviderModel } from '../types/shared';

/**
 * 渲染进程侧的模型预设索引与匹配。
 *
 * 预设数据由主进程 `pi:getModelPresets` 一次性给出（SDK 内置目录，~1100 条 / ~110KB），
 * 这里做模块级缓存（一次会话只拉一次）并提供三种用途：
 *   1. suggestModelPresets —— 输入模型 id 时给候选（新增模型区、编辑面板）
 *   2. findModelPreset —— 精确匹配（「从 /v1/models 拉取」后自动补齐参数）
 *   3. presetToModelFields —— 预设 → ProviderModel 字段映射
 * 全部为纯函数，便于测试；window.pi 只在 loadModelPresetIndex 里访问。
 */

export interface ModelPresetIndex {
  presets: ModelPreset[];
  /** 规范化 id → 预设（同一 id 在不同 provider/上下文窗口下可能有多条，已按 provider 优先级排序） */
  byNormalizedId: Map<string, ModelPreset[]>;
}

export const EMPTY_PRESET_INDEX: ModelPresetIndex = { presets: [], byNormalizedId: new Map() };

/** 构造索引（纯函数，供测试直接调用） */
export function buildModelPresetIndex(presets: readonly ModelPreset[]): ModelPresetIndex {
  const byNormalizedId = new Map<string, ModelPreset[]>();
  for (const p of presets) {
    const key = normalizePresetModelId(p.id);
    if (!key) continue;
    const bucket = byNormalizedId.get(key);
    if (bucket) bucket.push(p);
    else byNormalizedId.set(key, [p]);
  }
  return { presets: [...presets], byNormalizedId };
}

/**
 * 匹配打分：越小越靠前；返回 null 表示不匹配。
 * 顺序刻意做成「完整 id 精确 > 规范化 id 精确 > id 前缀 > 规范化前缀 > id 包含 > 名称包含」，
 * 这样输入 `gpt-6-astra` 时精确命中排在 `openai/gpt-6-astra` 别名之前。
 */
function presetMatchScore(preset: ModelPreset, query: string): number | null {
  const id = preset.id.toLowerCase();
  const norm = normalizePresetModelId(preset.id);
  if (id === query) return 0;
  if (norm === query) return 1;
  if (id.startsWith(query)) return 2;
  if (norm.startsWith(query)) return 3;
  if (id.includes(query) || norm.includes(query)) return 4;
  if (preset.name.toLowerCase().includes(query)) return 5;
  return null;
}

/** 无 vendor 前缀的裸 id 优先（自定义 provider 一般用裸 id，别让别名占住候选位） */
function bareIdRank(preset: ModelPreset): number {
  return preset.id.toLowerCase() === normalizePresetModelId(preset.id) ? 0 : 1;
}

/**
 * 按输入给候选预设。
 * @param query 用户输入的模型 id 片段（空串返回空数组，由调用方决定是否展示「热门」）
 * @param limit 最多返回条数（默认 8）
 */
export function suggestModelPresets(
  index: ModelPresetIndex,
  query: string,
  limit = 8
): ModelPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { preset: ModelPreset; score: number; order: number }[] = [];
  index.presets.forEach((preset, order) => {
    const score = presetMatchScore(preset, q);
    if (score !== null) scored.push({ preset, score, order });
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      bareIdRank(a.preset) - bareIdRank(b.preset) ||
      a.order - b.order ||
      b.preset.contextWindow - a.preset.contextWindow ||
      a.preset.id.localeCompare(b.preset.id)
  );
  const seen = new Set<string>();
  const out: ModelPreset[] = [];
  for (const s of scored) {
    const key = `${normalizePresetModelId(s.preset.id)}|${s.preset.contextWindow}|${s.preset.maxTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.preset);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 精确匹配（拉取结果补齐 / 编辑面板「按 ID 应用预设」）：
 * 先要完整 id 完全相同，否则优先无 vendor 前缀的裸 id（自定义 provider 一般用裸 id），
 * 都没有时退回索引首条（已按 provider 优先级排序）。
 */
export function findModelPreset(index: ModelPresetIndex, modelId: string): ModelPreset | null {
  const raw = modelId.trim().toLowerCase();
  if (!raw) return null;
  const bucket = index.byNormalizedId.get(normalizePresetModelId(raw));
  if (!bucket || bucket.length === 0) return null;
  const exact = bucket.find((p) => p.id.toLowerCase() === raw);
  if (exact) return exact;
  return bucket.find((p) => bareIdRank(p) === 0) ?? bucket[0];
}

/** 预设 → 自定义 provider 的模型字段（基础字段 + 思考等级 + 价格，不碰 api 相关的 compat） */
export function presetToModelFields(preset: ModelPreset): Partial<ProviderModel> {
  const levels = THINKING_LEVELS.filter((l) => preset.levels.includes(l));
  return {
    name: preset.name,
    reasoning: preset.reasoning,
    input: preset.vision ? ['text', 'image'] : ['text'],
    ...(preset.contextWindow > 0 ? { contextWindow: preset.contextWindow } : {}),
    ...(preset.maxTokens > 0 ? { maxTokens: preset.maxTokens } : {}),
    ...(preset.cost ? { cost: { ...preset.cost } } : {}),
    ...(levels.length > 0 ? { thinkingLevelMap: buildThinkingLevelMap(new Set(levels)) } : {})
  };
}

/** 上下文窗口 / 最大输出的紧凑展示：272000 → 「272K」，1000000 → 「1M」 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000000) {
    const m = value / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k)}K`;
  }
  return String(value);
}

// ─── 加载（模块级缓存：一次会话只走一次 IPC） ───────────────────────────────

let indexPromise: Promise<ModelPresetIndex> | null = null;

/** 拉取并缓存预设索引；失败时返回空索引（不抛错，调用方降级为纯手填） */
export function loadModelPresetIndex(): Promise<ModelPresetIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const presets = await window.pi.getModelPresets();
        return buildModelPresetIndex(Array.isArray(presets) ? presets : []);
      } catch {
        return EMPTY_PRESET_INDEX;
      }
    })();
  }
  return indexPromise;
}

/** 清空缓存（测试/刷新场景） */
export function resetModelPresetIndex(): void {
  indexPromise = null;
}
