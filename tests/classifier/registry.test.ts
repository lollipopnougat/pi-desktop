import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

const { tmpDir, classifiersPath } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-classifier-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir, classifiersPath: join(dir, 'classifiers.json') };
});

vi.mock('../../electron/config-dir', () => ({
  DESKTOP_AGENT_DIR: tmpDir
}));

import {
  applyClassifierProviders,
  buildRegisterConfig,
  registerClassifierProvider,
  unregisterClassifierProvider,
  type ClassifierRuntimeLike
} from '../../electron/classifier/registry';
import type { ClassifierProviderConfig } from '../../electron/classifier-config';

/** 假 runtime：只记录调用，不碰真 SDK */
function makeRuntime(options: { failOn?: string } = {}) {
  const calls: { providerId: string; config: any }[] = [];
  const unregistered: string[] = [];
  const runtime: ClassifierRuntimeLike = {
    registerProvider(providerId, config) {
      if (options.failOn === providerId) throw new Error(`boom: ${providerId}`);
      calls.push({ providerId, config });
    },
    unregisterProvider(providerId) {
      unregistered.push(providerId);
    }
  };
  return { runtime, calls, unregistered };
}

const baseConfig: ClassifierProviderConfig = {
  key: 'local-classifier',
  name: '本地决策模型',
  baseUrl: 'http://127.0.0.1:8080/v1',
  api: 'typesafe-system-one',
  models: [{ id: './Kev-4B-Q4_K_M.gguf', name: 'Kev 4B', contextWindow: 262144 }]
};

function writeConfig(providers: Record<string, unknown>) {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(classifiersPath, JSON.stringify({ providers }), 'utf-8');
}

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildRegisterConfig', () => {
  it('每个模型条目带 type=classifier', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect(config.models).toHaveLength(1);
    expect(config.models[0].type).toBe('classifier');
  });

  it('api 写在模型级（classifier 不继承 provider 级 api）', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect(config.models[0].api).toBe('typesafe-system-one');
  });

  it('classifiers 以协议名为键', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect(Object.keys(config.classifiers)).toEqual(['typesafe-system-one']);
    expect(typeof config.classifiers['typesafe-system-one'].classify).toBe('function');
  });

  it('llama-cpp-classify 换协议时键与模型 api 同步', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      api: 'llama-cpp-classify'
    }) as any;
    expect(Object.keys(config.classifiers)).toEqual(['llama-cpp-classify']);
    expect(config.models[0].api).toBe('llama-cpp-classify');
  });

  it('provider 级带 baseUrl 与 name', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect(config.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(config.name).toBe('本地决策模型');
  });

  it('apiKey 为空白时填占位值（classify 要求非空凭据）', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect(config.apiKey).toBe('local');
  });

  it('保留用户填的 apiKey', () => {
    const config = buildRegisterConfig({ ...baseConfig, apiKey: 'sk-real' }) as any;
    expect(config.apiKey).toBe('sk-real');
  });

  it('name 缺省时用模型 id 兜底', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      models: [{ id: 'm' }]
    }) as any;
    expect(config.models[0].name).toBe('m');
  });

  it('contextWindow 缺省时补 32768', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      models: [{ id: 'm' }]
    }) as any;
    expect(config.models[0].contextWindow).toBe(32768);
  });

  it('input 缺省时补 [text]', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      models: [{ id: 'm' }]
    }) as any;
    expect(config.models[0].input).toEqual(['text']);
  });

  it('cost 缺省时补全 0', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      models: [{ id: 'm' }]
    }) as any;
    expect(config.models[0].cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    });
  });

  it('无 headers 时不写该字段', () => {
    const config = buildRegisterConfig(baseConfig) as any;
    expect('headers' in config).toBe(false);
  });

  it('有 headers 时透传', () => {
    const config = buildRegisterConfig({
      ...baseConfig,
      headers: { 'X-Tenant': 'a' }
    }) as any;
    expect(config.headers).toEqual({ 'X-Tenant': 'a' });
  });

  it('无 name 时不写该字段', () => {
    const config = buildRegisterConfig({ ...baseConfig, name: undefined }) as any;
    expect('name' in config).toBe(false);
  });
});

describe('registerClassifierProvider / unregisterClassifierProvider', () => {
  it('用配置里的 key 注册', () => {
    const { runtime, calls } = makeRuntime();
    registerClassifierProvider(runtime, baseConfig);
    expect(calls).toHaveLength(1);
    expect(calls[0].providerId).toBe('local-classifier');
  });

  it('unregister 透传 key', () => {
    const { runtime, unregistered } = makeRuntime();
    unregisterClassifierProvider(runtime, 'local-classifier');
    expect(unregistered).toEqual(['local-classifier']);
  });
});

describe('applyClassifierProviders', () => {
  it('配置文件不存在时不注册且无错误', () => {
    const { runtime, calls } = makeRuntime();
    expect(applyClassifierProviders(runtime)).toEqual({ applied: [], errors: [] });
    expect(calls).toHaveLength(0);
  });

  it('注册全部合法 provider', () => {
    writeConfig({ a: baseConfig, b: { ...baseConfig, key: 'b' } });
    const { runtime, calls } = makeRuntime();
    const result = applyClassifierProviders(runtime);
    expect(result.applied.sort()).toEqual(['a', 'b']);
    expect(result.errors).toEqual([]);
    expect(calls.map((c) => c.providerId).sort()).toEqual(['a', 'b']);
  });

  it('单条失败不影响其余（错误记录 key 与 message）', () => {
    writeConfig({ a: baseConfig, b: { ...baseConfig, key: 'b' }, c: { ...baseConfig, key: 'c' } });
    const { runtime, calls } = makeRuntime({ failOn: 'b' });
    const result = applyClassifierProviders(runtime);
    expect(result.applied.sort()).toEqual(['a', 'c']);
    expect(result.errors).toEqual([{ key: 'b', message: 'boom: b' }]);
    expect(calls.map((c) => c.providerId).sort()).toEqual(['a', 'c']);
  });

  it('非 Error 抛出物也能转成 message', () => {
    writeConfig({ a: { ...baseConfig, key: 'a' } });
    const runtime: ClassifierRuntimeLike = {
      registerProvider() {
        throw 'plain string';
      },
      unregisterProvider() {}
    };
    expect(applyClassifierProviders(runtime).errors).toEqual([
      { key: 'a', message: 'plain string' }
    ]);
  });

  it('跳过损坏条目（normalize 阶段就该被过滤）', () => {
    writeConfig({ bad: { baseUrl: '', api: 'nope', models: [] }, good: baseConfig });
    const { runtime, calls } = makeRuntime();
    const result = applyClassifierProviders(runtime);
    expect(result.applied).toEqual(['good']);
    expect(calls).toHaveLength(1);
  });
});
