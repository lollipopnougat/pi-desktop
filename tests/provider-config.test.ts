import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
// path and os are used via require() inside vi.hoisted, not as imports

// Use vi.hoisted to create temp dir before vi.mock calls are hoisted
// Cannot use `path`/`os` inside vi.hoisted (they're hoisted imports), so use require
const { tmpDir, modelsPath, authPath } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-pc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return {
    tmpDir: dir,
    modelsPath: join(dir, 'models.json'),
    authPath: join(dir, 'auth.json')
  };
});

// Mock config-dir to use temp dir — must match the import path used by provider-config.ts
vi.mock('./../electron/config-dir', () => ({
  DESKTOP_AGENT_DIR: tmpDir
}));

import {
  readProviderConfig,
  saveProviderConfig,
  removeProviderConfig,
  getModelsPath,
  getAuthPath,
  getAgentDir,
  getSessionDir,
  persistBuiltinApiKey,
  deleteBuiltinApiKey,
  readBuiltinApiKey,
  fetchOpenAiModels,
  type ProviderConfig
} from '../../electron/provider-config';

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── readProviderConfig ───

describe('provider-config — readProviderConfig', () => {
  it('returns empty providers when file does not exist', () => {
    const config = readProviderConfig();
    expect(config.providers).toEqual({});
  });

  it('returns empty providers when file is corrupted', () => {
    fs.writeFileSync(modelsPath, 'not valid json', 'utf-8');
    const config = readProviderConfig();
    expect(config.providers).toEqual({});
  });

  it('reads providers from file', () => {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com', api: 'openai' }
        }
      }),
      'utf-8'
    );
    const config = readProviderConfig();
    expect(config.providers.openai).toBeDefined();
    expect(config.providers.openai.name).toBe('OpenAI');
  });

  it('excludes specified keys', () => {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: { name: 'OpenAI' },
          anthropic: { name: 'Anthropic' },
          local: { name: 'Local' }
        }
      }),
      'utf-8'
    );
    const config = readProviderConfig(['anthropic']);
    expect(config.providers.openai).toBeDefined();
    expect(config.providers.anthropic).toBeUndefined();
    expect(config.providers.local).toBeDefined();
  });

  it('excludes multiple keys', () => {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          a: { name: 'A' },
          b: { name: 'B' },
          c: { name: 'C' }
        }
      }),
      'utf-8'
    );
    const config = readProviderConfig(['a', 'c']);
    expect(config.providers.a).toBeUndefined();
    expect(config.providers.b).toBeDefined();
    expect(config.providers.c).toBeUndefined();
  });
});

// ─── saveProviderConfig / removeProviderConfig ───

describe('provider-config — saveProviderConfig', () => {
  it('saves a new provider', async () => {
    const config: ProviderConfig = {
      key: 'test-provider',
      name: 'Test',
      baseUrl: 'https://api.test.com',
      api: 'openai',
      models: [{ id: 'gpt-4' }]
    };
    await saveProviderConfig(config);
    const read = readProviderConfig();
    expect(read.providers['test-provider']).toBeDefined();
    expect(read.providers['test-provider'].name).toBe('Test');
    expect(read.providers['test-provider'].models[0].id).toBe('gpt-4');
  });

  it('updates an existing provider', async () => {
    await saveProviderConfig({
      key: 'provider',
      name: 'Old',
      baseUrl: 'https://old.api.com',
      api: 'openai',
      models: [{ id: 'v1' }]
    });
    await saveProviderConfig({
      key: 'provider',
      name: 'New',
      baseUrl: 'https://new.api.com',
      api: 'openai',
      models: [{ id: 'v2' }]
    });
    const read = readProviderConfig();
    expect(read.providers['provider'].name).toBe('New');
    expect(read.providers['provider'].models[0].id).toBe('v2');
  });

  it('omits apiKey when not provided', async () => {
    await saveProviderConfig({
      key: 'no-key',
      baseUrl: 'https://api.test.com',
      api: 'openai',
      models: []
    });
    const read = readProviderConfig();
    expect(read.providers['no-key'].apiKey).toBeUndefined();
  });

  it('includes apiKey when provided', async () => {
    await saveProviderConfig({
      key: 'with-key',
      baseUrl: 'https://api.test.com',
      api: 'openai',
      apiKey: 'sk-test',
      models: []
    });
    const read = readProviderConfig();
    expect(read.providers['with-key'].apiKey).toBe('sk-test');
  });
});

describe('provider-config — removeProviderConfig', () => {
  it('removes an existing provider', async () => {
    await saveProviderConfig({
      key: 'to-remove',
      baseUrl: 'https://api.test.com',
      api: 'openai',
      models: []
    });
    await removeProviderConfig('to-remove');
    const read = readProviderConfig();
    expect(read.providers['to-remove']).toBeUndefined();
  });

  it('is a no-op for non-existent provider', async () => {
    await removeProviderConfig('nonexistent');
  });
});

// ─── Path helpers ───

describe('provider-config — path helpers', () => {
  it('getModelsPath returns the models.json path', () => {
    expect(getModelsPath()).toBe(modelsPath);
  });

  it('getAuthPath returns the auth.json path', () => {
    expect(getAuthPath()).toBe(authPath);
  });

  it('getAgentDir returns the agent dir', () => {
    expect(getAgentDir()).toBe(tmpDir);
  });
});

// ─── getSessionDir ───

describe('provider-config — getSessionDir', () => {
  it('encodes cwd into session directory path', () => {
    const dir = getSessionDir('/home/user/project');
    expect(dir).toContain('sessions');
    expect(dir).toContain('--home-user-project--');
  });

  it('strips leading slash before encoding', () => {
    const dir = getSessionDir('/foo/bar');
    expect(dir).toContain('--foo-bar--');
  });

  it('creates the session directory on disk', () => {
    const dir = getSessionDir('/test/project');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('handles backslash and colon characters in path', () => {
    // On Unix, backslashes are literal characters (not path separators).
    // The encoding regex /[/\\:]/g replaces them with dashes.
    // On Windows, backslashes are path separators and also get dashed.
    // Test with a path that has colons (platform-independent)
    const dir = getSessionDir('/test/project:special');
    expect(dir).toContain('sessions');
    expect(dir).toMatch(/--test-project-special--/);
  });

  it('produces consistent encoding for same input', () => {
    const dir1 = getSessionDir('/home/user/project');
    const dir2 = getSessionDir('/home/user/project');
    expect(dir1).toBe(dir2);
  });
});

// ─── Auth (API key persistence) ───

describe('provider-config — auth.json persistence', () => {
  it('persistBuiltinApiKey writes to auth.json', () => {
    persistBuiltinApiKey('openai', 'sk-test-key');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-test-key' });
  });

  it('persistBuiltinApiKey merges with existing entries', () => {
    persistBuiltinApiKey('openai', 'sk-key1');
    persistBuiltinApiKey('anthropic', 'sk-key2');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-key1' });
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'sk-key2' });
  });

  it('deleteBuiltinApiKey removes entry but preserves others', () => {
    persistBuiltinApiKey('openai', 'sk-key1');
    persistBuiltinApiKey('anthropic', 'sk-key2');
    deleteBuiltinApiKey('openai');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    expect(auth.openai).toBeUndefined();
    expect(auth.anthropic).toEqual({ type: 'api_key', key: 'sk-key2' });
  });

  it('deleteBuiltinApiKey is a no-op for non-existent key', () => {
    deleteBuiltinApiKey('nonexistent');
  });

  it('auth.json is written with 0600 permissions', () => {
    persistBuiltinApiKey('openai', 'sk-test');
    const stat = fs.statSync(authPath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('readBuiltinApiKey 回填已保存的 Key', () => {
    persistBuiltinApiKey('opencode-go', 'sk-opencode');
    expect(readBuiltinApiKey('opencode-go')).toBe('sk-opencode');
  });

  it('readBuiltinApiKey 未保存时返回空串', () => {
    expect(readBuiltinApiKey('opencode-go')).toBe('');
  });

  it('readBuiltinApiKey 不读 oauth 凭证（避免把 access token 当 API Key 回填）', () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({ 'some-oauth': { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 } }),
      'utf-8'
    );
    expect(readBuiltinApiKey('some-oauth')).toBe('');
  });

  it('readBuiltinApiKey 忽略非字符串 key 与空 providerId', () => {
    fs.writeFileSync(authPath, JSON.stringify({ broken: { type: 'api_key', key: 42 } }), 'utf-8');
    expect(readBuiltinApiKey('broken')).toBe('');
    expect(readBuiltinApiKey('')).toBe('');
  });

  it('readBuiltinApiKey 在 auth.json 损坏时返回空串', () => {
    fs.writeFileSync(authPath, '{ not json', 'utf-8');
    expect(readBuiltinApiKey('openai')).toBe('');
  });
});

// ─── fetchOpenAiModels ───

describe('provider-config — fetchOpenAiModels', () => {
  it('normalizes baseUrl without /v1', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }] })
    });
    globalThis.fetch = mockFetch as any;

    const result = await fetchOpenAiModels('https://api.test.com');
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0].id).toBe('gpt-4');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/v1/models');
  });

  it('normalizes baseUrl with /v1', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-3' }] })
    });
    globalThis.fetch = mockFetch as any;

    await fetchOpenAiModels('https://api.test.com/v1');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/v1/models');
  });

  it('normalizes baseUrl already ending with /models', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    });
    globalThis.fetch = mockFetch as any;

    await fetchOpenAiModels('https://api.test.com/v1/models');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/v1/models');
  });

  it('strips trailing slashes', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    });
    globalThis.fetch = mockFetch as any;

    await fetchOpenAiModels('https://api.test.com/v1/');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/v1/models');
  });

  it('includes Authorization header when apiKey is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    });
    globalThis.fetch = mockFetch as any;

    await fetchOpenAiModels('https://api.test.com', 'sk-test');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('omits Authorization header when no apiKey', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    });
    globalThis.fetch = mockFetch as any;

    await fetchOpenAiModels('https://api.test.com');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns error on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({})
    }) as any;

    const result = await fetchOpenAiModels('https://api.test.com', 'bad-key');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 401');
    expect(result.models).toEqual([]);
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

    const result = await fetchOpenAiModels('https://api.test.com');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('handles empty data array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    }) as any;

    const result = await fetchOpenAiModels('https://api.test.com');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });

  it('handles missing data field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({})
    }) as any;

    const result = await fetchOpenAiModels('https://api.test.com');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });
});
