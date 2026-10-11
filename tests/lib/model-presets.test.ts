/**
 * 渲染进程侧的预设索引 / 匹配 / 字段映射。
 *
 * 这些逻辑决定「输入 gpt-6-astra 时能否带出 272K 上下文 + 视觉 + 全等级思考」，
 * 所以重点守三件事：
 *   1. 精确 id 排在带 vendor 前缀的别名之前（用户输入的 id 必须优先命中）
 *   2. 同一模型的重复收录不会在建议列表里刷屏
 *   3. 字段映射不写 compat、不写 api（自定义 provider 的端点协议与内置条目无关）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModelPreset } from '../../src/types/model-preset';
import {
  EMPTY_PRESET_INDEX,
  buildModelPresetIndex,
  findModelPreset,
  formatTokenCount,
  loadModelPresetIndex,
  presetToModelFields,
  resetModelPresetIndex,
  suggestModelPresets
} from '../../src/lib/model-presets';

const astra: ModelPreset = {
  id: 'gpt-6-astra',
  name: 'GPT-6 Astra',
  provider: 'openai',
  providerName: 'OpenAI',
  api: 'openai-responses',
  contextWindow: 272000,
  maxTokens: 128000,
  vision: true,
  reasoning: true,
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max']
};

const astraViaOpenRouter: ModelPreset = {
  ...astra,
  id: 'openai/gpt-6-astra',
  provider: 'openrouter',
  providerName: 'OpenRouter'
};

const claude: ModelPreset = {
  ...astra,
  id: 'claude-x',
  name: 'Claude X',
  provider: 'anthropic',
  providerName: 'Anthropic',
  api: 'anthropic-messages',
  contextWindow: 200000,
  maxTokens: 64000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  levels: ['off', 'low', 'medium', 'high']
};

const llama: ModelPreset = {
  ...astra,
  id: 'meta-llama/llama-3.1-8b',
  name: 'Llama 3.1 8B',
  provider: 'openrouter',
  providerName: 'OpenRouter',
  contextWindow: 131072,
  maxTokens: 8192,
  vision: false,
  reasoning: false,
  cost: undefined,
  levels: ['off']
};

describe('buildModelPresetIndex', () => {
  it('按规范化 id 分桶（别名与裸 id 同桶）', () => {
    const index = buildModelPresetIndex([astra, astraViaOpenRouter, claude]);
    expect(index.presets).toHaveLength(3);
    expect(index.byNormalizedId.get('gpt-6-astra')).toHaveLength(2);
    expect(index.byNormalizedId.get('claude-x')).toHaveLength(1);
  });
});

describe('suggestModelPresets', () => {
  const index = buildModelPresetIndex([astraViaOpenRouter, astra, claude, llama]);

  it('空查询不给候选（避免弹出一大堆）', () => {
    expect(suggestModelPresets(index, '')).toEqual([]);
    expect(suggestModelPresets(index, '   ')).toEqual([]);
  });

  it('精确 id 排在带前缀的别名之前，别名被去重掉（同一模型只留一行）', () => {
    const out = suggestModelPresets(index, 'gpt-6-astra');
    expect(out.map((p) => p.id)).toEqual(['gpt-6-astra']);
    expect(out[0].provider).toBe('openai');
  });

  it('裸 id 优先与索引输入顺序无关', () => {
    const reversed = buildModelPresetIndex([astra, astraViaOpenRouter]);
    expect(suggestModelPresets(reversed, 'gpt-6-astra')[0].id).toBe('gpt-6-astra');
  });

  it('前缀匹配可用（输入一半也能命中）', () => {
    expect(suggestModelPresets(index, 'gpt-6')).toHaveLength(1);
    expect(suggestModelPresets(index, 'claude')[0].id).toBe('claude-x');
  });

  it('名称匹配也能命中（不区分大小写）', () => {
    const out = suggestModelPresets(index, 'llama 3.1');
    expect(out[0].id).toBe('meta-llama/llama-3.1-8b');
  });

  it('不匹配时返回空数组', () => {
    expect(suggestModelPresets(index, 'not-a-model-xyz')).toEqual([]);
  });

  it('同一模型（规范化 id + 窗口相同）只出现一次', () => {
    const out = suggestModelPresets(index, 'astra');
    expect(out.map((p) => p.id)).toEqual(['gpt-6-astra']);
  });

  it('limit 生效', () => {
    expect(suggestModelPresets(index, 'a', 2)).toHaveLength(2);
  });
});

describe('findModelPreset', () => {
  const index = buildModelPresetIndex([astraViaOpenRouter, astra, claude, llama]);

  it('完整 id 精确命中优先（别名场景）', () => {
    expect(findModelPreset(index, 'openai/gpt-6-astra')?.provider).toBe('openrouter');
    expect(findModelPreset(index, 'GPT-6-Astra')?.provider).toBe('openai');
  });

  it('大小写与空白不敏感', () => {
    expect(findModelPreset(index, '  GPT-6-ASTRA ')?.id).toBe('gpt-6-astra');
  });

  it('无前缀裸 id 优先于别名（自定义 provider 一般用裸 id）', () => {
    expect(findModelPreset(index, 'llama-3.1-8b')?.id).toBe('meta-llama/llama-3.1-8b');
  });

  it('未收录时返回 null', () => {
    expect(findModelPreset(index, 'gpt-9-unknown')).toBeNull();
    expect(findModelPreset(index, '')).toBeNull();
    expect(findModelPreset(EMPTY_PRESET_INDEX, 'gpt-6-astra')).toBeNull();
  });
});

describe('presetToModelFields', () => {
  it('基础字段 + 思考等级 + 价格，且不写 compat / api', () => {
    const fields = presetToModelFields(astra);
    expect(fields).toEqual({
      name: 'GPT-6 Astra',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 272000,
      maxTokens: 128000,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: {
        off: 'off',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max'
      }
    });
    expect(fields).not.toHaveProperty('compat');
    expect(fields).not.toHaveProperty('api');
    expect(fields).not.toHaveProperty('defaultThinkingLevel');
  });

  it('纯文本模型 input 只有 text；不支持的等级写 null', () => {
    expect(presetToModelFields(llama).input).toEqual(['text']);
    const fields = presetToModelFields(claude);
    expect(fields.input).toEqual(['text', 'image']);
    expect(fields.thinkingLevelMap).toMatchObject({ xhigh: null, max: null, high: 'high' });
  });

  it('无价格时省略 cost（不把用户手填价格清零）', () => {
    expect(presetToModelFields(llama)).not.toHaveProperty('cost');
  });

  it('窗口为 0（目录未收录）时省略两个数值字段', () => {
    const fields = presetToModelFields({ ...astra, contextWindow: 0, maxTokens: 0 });
    expect(fields).not.toHaveProperty('contextWindow');
    expect(fields).not.toHaveProperty('maxTokens');
  });
});

describe('formatTokenCount', () => {
  it('紧凑展示', () => {
    expect(formatTokenCount(272000)).toBe('272K');
    expect(formatTokenCount(200000)).toBe('200K');
    expect(formatTokenCount(1000000)).toBe('1M');
    expect(formatTokenCount(1500000)).toBe('1.5M');
    expect(formatTokenCount(512)).toBe('512');
    expect(formatTokenCount(0)).toBe('—');
    expect(formatTokenCount(NaN)).toBe('—');
  });
});

describe('loadModelPresetIndex', () => {
  beforeEach(() => {
    resetModelPresetIndex();
  });

  it('只走一次 IPC（模块级缓存）', async () => {
    const getModelPresets = vi.fn(async () => [astra]);
    (globalThis as any).window = { pi: { getModelPresets } };

    const first = await loadModelPresetIndex();
    const second = await loadModelPresetIndex();
    expect(getModelPresets).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.byNormalizedId.get('gpt-6-astra')).toHaveLength(1);
  });

  it('IPC 失败时降级为空索引，不抛错', async () => {
    (globalThis as any).window = {
      pi: {
        getModelPresets: vi.fn(async () => {
          throw new Error('boom');
        })
      }
    };
    await expect(loadModelPresetIndex()).resolves.toEqual(EMPTY_PRESET_INDEX);
  });
});
