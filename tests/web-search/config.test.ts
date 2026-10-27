/**
 * 网络搜索配置读写单测（~/.pi-desktop/web-search.json）。
 *
 * 关键约束：磁盘值损坏/越界一律回退默认值（不能抛错，否则工具每次执行都会炸）；
 * 默认必须「开箱即用」——enabled=true + provider='auto'，不需要任何配置。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CACHE_TTL_MAX,
  DEFAULT_WEB_SEARCH_CONFIG,
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  getWebSearchConfigPath,
  normalizeBaseUrl,
  normalizeWebSearchConfig,
  readWebSearchConfig,
  writeWebSearchConfig
} from '../../electron/web-search/config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-config-'));
  file = path.join(dir, 'nested', 'web-search.json');
  process.env.PI_WEB_SEARCH_CONFIG = file;
});

afterEach(() => {
  delete process.env.PI_WEB_SEARCH_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeWebSearchConfig', () => {
  it('非法输入回退默认值', () => {
    expect(normalizeWebSearchConfig(null)).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
    expect(normalizeWebSearchConfig('nope')).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
    expect(normalizeWebSearchConfig({})).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
    expect(
      normalizeWebSearchConfig({
        enabled: 'yes',
        provider: 'google',
        searxngBaseUrl: 42,
        maxResults: 'many',
        timeoutMs: null,
        cacheTtlSeconds: {}
      })
    ).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
  });

  it('默认配置是开箱即用（开 + auto）', () => {
    expect(DEFAULT_WEB_SEARCH_CONFIG.enabled).toBe(true);
    expect(DEFAULT_WEB_SEARCH_CONFIG.provider).toBe('auto');
    expect(DEFAULT_WEB_SEARCH_CONFIG.searxngBaseUrl).toBe('');
  });

  it('数值越界被夹住', () => {
    const low = normalizeWebSearchConfig({
      maxResults: -3,
      timeoutMs: 1,
      cacheTtlSeconds: -1
    });
    expect(low.maxResults).toBe(MAX_RESULTS_MIN);
    expect(low.timeoutMs).toBe(TIMEOUT_MIN);
    expect(low.cacheTtlSeconds).toBe(0);

    const high = normalizeWebSearchConfig({
      maxResults: 999,
      timeoutMs: 10 * 60 * 1000,
      cacheTtlSeconds: 10 * 60 * 60
    });
    expect(high.maxResults).toBe(MAX_RESULTS_MAX);
    expect(high.timeoutMs).toBe(TIMEOUT_MAX);
    expect(high.cacheTtlSeconds).toBe(CACHE_TTL_MAX);
  });

  it('小数四舍五入成整数', () => {
    expect(normalizeWebSearchConfig({ maxResults: 7.6 }).maxResults).toBe(8);
  });

  it('provider 只接受白名单取值', () => {
    expect(normalizeWebSearchConfig({ provider: 'searxng' }).provider).toBe('searxng');
    expect(normalizeWebSearchConfig({ provider: 'auto' }).provider).toBe('auto');
    expect(normalizeWebSearchConfig({ provider: 'duckduckgo' }).provider).toBe('auto');
  });
});

describe('normalizeBaseUrl', () => {
  it('去空白与结尾斜杠，只接受 http(s)', () => {
    expect(normalizeBaseUrl('  https://s.example.com/  ')).toBe('https://s.example.com');
    expect(normalizeBaseUrl('http://localhost:8080///')).toBe('http://localhost:8080');
    expect(normalizeBaseUrl('ftp://x')).toBe('');
    expect(normalizeBaseUrl('s.example.com')).toBe('');
    expect(normalizeBaseUrl(undefined)).toBe('');
  });
});

describe('readWebSearchConfig / writeWebSearchConfig', () => {
  it('文件不存在时返回默认值', () => {
    expect(readWebSearchConfig()).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
  });

  it('损坏的 JSON 回退默认值', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf-8');
    expect(readWebSearchConfig()).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
  });

  it('增量写入并重新读出（未知字段被丢弃）', () => {
    const saved = writeWebSearchConfig({
      enabled: false,
      provider: 'bing',
      maxResults: 12,
      // @ts-expect-error 未知字段应被白名单过滤
      somethingElse: true
    });
    expect(saved.enabled).toBe(false);
    expect(saved.provider).toBe('bing');
    expect(saved.maxResults).toBe(12);
    // 未提交的字段保持默认
    expect(saved.timeoutMs).toBe(DEFAULT_WEB_SEARCH_CONFIG.timeoutMs);
    expect(readWebSearchConfig()).toEqual(saved);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.somethingElse).toBeUndefined();
  });

  it('多次写入是叠加而不是覆盖', () => {
    writeWebSearchConfig({ enabled: false });
    writeWebSearchConfig({ provider: 'brave' });
    const cfg = readWebSearchConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.provider).toBe('brave');
  });

  it('配置路径可被环境变量重定向', () => {
    expect(getWebSearchConfigPath()).toBe(file);
  });
});
