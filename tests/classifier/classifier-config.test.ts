import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// config-dir 在模块加载时就会写入 PI_CODING_AGENT_DIR，因此必须先 mock 再导入被测模块
const { tmpDir, classifiersPath } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-classifier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir, classifiersPath: join(dir, 'classifiers.json') };
});

vi.mock('../../electron/config-dir', () => ({
  DESKTOP_AGENT_DIR: tmpDir
}));

import {
  readClassifierConfig,
  saveClassifierProvider,
  removeClassifierProvider,
  normalizeClassifierProvider,
  getClassifierConfigPath,
  emptyClassifierConfig,
  CLASSIFIER_API_KINDS,
  DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
  type ClassifierProviderConfig
} from '../../electron/classifier-config';

const validProvider: ClassifierProviderConfig = {
  key: 'local-llama-classifier',
  name: '本地决策模型',
  baseUrl: 'http://127.0.0.1:8080/v1',
  api: 'typesafe-system-one',
  models: [{ id: './Kev-4B-Q4_K_M.gguf', name: 'Kev 4B', contextWindow: 262144 }]
};

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('常量', () => {
  it('协议白名单只有两种自定义端点协议', () => {
    expect([...CLASSIFIER_API_KINDS]).toEqual(['typesafe-system-one', 'llama-cpp-classify']);
  });

  it('默认上下文窗口为 32768', () => {
    expect(DEFAULT_CLASSIFIER_CONTEXT_WINDOW).toBe(32768);
  });

  it('配置文件路径固定在 classifiers.json', () => {
    expect(getClassifierConfigPath()).toBe(classifiersPath);
  });
});

describe('normalizeClassifierProvider', () => {
  it('接受合法配置', () => {
    const result = normalizeClassifierProvider('local-llama-classifier', validProvider);
    expect(result).toEqual(validProvider);
  });

  it('key 以记录键为准，覆盖条目里的 key 并 trim', () => {
    const result = normalizeClassifierProvider('  from-record  ', validProvider);
    expect(result?.key).toBe('from-record');
  });

  it('key 为空白时返回 null', () => {
    expect(normalizeClassifierProvider('   ', validProvider)).toBeNull();
  });

  it('缺 baseUrl 时返回 null', () => {
    expect(normalizeClassifierProvider('local', { ...validProvider, baseUrl: '' })).toBeNull();
  });

  it('未知协议返回 null', () => {
    expect(
      normalizeClassifierProvider('local', { ...validProvider, api: 'openai-decisions' })
    ).toBeNull();
  });

  it('models 为空返回 null', () => {
    expect(normalizeClassifierProvider('local', { ...validProvider, models: [] })).toBeNull();
  });

  it('剔除掉没有 id 的模型条目', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [{ id: 'keep' }, { id: '   ' }, { name: 'no-id' }, null]
    });
    expect(result?.models).toEqual([{ id: 'keep' }]);
  });

  it('全部模型非法时返回 null', () => {
    expect(
      normalizeClassifierProvider('local', { ...validProvider, models: [{ id: '' }] })
    ).toBeNull();
  });

  it('过滤非 text/image 的输入模态', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [{ id: 'm', input: ['text', 'audio', 'image'] }]
    });
    expect(result?.models[0].input).toEqual(['text', 'image']);
  });

  it('剔除空 input 数组（避免写回非法值）', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [{ id: 'm', input: [] }]
    });
    expect(result?.models[0].input).toBeUndefined();
  });

  it('contextWindow 非正数时丢弃', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [
        { id: 'm', contextWindow: 0 },
        { id: 'n', contextWindow: -5 },
        { id: 'o', contextWindow: 1024 }
      ]
    });
    expect(result?.models[0].contextWindow).toBeUndefined();
    expect(result?.models[1].contextWindow).toBeUndefined();
    expect(result?.models[2].contextWindow).toBe(1024);
  });

  it('cost 缺 input/output 时整块丢弃', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [{ id: 'm', cost: { cacheRead: 1 } }]
    });
    expect(result?.models[0].cost).toBeUndefined();
  });

  it('cost 只给一半时另一半补 0', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      models: [{ id: 'm', cost: { input: 1.5 } }]
    });
    expect(result?.models[0].cost).toEqual({ input: 1.5, output: 0 });
  });

  it('过滤 headers 里的非字符串值', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      headers: { 'X-A': 'ok', 'X-B': 123, 'X-C': null }
    });
    expect(result?.headers).toEqual({ 'X-A': 'ok' });
  });

  it('headers 全非法时该字段消失', () => {
    const result = normalizeClassifierProvider('local', {
      ...validProvider,
      headers: { 'X-B': 1 }
    });
    expect(result?.headers).toBeUndefined();
  });

  it('apiKey 为空白时不保留', () => {
    const result = normalizeClassifierProvider('local', { ...validProvider, apiKey: '  ' });
    expect(result?.apiKey).toBeUndefined();
  });
});

describe('readClassifierConfig', () => {
  it('文件不存在时返回空配置', () => {
    expect(readClassifierConfig()).toEqual(emptyClassifierConfig());
  });

  it('JSON 损坏时返回空配置且不删文件', () => {
    fs.writeFileSync(classifiersPath, '{ this is not json', 'utf-8');
    expect(readClassifierConfig()).toEqual(emptyClassifierConfig());
    expect(fs.existsSync(classifiersPath)).toBe(true);
  });

  it('providers 不是对象时返回空配置', () => {
    fs.writeFileSync(classifiersPath, JSON.stringify({ providers: [] }), 'utf-8');
    expect(readClassifierConfig()).toEqual(emptyClassifierConfig());
  });

  it('损坏条目被跳过，合法条目保留', () => {
    fs.writeFileSync(
      classifiersPath,
      JSON.stringify({
        providers: {
          broken: { baseUrl: '', api: 'typesafe-system-one', models: [] },
          good: validProvider
        }
      }),
      'utf-8'
    );
    const cfg = readClassifierConfig();
    expect(Object.keys(cfg.providers)).toEqual(['good']);
    expect(cfg.providers.good).toEqual({ ...validProvider, key: 'good' });
  });

  it('归一化读出的值（不写回磁盘）', () => {
    fs.writeFileSync(
      classifiersPath,
      JSON.stringify({
        providers: {
          local: {
            baseUrl: 'http://127.0.0.1:8080/v1',
            api: 'typesafe-system-one',
            apiKey: '  ',
            unknownField: 'ignored',
            models: [{ id: 'm', input: [] }]
          }
        }
      }),
      'utf-8'
    );
    const provider = readClassifierConfig().providers.local;
    expect(provider.apiKey).toBeUndefined();
    expect(provider.models[0].input).toBeUndefined();
    expect('unknownField' in provider).toBe(false);
  });
});

describe('saveClassifierProvider / removeClassifierProvider', () => {
  it('写入后能读回', () => {
    saveClassifierProvider(validProvider);
    expect(readClassifierConfig().providers['local-llama-classifier']).toEqual(validProvider);
  });

  it('同名 key 覆盖而非追加', () => {
    saveClassifierProvider(validProvider);
    saveClassifierProvider({ ...validProvider, baseUrl: 'http://127.0.0.1:9999/v1' });
    const cfg = readClassifierConfig();
    expect(Object.keys(cfg.providers)).toEqual(['local-llama-classifier']);
    expect(cfg.providers['local-llama-classifier'].baseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  it('目录不存在时自动创建', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    saveClassifierProvider(validProvider);
    expect(fs.existsSync(classifiersPath)).toBe(true);
  });

  it('保留文件里的未知顶层字段', () => {
    fs.writeFileSync(classifiersPath, JSON.stringify({ version: 1, providers: {} }), 'utf-8');
    saveClassifierProvider(validProvider);
    const raw = JSON.parse(fs.readFileSync(classifiersPath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.providers)).toEqual(['local-llama-classifier']);
  });

  it('文件损坏时重建成只有 providers 的结构', () => {
    fs.writeFileSync(classifiersPath, 'garbage', 'utf-8');
    saveClassifierProvider(validProvider);
    const raw = JSON.parse(fs.readFileSync(classifiersPath, 'utf-8'));
    expect(Object.keys(raw.providers)).toEqual(['local-llama-classifier']);
  });

  it('remove 返回 true 并删除条目', () => {
    saveClassifierProvider(validProvider);
    expect(removeClassifierProvider('local-llama-classifier')).toBe(true);
    expect(readClassifierConfig().providers).toEqual({});
  });

  it('remove 不存在的 key 返回 false 且不写盘', () => {
    saveClassifierProvider(validProvider);
    const before = fs.readFileSync(classifiersPath, 'utf-8');
    expect(removeClassifierProvider('nope')).toBe(false);
    expect(fs.readFileSync(classifiersPath, 'utf-8')).toBe(before);
  });

  it('写入为 2 空格缩进的 JSON', () => {
    saveClassifierProvider(validProvider);
    const raw = fs.readFileSync(classifiersPath, 'utf-8');
    expect(raw).toContain('\n  "providers"');
  });
});
