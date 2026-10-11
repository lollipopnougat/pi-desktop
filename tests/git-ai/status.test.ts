/**
 * git-ai 二进制探测单测：设置页「检测结果」行的数据来源。
 *
 * 只锁两件事：拿不到二进制时不得抛错（设置页打开不能炸），以及版本解析规则。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectGitAi, parseVersion } from '../../electron/git-ai/status';
import { writeGitAiConfig } from '../../electron/git-ai/config';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ai-status-'));
  process.env.PI_GIT_AI_CONFIG = path.join(dir, 'git-ai.json');
  delete process.env.PI_DESKTOP_GIT_AI_BIN;
});

afterEach(() => {
  delete process.env.PI_GIT_AI_CONFIG;
  delete process.env.PI_DESKTOP_GIT_AI_BIN;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseVersion', () => {
  it('解析纯版本号与带前缀/后缀的写法', () => {
    expect(parseVersion('1.7.5\n')).toBe('1.7.5');
    expect(parseVersion('git-ai 1.7.5')).toBe('1.7.5');
    expect(parseVersion('v1.8.0-rc.1 (build 42)')).toBe('1.8.0-rc.1');
  });

  it('认不出 semver 时返回 null（不把原文当版本号）', () => {
    expect(parseVersion('--version')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('detectGitAi', () => {
  it('二进制不存在时不抛错，版本为 null，仍返回可展示的路径信息', async () => {
    const missing = path.join(dir, 'nope', 'git-ai');
    writeGitAiConfig({ binPath: missing });

    const status = await detectGitAi();

    expect(status.bin).toBe(missing);
    expect(status.source).toBe('config');
    expect(status.version).toBeNull();
    expect(status.configPath).toBe(path.join(dir, 'git-ai.json'));
    expect(status.installedPath).toContain('.git-ai');
    expect(status.envValue).toBeNull();
  });

  it('环境变量来源会在状态里回显（设置页据此提示「此处填写的路径优先」）', async () => {
    process.env.PI_DESKTOP_GIT_AI_BIN = '/opt/git-ai/bin/git-ai';

    const status = await detectGitAi();

    expect(status.source).toBe('env');
    expect(status.envValue).toBe('/opt/git-ai/bin/git-ai');
    // 自动探测（忽略设置页路径）的结果同样是环境变量
    expect(status.autoSource).toBe('env');
  });

  // Windows 上造不出可执行的 shell 脚本，跳过真实 spawn 断言
  it.skipIf(process.platform === 'win32')('读取 --version 输出并解析出版本号', async () => {
    const fake = path.join(dir, 'git-ai');
    fs.writeFileSync(fake, '#!/bin/sh\necho "1.7.5"\n', { mode: 0o755 });
    process.env.PI_DESKTOP_GIT_AI_BIN = fake;

    const status = await detectGitAi();

    expect(status.version).toBe('1.7.5');
    expect(status.bin).toBe(fake);
  });
});
