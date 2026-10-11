/**
 * git-ai 集成配置读写单测（~/.pi-desktop/git-ai.json）。
 *
 * 关键约束：磁盘值损坏/越界一律回退默认值（不能抛错，否则内联扩展每次事件都会炸）；
 * 写入是增量 patch，且必须落盘后重新读出（设置页据此回填）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_GIT_AI_CONFIG,
  getGitAiConfigPath,
  normalizeGitAiConfig,
  readGitAiConfig,
  writeGitAiConfig
} from '../../electron/git-ai/config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ai-config-'));
  file = path.join(dir, 'nested', 'git-ai.json');
  process.env.PI_GIT_AI_CONFIG = file;
});

afterEach(() => {
  delete process.env.PI_GIT_AI_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeGitAiConfig', () => {
  it('非法输入回退默认值', () => {
    expect(normalizeGitAiConfig(null)).toEqual(DEFAULT_GIT_AI_CONFIG);
    expect(normalizeGitAiConfig('nope')).toEqual(DEFAULT_GIT_AI_CONFIG);
    expect(normalizeGitAiConfig({})).toEqual(DEFAULT_GIT_AI_CONFIG);
    expect(normalizeGitAiConfig({ enabled: 'yes', binPath: 42, scope: 'everything' })).toEqual(
      DEFAULT_GIT_AI_CONFIG
    );
  });

  it('binPath 去空白；scope 白名单', () => {
    expect(normalizeGitAiConfig({ binPath: '  /opt/git-ai  ' }).binPath).toBe('/opt/git-ai');
    expect(normalizeGitAiConfig({ scope: 'files' }).scope).toBe('files');
    expect(normalizeGitAiConfig({ scope: 'shell' }).scope).toBe('shell');
  });
});

describe('readGitAiConfig', () => {
  it('文件不存在时返回默认值', () => {
    expect(readGitAiConfig()).toEqual(DEFAULT_GIT_AI_CONFIG);
  });

  it('文件损坏（非法 JSON）时返回默认值而不抛错', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf-8');
    expect(readGitAiConfig()).toEqual(DEFAULT_GIT_AI_CONFIG);
  });

  it('未知字段被丢弃，已知字段保留', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: false, nope: 1 }), 'utf-8');
    expect(readGitAiConfig()).toEqual({ ...DEFAULT_GIT_AI_CONFIG, enabled: false });
  });
});

describe('writeGitAiConfig', () => {
  it('增量写入：只改传入字段，其余保持', () => {
    writeGitAiConfig({ binPath: '/opt/git-ai/bin/git-ai' });
    const next = writeGitAiConfig({ scope: 'files' });

    expect(next).toEqual({
      ...DEFAULT_GIT_AI_CONFIG,
      binPath: '/opt/git-ai/bin/git-ai',
      scope: 'files'
    });
    // 落盘后重新读出结果一致（设置页回填依赖这一点）
    expect(readGitAiConfig()).toEqual(next);
  });

  it('自动创建父目录，并清掉未填写的路径', () => {
    writeGitAiConfig({ binPath: '/opt/git-ai/bin/git-ai' });
    expect(fs.existsSync(file)).toBe(true);
    expect(writeGitAiConfig({ binPath: '' }).binPath).toBe('');
  });

  it('忽略未知字段（不写进文件）', () => {
    writeGitAiConfig({ nope: true } as never);
    expect(Object.keys(readGitAiConfig()).sort()).toEqual(
      Object.keys(DEFAULT_GIT_AI_CONFIG).sort()
    );
  });

  it('配置文件路径可被 PI_GIT_AI_CONFIG 重定向（测试用）', () => {
    expect(getGitAiConfigPath()).toBe(file);
  });
});
