/**
 * pi:getBuiltinProviders 的内置供应商筛选与计数
 *
 * 设置页有两处复用它：模型配置的「内置供应商」区（全部供应商）与决策模型的
 * 「内置决策模型供应商」区（onlyClassifier：只看 classifierCount > 0 的供应商）。
 * chat 与 classifier 的模型清单在 SDK 里是分开的两套（getModels 只回 chat），
 * 所以这里必须同时守住三件事：
 *   1. modelCount 来自 getModels（chat），classifierCount 来自 getModelsOfType('classifier')
 *   2. models.json（自定义 chat provider）与 classifiers.json（自定义决策端点）都不算内置
 *   3. 运行时缺少 getModelsOfType 时降级为 0 而不是抛错
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
const readProviderConfig = vi.hoisted(() => vi.fn(() => ({ providers: {} }) as any));
const readClassifierConfig = vi.hoisted(() => vi.fn(() => ({ providers: {} }) as any));
const readBuiltinApiKey = vi.hoisted(() => vi.fn((_providerId: string) => '' as string));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) }
}));

vi.mock('../../electron/provider-config', () => ({
  readProviderConfig,
  readBuiltinApiKey,
  persistBuiltinApiKey: vi.fn(),
  deleteBuiltinApiKey: vi.fn()
}));

vi.mock('../../electron/classifier-config', () => ({
  readClassifierConfig,
  CLASSIFIERS_PATH: '/tmp/classifiers.json'
}));

import { registerModelIpc } from '../../electron/ipc/model-ipc';

interface FakeProvider {
  id: string;
  name: string;
  baseUrl?: string;
  chat?: number;
  classifier?: number;
}

function runtimeFor(providers: FakeProvider[], opts: { noTypeLookup?: boolean } = {}) {
  return {
    getProviders: () => providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl })),
    getModels: (id: string) => {
      const p = providers.find((x) => x.id === id);
      return p ? Array.from({ length: p.chat ?? 0 }, (_, i) => ({ id: `${id}-chat-${i}` })) : [];
    },
    ...(opts.noTypeLookup
      ? {}
      : {
          getModelsOfType: (type: string, id: string) => {
            if (type !== 'classifier') return [];
            const p = providers.find((x) => x.id === id);
            return p
              ? Array.from({ length: p.classifier ?? 0 }, (_, i) => ({ id: `${id}-cls-${i}` }))
              : [];
          }
        }),
    getProviderAuthStatus: () => ({ configured: false })
  };
}

function register(modelRuntime: any, channel = 'pi:getBuiltinProviders') {
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
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} 未注册`);
  return handler;
}

describe('pi:getBuiltinProviders', () => {
  beforeEach(() => {
    readProviderConfig.mockReturnValue({ providers: {} });
    readClassifierConfig.mockReturnValue({ providers: {} });
  });

  it('chat 与 classifier 计数分开取（getModels 不含 classifier 模型）', async () => {
    const handler = register(
      runtimeFor([
        { id: 'anthropic', name: 'Anthropic', chat: 17 },
        { id: 'typesafe', name: 'TypeSafe', classifier: 1 },
        { id: 'openrouter', name: 'OpenRouter', chat: 120, classifier: 10 }
      ])
    );

    const rows = await handler();
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));

    expect(byId.anthropic).toMatchObject({ modelCount: 17, classifierCount: 0 });
    expect(byId.typesafe).toMatchObject({ modelCount: 0, classifierCount: 1 });
    expect(byId.openrouter).toMatchObject({ modelCount: 120, classifierCount: 10 });
  });

  it('models.json 与 classifiers.json 的 provider 都不算内置', async () => {
    readProviderConfig.mockReturnValue({ providers: { 'my-openai-proxy': {} } });
    readClassifierConfig.mockReturnValue({ providers: { 'local-kev': {} } });

    const handler = register(
      runtimeFor([
        { id: 'my-openai-proxy', name: '代理', chat: 3 },
        { id: 'local-kev', name: '本地 Kev 4B', classifier: 1 },
        { id: 'typesafe', name: 'TypeSafe', classifier: 1 }
      ])
    );

    const ids = (await handler()).map((r: any) => r.id);
    expect(ids).toEqual(['typesafe']);
  });

  it('运行时没有 getModelsOfType 时降级为 0，不抛错', async () => {
    const handler = register(
      runtimeFor([{ id: 'anthropic', name: 'Anthropic', chat: 5 }], { noTypeLookup: true })
    );

    const rows = await handler();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'anthropic', modelCount: 5, classifierCount: 0 });
  });

  it('模型运行时不可用时返回空数组', async () => {
    const handler = register(null);
    expect(await handler()).toEqual([]);
  });

  it('带出鉴权状态字段（供 UI 显示未配置凭据徽章）', async () => {
    const handler = register(runtimeFor([{ id: 'typesafe', name: 'TypeSafe', classifier: 2 }]));
    const [row] = await handler();
    expect(row).toMatchObject({
      id: 'typesafe',
      authConfigured: false,
      name: 'TypeSafe',
      baseUrl: ''
    });
  });
});

// ─── pi:getProviderApiKey（编辑表单回填） ───

describe('pi:getProviderApiKey', () => {
  beforeEach(() => {
    readBuiltinApiKey.mockReset();
    readBuiltinApiKey.mockReturnValue('');
  });

  it('返回 auth.json 中已保存的 Key', async () => {
    readBuiltinApiKey.mockReturnValue('sk-opencode-go');
    const handler = register(runtimeFor([]), 'pi:getProviderApiKey');
    expect(await handler({}, 'opencode-go')).toBe('sk-opencode-go');
    expect(readBuiltinApiKey).toHaveBeenCalledWith('opencode-go');
  });

  it('未保存时返回空串（不回填环境变量来源的值）', async () => {
    const handler = register(runtimeFor([]), 'pi:getProviderApiKey');
    expect(await handler({}, 'opencode-go')).toBe('');
  });

  it('providerId 非法时返回空串且不读盘', async () => {
    const handler = register(runtimeFor([]), 'pi:getProviderApiKey');
    expect(await handler({}, '')).toBe('');
    expect(await handler({}, undefined)).toBe('');
    expect(readBuiltinApiKey).not.toHaveBeenCalled();
  });

  it('模型运行时不可用时仍能回填（只读 auth.json，不依赖 runtime）', async () => {
    readBuiltinApiKey.mockReturnValue('sk-only-disk');
    const handler = register(null, 'pi:getProviderApiKey');
    expect(await handler({}, 'opencode-go')).toBe('sk-only-disk');
  });
});
