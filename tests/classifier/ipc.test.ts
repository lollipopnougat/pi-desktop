import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

const { tmpDir, classifiersPath, handlers } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-classifier-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return {
    tmpDir: dir,
    classifiersPath: join(dir, 'classifiers.json'),
    handlers: new Map<string, (event: unknown, ...args: any[]) => any>()
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => any) {
      handlers.set(channel, fn);
    }
  }
}));

vi.mock('../../electron/config-dir', () => ({
  DESKTOP_AGENT_DIR: tmpDir
}));

import { registerClassifierIpc, validateQuestions } from '../../electron/ipc/classifier-ipc';
import { readClassifierConfig } from '../../electron/classifier-config';
import { DEFAULT_LOG_CONFIG, resetLogStateForTest, setLogConfig } from '../../electron/logs/logger';

const LOCAL_KEY = 'local-kev';

function makeModels() {
  return [
    {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      name: 'Kev 4B',
      api: 'typesafe-system-one',
      contextWindow: 262144,
      input: ['text']
    },
    {
      provider: LOCAL_KEY,
      id: 'vision-cls',
      name: 'Vision',
      api: 'typesafe-system-one',
      input: ['text', 'image']
    },
    {
      provider: 'orphan',
      id: 'no-cred',
      name: 'NoCred',
      api: 'llama-cpp-classify',
      input: ['text']
    }
  ];
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  const models = makeModels();
  const registered = new Map<string, any>();
  const unregistered: string[] = [];
  const classifyCalls: any[] = [];

  const runtime: any = {
    registerProvider: (id: string, config: unknown) => {
      registered.set(id, config);
    },
    unregisterProvider: (id: string) => {
      unregistered.push(id);
      registered.delete(id);
    },
    getProvider: (id: string) => (id === LOCAL_KEY ? { name: '本地决策模型' } : { name: id }),
    getModelsOfType: () => models,
    getAvailableOfType: async () => models.filter((m) => m.provider === LOCAL_KEY),
    getModelOfType: (_type: string, provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    classify: async (model: any, context: any, options: any) => {
      classifyCalls.push({ model, context, options });
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        answers: { approved: { type: 'bool', probability: 0.9 } },
        usage: { input: 10, output: 0 },
        stopReason: 'stop',
        timestamp: 1
      };
    },
    ...overrides
  };

  return { runtime, registered, unregistered, classifyCalls };
}

/** 注册 IPC 并用给定的 runtime 初始化 */
function setup(runtime: any) {
  handlers.clear();
  registerClassifierIpc({ modelRuntime: runtime } as any);
}

/** 调用已注册的 handler（第一个参数是 IpcMainInvokeEvent，用 null 占位） */
function invoke(channel: string, ...args: any[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler(null, ...args);
}

function writeProviders(providers: Record<string, unknown>) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(classifiersPath, JSON.stringify({ providers }), 'utf-8');
}

const VALID_QUESTIONS = {
  approved: {
    type: 'bool',
    instructions: '用户是否认可？',
    criteria: { true: '认可', false: '不认可' }
  }
};

const VALID_PROVIDER_PAYLOAD = {
  key: 'new-endpoint',
  name: '新端点',
  baseUrl: 'http://127.0.0.1:8080/v1',
  api: 'typesafe-system-one',
  models: [{ id: './Kev-4B-Q4_K_M.gguf', name: 'Kev 4B', contextWindow: 262144 }]
};

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 日志默认不启用；「决策模型调用日志」类用例要断言落盘内容，先手动打开
  resetLogStateForTest();
  setLogConfig({
    ...DEFAULT_LOG_CONFIG,
    enabled: true,
    channels: { ...DEFAULT_LOG_CONFIG.channels }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('注册的 IPC 通道', () => {
  it('注册全部 7 个决策模型通道', () => {
    setup(makeRuntime().runtime);
    expect([...handlers.keys()].sort()).toEqual([
      'pi:classify',
      'pi:fetchClassifierModels',
      'pi:getClassifierLogPath',
      'pi:getClassifierModels',
      'pi:getClassifierProviders',
      'pi:removeClassifierProvider',
      'pi:saveClassifierProvider'
    ]);
  });
});

describe('pi:getClassifierLogPath', () => {
  it('返回日志目录与今日文件（<agentDir>/logs/classifier-YYYY-MM-DD.log）', async () => {
    setup(makeRuntime().runtime);
    const result = await invoke('pi:getClassifierLogPath');
    expect(result.dir).toBe(`${tmpDir}/logs`);
    expect(result.file).toMatch(/classifier-\d{4}-\d{2}-\d{2}\.log$/);
    expect(result.enabled).toBe(true);
  });

  it('日志未启用（总开关关）时 enabled=false；关闭 classifier 通道也 false', async () => {
    setup(makeRuntime().runtime);

    setLogConfig({ ...DEFAULT_LOG_CONFIG, enabled: false });
    expect((await invoke('pi:getClassifierLogPath')).enabled).toBe(false);

    setLogConfig({
      ...DEFAULT_LOG_CONFIG,
      enabled: true,
      channels: { ...DEFAULT_LOG_CONFIG.channels, classifier: false }
    });
    expect((await invoke('pi:getClassifierLogPath')).enabled).toBe(false);
  });
});

describe('决策模型调用日志', () => {
  it('pi:classify 把请求参数与返回写成两行 JSON（request / response）', async () => {
    const { runtime } = makeRuntime();
    setup(runtime);
    const response = await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: { tool: 'bash', command: 'npm test' },
      questions: VALID_QUESTIONS
    });
    expect(response.stopReason).toBe('stop');

    const logDir = `${tmpDir}/logs`;
    const file = fs.readdirSync(logDir).find((name) => name.startsWith('classifier-'))!;
    const all = fs
      .readFileSync(`${logDir}/${file}`, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // 同一文件里的日志会跨用例累积：只看本次调用写的最后两行（request + response）
    const [logRequest, logResponse] = all.slice(-2);

    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(logRequest).toMatchObject({
      channel: 'classifier',
      source: 'playground',
      phase: 'request',
      providerId: LOCAL_KEY,
      modelId: './Kev-4B-Q4_K_M.gguf',
      state: { tool: 'bash', command: 'npm test' },
      questions: VALID_QUESTIONS
    });
    expect(logResponse).toMatchObject({ phase: 'response' });
    expect(logResponse.result.stopReason).toBe('stop');
    expect(typeof logResponse.elapsedMs).toBe('number');
  });

  it('前置校验失败（缺 id）也落一条 error 日志', async () => {
    setup(makeRuntime().runtime);
    const response = await invoke('pi:classify', { provider: LOCAL_KEY, id: '', state: {} });
    expect(response.stopReason).toBe('error');

    const file = fs.readdirSync(`${tmpDir}/logs`).find((name) => name.startsWith('classifier-'))!;
    const lines = fs
      .readFileSync(`${tmpDir}/logs/${file}`, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({
      source: 'playground',
      phase: 'error',
      note: '缺少 provider 或模型 id'
    });
  });
});

describe('pi:getClassifierModels', () => {
  it('runtime 未就绪时返回空清单', async () => {
    setup(null);
    expect(await invoke('pi:getClassifierModels')).toEqual({ models: [], errors: [] });
  });

  it('映射模型字段并标注可用性', async () => {
    writeProviders({
      [LOCAL_KEY]: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'typesafe-system-one',
        models: [{ id: 'x' }]
      }
    });
    setup(makeRuntime().runtime);

    const { models } = await invoke('pi:getClassifierModels');
    const kev = models.find((m: any) => m.id === './Kev-4B-Q4_K_M.gguf');
    expect(kev).toMatchObject({
      provider: LOCAL_KEY,
      name: 'Kev 4B',
      providerName: '本地决策模型',
      api: 'typesafe-system-one',
      apiLabel: 'System One',
      contextWindow: 262144,
      supportsImage: false,
      available: true,
      custom: true
    });
  });

  it('未鉴权的 provider 标为不可用且非自定义', async () => {
    setup(makeRuntime().runtime);
    const { models } = await invoke('pi:getClassifierModels');
    const orphan = models.find((m: any) => m.provider === 'orphan');
    expect(orphan.available).toBe(false);
    expect(orphan.custom).toBe(false);
    // 未知协议回落到协议原名
    expect(orphan.apiLabel).toBe('llama.cpp chat 模型');
  });

  it('input 含 image 时 supportsImage 为 true', async () => {
    setup(makeRuntime().runtime);
    const { models } = await invoke('pi:getClassifierModels');
    expect(models.find((m: any) => m.id === 'vision-cls').supportsImage).toBe(true);
  });

  it('getAvailableOfType 抛错时全部标为不可用但不崩', async () => {
    setup(
      makeRuntime({
        getAvailableOfType: async () => {
          throw new Error('credential boom');
        }
      }).runtime
    );
    const { models } = await invoke('pi:getClassifierModels');
    expect(models).toHaveLength(3);
    expect(models.every((m: any) => m.available === false)).toBe(true);
  });

  it('getModelsOfType 抛错时返回空清单', async () => {
    setup(
      makeRuntime({
        getModelsOfType: () => {
          throw new Error('boom');
        }
      }).runtime
    );
    expect((await invoke('pi:getClassifierModels')).models).toEqual([]);
  });
});

describe('validateQuestions', () => {
  it('空对象报错', () => {
    expect(validateQuestions({})).toContain('至少需要定义一个问题');
  });

  it('接受三种合法类型', () => {
    expect(
      validateQuestions({
        a: { type: 'choice', instructions: 'x', criteria: { p: '1', q: '2' } },
        b: { type: 'score', instructions: 'y', criteria: ['低', '高'] },
        c: { type: 'bool', instructions: 'z', criteria: { true: '1', false: '0' } }
      })
    ).toBeNull();
  });

  it('choice 少于 2 个标签报错', () => {
    expect(
      validateQuestions({ a: { type: 'choice', instructions: 'x', criteria: { p: '1' } } })
    ).toContain('至少需要 2 个候选标签');
  });

  it('choice 缺 criteria 报错', () => {
    expect(validateQuestions({ a: { type: 'choice', instructions: 'x' } })).toContain(
      '缺少 criteria 对象'
    );
  });

  it('score 少于 2 档报错', () => {
    expect(
      validateQuestions({ a: { type: 'score', instructions: 'x', criteria: ['1'] } })
    ).toContain('至少需要 2 档');
  });

  it('score 的 criteria 必须是数组', () => {
    expect(
      validateQuestions({ a: { type: 'score', instructions: 'x', criteria: { p: '1' } } })
    ).toContain('缺少 criteria 数组');
  });

  it('bool 的 criteria 必须含 true/false 字符串', () => {
    expect(
      validateQuestions({ a: { type: 'bool', instructions: 'x', criteria: { true: '1' } } })
    ).toContain('需要 { true, false } 两个字符串');
  });

  it('未知 type 报错', () => {
    expect(validateQuestions({ a: { type: 'noul', instructions: 'x', criteria: {} } })).toContain(
      'type 非法'
    );
  });

  it('缺 instructions 报错', () => {
    expect(
      validateQuestions({ a: { type: 'bool', criteria: { true: '1', false: '0' } } })
    ).toContain('缺少 instructions');
    expect(
      validateQuestions({
        a: { type: 'bool', instructions: '   ', criteria: { true: '1', false: '0' } }
      })
    ).toContain('缺少 instructions');
  });

  it('问题定义不是对象时报错', () => {
    expect(validateQuestions({ a: 'nope' })).toContain('必须是对象');
  });
});

describe('pi:classify', () => {
  it('runtime 未就绪时报错响应', async () => {
    setup(null);
    const result = await invoke('pi:classify', {
      provider: 'p',
      id: 'i',
      state: {},
      questions: {}
    });
    expect(result).toMatchObject({ stopReason: 'error', errorMessage: '模型运行时尚未就绪' });
  });

  it('缺 provider/id 时报错', async () => {
    setup(makeRuntime().runtime);
    expect(
      await invoke('pi:classify', { provider: '', id: '', state: {}, questions: {} })
    ).toMatchObject({ errorMessage: '缺少 provider 或模型 id' });
  });

  it('state 不是对象时报错', async () => {
    setup(makeRuntime().runtime);
    expect(
      await invoke('pi:classify', { provider: 'p', id: 'i', state: 'x', questions: {} })
    ).toMatchObject({ errorMessage: 'state 必须是 JSON 对象' });
  });

  it('questions 非法时报错且不调用 runtime', async () => {
    const { runtime, classifyCalls } = makeRuntime();
    setup(runtime);
    const result = await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: { a: 1 },
      questions: { q: { type: 'bool', instructions: 'x', criteria: { true: '1' } } }
    });
    expect(result.errorMessage).toContain('需要 { true, false } 两个字符串');
    expect(classifyCalls).toHaveLength(0);
  });

  it('模型不存在时报错', async () => {
    setup(makeRuntime().runtime);
    const result = await invoke('pi:classify', {
      provider: 'nope',
      id: 'nope',
      state: {},
      questions: VALID_QUESTIONS
    });
    expect(result.errorMessage).toBe('未找到决策模型：nope/nope');
  });

  it('成功时透传答案与 usage', async () => {
    const { runtime } = makeRuntime();
    setup(runtime);
    const result = await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: { message: '好' },
      questions: VALID_QUESTIONS
    });
    expect(result).toMatchObject({
      provider: LOCAL_KEY,
      model: './Kev-4B-Q4_K_M.gguf',
      stopReason: 'stop',
      api: 'typesafe-system-one',
      usage: { input: 10, output: 0 }
    });
    expect(result.answers.approved.probability).toBe(0.9);
  });

  it('只把正数 timeoutMs / temperature 透传给 classify', async () => {
    const { runtime, classifyCalls } = makeRuntime();
    setup(runtime);
    await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: {},
      questions: VALID_QUESTIONS,
      timeoutMs: 0,
      temperature: -1
    });
    expect(classifyCalls[0].options).toEqual({});

    await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: {},
      questions: VALID_QUESTIONS,
      timeoutMs: 5000,
      temperature: 2
    });
    expect(classifyCalls[1].options).toEqual({ timeoutMs: 5000, temperature: 2 });
  });

  it('classify 抛错时转成错误响应（不向上抛）', async () => {
    setup(
      makeRuntime({
        classify: async () => {
          throw new Error('network down');
        }
      }).runtime
    );
    const result = await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: {},
      questions: VALID_QUESTIONS
    });
    expect(result).toMatchObject({
      stopReason: 'error',
      errorMessage: 'network down',
      answers: {}
    });
  });

  it('classify 返回 error stopReason 时原样透出', async () => {
    setup(
      makeRuntime({
        classify: async () => ({
          provider: LOCAL_KEY,
          model: 'm',
          answers: {},
          stopReason: 'error',
          errorMessage: 'upstream 500',
          timestamp: 7
        })
      }).runtime
    );
    const result = await invoke('pi:classify', {
      provider: LOCAL_KEY,
      id: './Kev-4B-Q4_K_M.gguf',
      state: {},
      questions: VALID_QUESTIONS
    });
    expect(result).toMatchObject({ stopReason: 'error', errorMessage: 'upstream 500' });
  });
});

describe('pi:getClassifierProviders', () => {
  it('返回配置、路径与协议列表，并顺带重新注册', async () => {
    writeProviders({
      [LOCAL_KEY]: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'typesafe-system-one',
        models: [{ id: 'x' }]
      }
    });
    const { runtime, registered } = makeRuntime();
    setup(runtime);

    const result = await invoke('pi:getClassifierProviders');
    expect(result.path).toBe(classifiersPath);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].key).toBe(LOCAL_KEY);
    expect(result.apiKinds).toEqual(['typesafe-system-one', 'llama-cpp-classify']);
    expect(result.defaultContextWindow).toBe(32768);
    expect(result.errors).toEqual([]);
    expect(registered.has(LOCAL_KEY)).toBe(true);
  });

  it('注册失败时把错误收集到 errors，不影响返回配置', async () => {
    writeProviders({
      bad: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'typesafe-system-one',
        models: [{ id: 'x' }]
      }
    });
    setup(
      makeRuntime({
        registerProvider: () => {
          throw new Error('register boom');
        }
      }).runtime
    );
    const result = await invoke('pi:getClassifierProviders');
    expect(result.errors).toEqual([{ key: 'bad', message: 'register boom' }]);
    expect(result.providers).toHaveLength(1);
  });
});

describe('pi:saveClassifierProvider', () => {
  it('缺 key 时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(await invoke('pi:saveClassifierProvider', {})).toEqual({
      ok: false,
      error: '缺少 provider key'
    });
  });

  it('缺 baseUrl 时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(
      await invoke('pi:saveClassifierProvider', { ...VALID_PROVIDER_PAYLOAD, baseUrl: '  ' })
    ).toEqual({ ok: false, error: '缺少 baseUrl' });
  });

  it('未知协议时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(
      await invoke('pi:saveClassifierProvider', { ...VALID_PROVIDER_PAYLOAD, api: 'nope' })
    ).toEqual({ ok: false, error: '不支持的决策模型协议：nope' });
  });

  it('没有模型时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(
      await invoke('pi:saveClassifierProvider', { ...VALID_PROVIDER_PAYLOAD, models: [] })
    ).toEqual({ ok: false, error: '至少需要一个模型' });
  });

  it('注册失败时不落盘', async () => {
    setup(
      makeRuntime({
        registerProvider: () => {
          throw new Error('no api specified');
        }
      }).runtime
    );
    const result = await invoke('pi:saveClassifierProvider', VALID_PROVIDER_PAYLOAD);
    expect(result).toEqual({ ok: false, error: 'no api specified' });
    expect(fs.existsSync(classifiersPath)).toBe(false);
  });

  it('成功时注册并落盘，且做 trim', async () => {
    const { runtime, registered } = makeRuntime();
    setup(runtime);

    const result = await invoke('pi:saveClassifierProvider', {
      key: '  new-endpoint  ',
      name: '  新端点  ',
      baseUrl: '  http://127.0.0.1:8080/v1  ',
      api: 'typesafe-system-one',
      models: [{ id: '  m1  ', contextWindow: 1024.7 }]
    });
    expect(result).toEqual({ ok: true, key: 'new-endpoint' });
    expect(registered.has('new-endpoint')).toBe(true);
    expect(readClassifierConfig().providers['new-endpoint']).toEqual({
      key: 'new-endpoint',
      name: '新端点',
      baseUrl: 'http://127.0.0.1:8080/v1',
      api: 'typesafe-system-one',
      models: [{ id: 'm1', contextWindow: 1024 }]
    });
  });

  it('剔除空 id 的模型；全空则拒绝', async () => {
    const { runtime } = makeRuntime();
    setup(runtime);
    expect(
      await invoke('pi:saveClassifierProvider', {
        ...VALID_PROVIDER_PAYLOAD,
        models: [{ id: '  ' }, { name: 'x' }]
      })
    ).toEqual({ ok: false, error: '至少需要一个模型' });
  });

  it('runtime 未就绪时仍可落盘（只跳过注册）', async () => {
    setup(null);
    expect(await invoke('pi:saveClassifierProvider', VALID_PROVIDER_PAYLOAD)).toEqual({
      ok: true,
      key: 'new-endpoint'
    });
    expect(readClassifierConfig().providers['new-endpoint']).toBeDefined();
  });
});

describe('pi:removeClassifierProvider', () => {
  it('缺 key 时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(await invoke('pi:removeClassifierProvider', '  ')).toEqual({
      ok: false,
      error: '缺少 provider key'
    });
  });

  it('注销并从磁盘删除', async () => {
    writeProviders({
      [LOCAL_KEY]: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'typesafe-system-one',
        models: [{ id: 'x' }]
      }
    });
    const { runtime, unregistered } = makeRuntime();
    setup(runtime);

    expect(await invoke('pi:removeClassifierProvider', LOCAL_KEY)).toEqual({ ok: true });
    expect(unregistered).toEqual([LOCAL_KEY]);
    expect(readClassifierConfig().providers).toEqual({});
  });

  it('unregister 抛错时忽略，仍删除磁盘配置', async () => {
    writeProviders({
      [LOCAL_KEY]: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'typesafe-system-one',
        models: [{ id: 'x' }]
      }
    });
    setup(
      makeRuntime({
        unregisterProvider: () => {
          throw new Error('not registered');
        }
      }).runtime
    );
    expect((await invoke('pi:removeClassifierProvider', LOCAL_KEY)).ok).toBe(true);
    expect(readClassifierConfig().providers).toEqual({});
  });
});

describe('pi:fetchClassifierModels', () => {
  function stubFetch(payload: unknown, ok = true, status = 200) {
    const calls: { url: string; headers: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url, headers: init?.headers });
      return { ok, status, json: async () => payload };
    });
    return calls;
  }

  it('缺 baseUrl 时拒绝', async () => {
    setup(makeRuntime().runtime);
    expect(await invoke('pi:fetchClassifierModels', '  ')).toEqual({
      ok: false,
      models: [],
      error: '缺少 baseUrl'
    });
  });

  it('优先读 OpenAI 风格 data，并提取 n_ctx / output_modalities', async () => {
    const calls = stubFetch({
      models: [{ id: 'ignored' }],
      data: [
        {
          id: './Kev-4B-Q4_K_M.gguf',
          architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
          meta: { n_ctx: 262144 }
        }
      ]
    });
    setup(makeRuntime().runtime);

    const result = await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/models');
    expect(result).toEqual({
      ok: true,
      models: [
        {
          id: './Kev-4B-Q4_K_M.gguf',
          contextWindow: 262144,
          nativeDecisions: true,
          supportsImage: false
        }
      ]
    });
  });

  it('baseUrl 不以 /v1 结尾时补全为 /v1/models', async () => {
    const calls = stubFetch({ data: [] });
    setup(makeRuntime().runtime);
    await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/models');
  });

  it('已是 /models 结尾时不再改写', async () => {
    const calls = stubFetch({ data: [] });
    setup(makeRuntime().runtime);
    await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1/models');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/models');
  });

  it('兼容 Ollama 风格 models 与 model/name 字段', async () => {
    stubFetch({ models: [{ model: './a.gguf' }, { name: './b.gguf' }] });
    setup(makeRuntime().runtime);
    const result = await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1');
    expect(result.models.map((m: any) => m.id)).toEqual(['./a.gguf', './b.gguf']);
  });

  it('带 apiKey 时加 Bearer 头', async () => {
    const calls = stubFetch({ data: [] });
    setup(makeRuntime().runtime);
    await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1', 'sk-x');
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer sk-x' });
  });

  it('HTTP 错误时返回状态码', async () => {
    stubFetch({}, false, 401);
    setup(makeRuntime().runtime);
    expect(await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1')).toEqual({
      ok: false,
      models: [],
      error: 'HTTP 401'
    });
  });

  it('网络异常时把错误转成字符串', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    setup(makeRuntime().runtime);
    expect(await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1')).toEqual({
      ok: false,
      models: [],
      error: 'ECONNREFUSED'
    });
  });

  it('跳过没有 id 的畸形条目', async () => {
    stubFetch({ data: [{ name: '' }, null, { id: 'ok' }] });
    setup(makeRuntime().runtime);
    expect((await invoke('pi:fetchClassifierModels', 'http://127.0.0.1:8080/v1')).models).toEqual([
      { id: 'ok' }
    ]);
  });
});
