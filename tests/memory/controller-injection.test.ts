/**
 * MemoryController 注入快照测试：锁定「注入串 = 分段明细渲染结果」这一 UI 依赖不变式，
 * 以及冻结语义（会话期间不变）、空记忆整块跳过、截断元信息。
 *
 * 记忆目录走 PI_MEMORY_DIR 注入的 tmp；PiBridge 用最小 stub（controller 只用 cwd/modelRuntime）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mem-ctrl-'));
process.env.PI_MEMORY_DIR = tmpMemory;

const { MemoryController } = await import('../../electron/memory/controller');
const { writeMemoryFile, readMemoryFile } = await import('../../electron/memory/store');
const { writeMemoryConfig, projectIdentity } = await import('../../electron/memory/config');
const { writeState } = await import('../../electron/memory/pipeline');

const bridgeStub = {
  cwd: '/tmp/ctrl-proj',
  win: null,
  modelRuntime: null,
  getSession: () => null
} as never;

function newController() {
  return new MemoryController(bridgeStub);
}

function resetMemoryDir() {
  fs.rmSync(tmpMemory, { recursive: true, force: true });
  fs.mkdirSync(tmpMemory, { recursive: true });
  // 默认配置：enabled=true, userProfileCharLimit=4000
  writeMemoryConfig({
    enabled: true,
    extractModel: null,
    consolidateThreshold: 5,
    userProfileCharLimit: 4000
  });
}

beforeEach(() => {
  resetMemoryDir();
});

afterAll(() => {
  fs.rmSync(tmpMemory, { recursive: true, force: true });
});

describe('MemoryController 注入快照', () => {
  it('无画像时仍注入检索规则', () => {
    const c = newController();
    c.freezeSnapshot();
    expect(c.getInjection()).toContain('<memory-policy>');
    const info = c.getInjectionInfo();
    expect(info.active).toBe(true);
    expect(info.totalChars).toBeGreaterThan(0);
    expect(c.getStatus().injected).toBe(true);
  });

  it('有记忆时注入串与分段一致，来源/字符数正确', () => {
    writeMemoryFile('USER.md', '- 回答用中文\n');
    writeMemoryFile('STANDING.md', '- 只用 pnpm\n');

    const c = newController();
    c.freezeSnapshot();
    const injection = c.getInjection();
    expect(injection).toBeTruthy();

    const info = c.getInjectionInfo();
    expect(info.active).toBe(true);
    expect(info.totalChars).toBe(injection!.length);
    expect(c.getStatus().injection).toEqual(info);

    const byId = new Map(info.sections.map((s) => [s.id, s]));
    expect(byId.get('user-profile')!.included).toBe(true);
    expect(byId.get('user-profile')!.source).toBe('USER.md');
    expect(byId.get('user-profile')!.truncated).toBeUndefined();
    expect(byId.get('standing')!.included).toBe(true);
    expect(byId.get('standing')!.source).toBe('STANDING.md');
    expect(byId.get('policy')!.included).toBe(true);

    // markerChars = 固定头 + 尾（panel 折叠展示的那部分）
    const markers = info.sections
      .filter((s) => s.id === 'context-header' || s.id === 'context-footer')
      .reduce((n, s) => n + s.chars, 0);
    expect(info.markerChars).toBe(markers);
    expect(markers).toBeGreaterThan(0);

    // 注入串确实由分段渲染而来
    const rows = info.sections.filter((s) => s.included).map((s) => s.content);
    expect(rows.join('\n\n')).toBe(injection);
  });

  it('只填 STANDING.md 时 user-profile 标记为未注入', () => {
    writeMemoryFile('STANDING.md', '- 禁止 git push\n');
    const c = newController();
    c.freezeSnapshot();
    const byId = new Map(c.getInjectionInfo().sections.map((s) => [s.id, s]));
    expect(byId.get('standing')!.included).toBe(true);
    expect(byId.get('user-profile')!.included).toBe(false);
    expect(byId.get('user-profile')!.chars).toBe(0);
    expect(c.getInjection()).not.toContain('<user-profile>');
  });

  it('冻结后文件变化不影响本会话注入（下个会话才生效）', () => {
    writeMemoryFile('USER.md', '- 回答用中文\n');
    const c = newController();
    c.freezeSnapshot();
    const frozen = c.getInjection();

    writeMemoryFile('USER.md', '- 回答用英文\n');
    expect(c.getInjection()).toBe(frozen);
    expect(c.getInjectionInfo().sections[2].content).toContain('中文');

    // 会话切换 / 新会话重新冻结后生效
    c.onSessionSwitch();
    expect(c.getInjection()).toContain('英文');

    c.clearSnapshot();
    expect(c.getInjection()).toBeNull();
    expect(c.getInjectionInfo().active).toBe(false);
    expect(c.getInjectionInfo().frozenAt).toBeNull();
  });

  it('超过 userProfileCharLimit 时截断并透出原文长度', () => {
    const long = '- 短偏好\n- ' + '很长的画像内容'.repeat(200) + '\n';
    writeMemoryFile('USER.md', long);
    writeMemoryConfig({ userProfileCharLimit: 50 });

    const c = newController();
    c.freezeSnapshot();
    const profile = c.getInjectionInfo().sections.find((s) => s.id === 'user-profile')!;
    expect(profile.truncated).toBe(true);
    expect(profile.originalChars).toBe(readMemoryFile('USER.md').length);
    expect(c.getInjectionInfo().truncated).toBe(true);
    expect(profile.content).toContain('（注意：用户画像过长已被截断）');
  });

  it('记忆系统禁用时不构造任何注入分段', () => {
    writeMemoryFile('USER.md', '- 回答用中文\n');
    writeMemoryConfig({ enabled: false });

    const c = newController();
    c.freezeSnapshot();
    expect(c.getInjection()).toBeNull();
    const info = c.getInjectionInfo();
    expect(info.active).toBe(false);
    expect(info.sections).toHaveLength(0);
  });

  it('只有项目记忆也能发现主题，外部编辑的密钥不进入快照', () => {
    const c = newController();
    writeMemoryFile('project', '- 项目构建需要 pnpm', { projectName: c.getProjectId() });
    fs.writeFileSync(path.join(tmpMemory, 'USER.md'), '- sk-abcdefghijklmnopqrst1234');
    c.freezeSnapshot();
    expect(c.getInjection()).toContain('项目构建需要 pnpm');
    expect(c.getInjection()).toContain('<memory-policy>');
    expect(c.getInjection()).not.toContain('sk-abcdefghijklmnopqrst1234');
  });
});

describe('提取失败会话随状态下发', () => {
  it('带 error 的水位线条目出现在 failedSessions', () => {
    writeState({
      processed: {
        '2026-01-01T00-00-00-000Z_abc.jsonl': {
          projectId: projectIdentity('/tmp/ctrl-proj').id,
          mtimeMs: 1,
          size: 2,
          at: '2026-01-01T01:00:00.000Z',
          error: 'LLM 调用失败: 400'
        },
        '2026-01-02T00-00-00-000Z_def.jsonl': {
          projectId: projectIdentity('/tmp/ctrl-proj').id,
          mtimeMs: 1,
          size: 2,
          at: '2026-01-02T01:00:00.000Z'
        },
        '2026-01-03T00-00-00-000Z_ghi.jsonl': {
          projectId: projectIdentity('/tmp/ctrl-proj').id,
          mtimeMs: 1,
          size: 2,
          at: '2026-01-03T01:00:00.000Z',
          noop: true
        }
      },
      pendingExtractions: []
    });

    const status = newController().getStatus();
    expect(status.failedCount).toBe(1);
    expect(status.failedSessions).toHaveLength(1);
    expect(status.failedSessions[0].name).toBe('2026-01-01T00-00-00-000Z_abc.jsonl');
    expect(status.failedSessions[0].error).toContain('400');
    // noop / 成功条目不算失败
    expect(status.processedCount).toBe(3);
  });

  it('失败条目超过 20 条时只带最近 20 条，failedCount 为总数', () => {
    const processed: Record<
      string,
      { mtimeMs: number; size: number; at: string; error: string; projectId: string }
    > = {};
    for (let i = 0; i < 25; i++) {
      processed[`s${String(i).padStart(2, '0')}.jsonl`] = {
        projectId: projectIdentity('/tmp/ctrl-proj').id,
        mtimeMs: 1,
        size: 1,
        at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        error: 'x'
      };
    }
    writeState({ processed, pendingExtractions: [] });

    const status = newController().getStatus();
    expect(status.failedCount).toBe(25);
    expect(status.failedSessions).toHaveLength(20);
    expect(status.failedSessions[0].name).toBe('s24.jsonl');
  });
});
