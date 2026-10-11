/**
 * 模型预设构建（主进程）与 pi:getModelPresets handler。
 *
 * 两件事必须守住：
 *   1. 去重不能丢错那一条：同一模型在 openai / azure / openrouter 等 provider 下重复收录，
 *      必须保留优先级最高（最权威）的 provider，且与输入顺序无关
 *   2. 全 0 的 cost 不能写进预设（UI 会据此填充，全 0 会把用户手填的价格清成 0）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
const readProviderConfig = vi.hoisted(() => vi.fn(() => ({ providers: {} }) as any));
const readClassifierConfig = vi.hoisted(() => vi.fn(() => ({ providers: {} }) as any));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) }
}));

vi.mock('../../electron/provider-config', () => ({
  readProviderConfig,
  persistBuiltinApiKey: vi.fn(),
  deleteBuiltinApiKey: vi.fn()
}));

vi.mock('../../electron/classifier-config', () => ({
  readClassifierConfig,
  CLASSIFIERS_PATH: '/tmp/classifiers.json'
}));

import { buildModelPresets, normalizePresetModelId } from '../../electron/model-presets';
import { registerModelIpc } from '../../electron/ipc/model-ipc';

describe('normalizePresetModelId', () => {
  it('去 vendor 前缀并小写', () => {
    expect(normalizePresetModelId('OpenAI/GPT-6-Astra')).toBe('gpt-6-astra');
    expect(normalizePresetModelId('  meta-llama/llama-3.1-8b  ')).toBe('llama-3.1-8b');
    expect(normalizePresetModelId('gpt-6-astra')).toBe('gpt-6-astra');
    expect(normalizePresetModelId('')).toBe('');
    expect(normalizePresetModelId('   ')).toBe('');
  });
});

describe('buildModelPresets', () => {
  const astraRaw = {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    provider: 'openai',
    api: 'openai-responses',
    contextWindow: 272000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoning: true,
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272000 }]
    },
    thinkingLevelMap: {
      off: 'off',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    }
  };

  it('字段映射：视觉来自 input 含 image，思考等级按 thinkingLevelMap 过滤', () => {
    const [preset] = buildModelPresets([astraRaw]);
    expect(preset).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      provider: 'openai',
      vision: true,
      reasoning: true,
      contextWindow: 272000,
      maxTokens: 128000,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
    });
    // tiers 等额外字段不进预设
    expect(preset.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(preset.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('thinkingLevelMap 里 xhigh/max 未显式映射时不算支持', () => {
    const [preset] = buildModelPresets([
      {
        ...astraRaw,
        id: 'plain-thinking',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' }
      }
    ]);
    expect(preset.levels).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('无 thinkingLevelMap 时给出默认支持等级（不含 xhigh/max）', () => {
    const [preset] = buildModelPresets([{ id: 'legacy', provider: 'openai' }]);
    expect(preset.levels).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('纯文本模型 vision=false，name 回退 id，providerName 缺失时回退 provider id', () => {
    const [preset] = buildModelPresets([{ id: 'text-only', provider: 'openai', input: ['text'] }]);
    expect(preset.vision).toBe(false);
    expect(preset.name).toBe('text-only');
    expect(preset.providerName).toBe('openai');
  });

  it('providerNames 用于展示名', () => {
    const [preset] = buildModelPresets([astraRaw], new Map([['openai', 'OpenAI']]));
    expect(preset.providerName).toBe('OpenAI');
  });

  it('全 0 / 缺失的 cost 不写入（避免预设把价格归零）', () => {
    const presets = buildModelPresets([
      {
        id: 'free',
        provider: 'openai',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      { id: 'no-cost', provider: 'openai' }
    ]);
    expect(presets[0].cost).toBeUndefined();
    expect(presets[1].cost).toBeUndefined();
  });

  it('非法数值与非法条目被规整 / 跳过', () => {
    const presets = buildModelPresets([
      { id: 'bad-num', provider: 'openai', contextWindow: -1, maxTokens: NaN },
      { id: '', provider: 'openai' },
      { id: '   ', provider: 'openai' },
      { id: 123 as unknown as string, provider: 'openai' } as any
    ]);
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({ id: 'bad-num', contextWindow: 0, maxTokens: 0 });
  });

  it('同一模型跨 provider 去重：保留优先级高的 provider，且与输入顺序无关', () => {
    const fromOpenRouter = { ...astraRaw, id: 'openai/gpt-6-astra', provider: 'openrouter' };
    const fromOpenAI = astraRaw;

    const a = buildModelPresets([fromOpenRouter, fromOpenAI]);
    const b = buildModelPresets([fromOpenAI, fromOpenRouter]);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).toBe('gpt-6-astra');
    expect(a[0].provider).toBe('openai');
    expect(b[0]).toEqual(a[0]);
  });

  it('上下文窗口不同的同名模型都保留（如 200K / 1M 两个版本）', () => {
    const presets = buildModelPresets([
      astraRaw,
      { ...astraRaw, id: 'openai/gpt-6-astra', provider: 'openrouter', contextWindow: 1000000 }
    ]);
    expect(presets).toHaveLength(2);
    expect(presets.map((p) => p.contextWindow).sort((x, y) => x - y)).toEqual([272000, 1000000]);
  });

  it('按 provider 优先级排序（openai → openrouter → azure/bedrock 等镜像）', () => {
    const presets = buildModelPresets([
      { id: 'x-a', provider: 'azure' },
      { id: 'x-b', provider: 'openrouter' },
      { id: 'x-c', provider: 'openai' }
    ]);
    expect(presets.map((p) => p.provider)).toEqual(['openai', 'openrouter', 'azure']);
  });
});

// ─── IPC handler ──────────────────────────────────────────────────────────

interface FakeProvider {
  id: string;
  name: string;
  models?: any[];
}

function runtimeFor(providers: FakeProvider[]) {
  const calls = { models: 0 };
  return {
    calls,
    getProviders: () => providers.map((p) => ({ id: p.id, name: p.name })),
    getModels: (id: string) => {
      calls.models += 1;
      return providers.find((p) => p.id === id)?.models ?? [];
    },
    getModelsOfType: () => [],
    getProviderAuthStatus: () => ({ configured: false }),
    refresh: vi.fn(async () => {})
  };
}

function register(modelRuntime: any) {
  handlers.clear();
  registerModelIpc({
    modelRuntime,
    runtime: {},
    cwd: '/tmp',
    getSession: () => ({}),
    syncSession: async () => {},
    sessionAccess: {} as any,
    getSessionIdentity: () => ({}) as any,
    runSessionOperation: async (op: any) => op(),
    createRuntimeFor: async () => {},
    setPlanMode: () => {}
  } as any);
  const preset = handlers.get('pi:getModelPresets');
  if (!preset) throw new Error('pi:getModelPresets 未注册');
  return preset;
}

describe('pi:getModelPresets', () => {
  beforeEach(() => {
    readProviderConfig.mockReturnValue({ providers: {} });
    readClassifierConfig.mockReturnValue({ providers: {} });
  });

  it('汇总内置 provider 的模型并带出 provider 展示名', async () => {
    const handler = register(
      runtimeFor([
        {
          id: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-6-astra', provider: 'openai', contextWindow: 272000 }]
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-x', provider: 'anthropic', contextWindow: 200000 }]
        }
      ])
    );

    const presets = await handler();
    const byId = Object.fromEntries(presets.map((p: any) => [p.id, p]));
    expect(byId['gpt-6-astra'].providerName).toBe('OpenAI');
    expect(byId['claude-x'].providerName).toBe('Anthropic');
    expect(byId['gpt-6-astra'].contextWindow).toBe(272000);
  });

  it('排除 models.json / classifiers.json 里的自定义 provider', async () => {
    readProviderConfig.mockReturnValue({ providers: { 'my-proxy': {} } });
    readClassifierConfig.mockReturnValue({ providers: { 'local-kev': {} } });

    const handler = register(
      runtimeFor([
        { id: 'my-proxy', name: '代理', models: [{ id: 'proxy-model', provider: 'my-proxy' }] },
        { id: 'local-kev', name: 'Kev', models: [{ id: 'kev-4b', provider: 'local-kev' }] },
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6-astra', provider: 'openai' }] }
      ])
    );

    const ids = (await handler()).map((p: any) => p.id);
    expect(ids).toEqual(['gpt-6-astra']);
  });

  it('结果缓存：重复调用不再遍历 provider', async () => {
    const runtime = runtimeFor([
      { id: 'openai', name: 'OpenAI', models: [{ id: 'a', provider: 'openai' }] }
    ]);
    const handler = register(runtime);

    await handler();
    const afterFirst = runtime.calls.models;
    await handler();
    expect(runtime.calls.models).toBe(afterFirst);
  });

  it('refreshProviders 后缓存作废（SDK 模型目录可能更新）', async () => {
    const models: any[] = [{ id: 'a', provider: 'openai' }];
    const runtime = runtimeFor([{ id: 'openai', name: 'OpenAI', models }]);
    const handler = register(runtime);

    expect((await handler()).map((p: any) => p.id)).toEqual(['a']);
    models.push({ id: 'b', provider: 'openai' });
    expect((await handler()).map((p: any) => p.id)).toEqual(['a']);

    await handlers.get('pi:refreshProviders')!();
    expect((await handler()).map((p: any) => p.id)).toEqual(['a', 'b']);
  });

  it('模型运行时不可用时返回空数组', async () => {
    expect(await register(null)()).toEqual([]);
  });
});
