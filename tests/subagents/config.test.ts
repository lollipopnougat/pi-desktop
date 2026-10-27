/**
 * 子智能体配置读写单测（~/.pi-desktop/subagents.json）。
 *
 * 关键约束：磁盘值损坏/类型不对一律回退默认值（不能抛错，否则建会话时同步
 * task 工具可见性会炸）；写入是增量 patch，且必须落盘后重新读出（设置页据此回填）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_SUBAGENT_CONFIG,
  getSubagentConfigPath,
  normalizeSubagentConfig,
  readSubagentConfig,
  writeSubagentConfig
} from '../../electron/subagents/config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-config-'));
  file = path.join(dir, 'nested', 'subagents.json');
  process.env.PI_SUBAGENT_CONFIG = file;
});

afterEach(() => {
  delete process.env.PI_SUBAGENT_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeSubagentConfig', () => {
  it('非法输入回退默认值', () => {
    expect(normalizeSubagentConfig(null)).toEqual(DEFAULT_SUBAGENT_CONFIG);
    expect(normalizeSubagentConfig('nope')).toEqual(DEFAULT_SUBAGENT_CONFIG);
    expect(normalizeSubagentConfig({})).toEqual(DEFAULT_SUBAGENT_CONFIG);
    expect(normalizeSubagentConfig({ enabled: 'yes' })).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  it('默认开启：与改造前的行为一致', () => {
    expect(DEFAULT_SUBAGENT_CONFIG.enabled).toBe(true);
  });

  it('已知字段保留', () => {
    expect(normalizeSubagentConfig({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('readSubagentConfig', () => {
  it('文件不存在时返回默认值', () => {
    expect(readSubagentConfig()).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  it('文件损坏（非法 JSON）时返回默认值而不抛错', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf-8');
    expect(readSubagentConfig()).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  it('未知字段被丢弃，已知字段保留', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: false, nope: 1 }), 'utf-8');
    expect(readSubagentConfig()).toEqual({ enabled: false });
  });
});

describe('writeSubagentConfig', () => {
  it('增量写入并落盘后重新读出', () => {
    const next = writeSubagentConfig({ enabled: false });
    expect(next).toEqual({ enabled: false });
    // 设置页回填依赖「写后重读」
    expect(readSubagentConfig()).toEqual(next);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('只改一处时其余字段保持默认', () => {
    const next = writeSubagentConfig({});
    expect(next).toEqual(DEFAULT_SUBAGENT_CONFIG);
  });

  it('配置文件路径可经环境变量重定向', () => {
    expect(getSubagentConfigPath()).toBe(file);
  });
});
