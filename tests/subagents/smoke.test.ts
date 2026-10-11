/**
 * 冒烟验证(不依赖 GUI):发现内置 agent + 定义解析 + task 校验链路。
 * 运行:node dist-electron/subagents-smoke.js(或 tsx 直接跑)
 * 这里用 tsx-less 方式:直接以 vitest 跑,见 tests/subagents/smoke.test.ts
 */
import { describe, it, expect } from 'vitest';
import { discoverAgents } from '../../electron/subagents/registry';
import { withContractTools } from '../../electron/subagents/child-extension';
import path from 'path';

describe('smoke: 内置 agent 发现(真实 resources/agents 目录)', () => {
  it('发现 4 个内置 agent,字段合法', () => {
    const builtinDir = path.resolve(__dirname, '../../resources/agents');
    const result = discoverAgents(builtinDir, '/nonexistent-user-dir', '/nonexistent-cwd');
    const names = result.agents.map((a) => a.name).sort();
    expect(names).toEqual(['generalist', 'reviewer', 'scout', 'worker']);
    for (const a of result.agents) {
      expect(a.source).toBe('builtin');
      expect(a.systemPrompt.length).toBeGreaterThan(50);
      expect(a.description.length).toBeGreaterThan(5);
    }
    // scout/reviewer 只读;worker/generalist 全量
    const scout = result.agents.find((a) => a.name === 'scout')!;
    expect(scout.tools).toEqual(['read', 'grep', 'find', 'ls']);
    const reviewer = result.agents.find((a) => a.name === 'reviewer')!;
    expect(reviewer.tools).toEqual(['read', 'grep', 'find', 'ls']);
    const worker = result.agents.find((a) => a.name === 'worker')!;
    expect(worker.tools).toBeUndefined();
    expect(worker.spawns).toBe('');
  });

  it('内置定义 diagnostics 为空(全部解析成功)', () => {
    const builtinDir = path.resolve(__dirname, '../../resources/agents');
    const result = discoverAgents(builtinDir, '/nonexistent-user-dir', '/nonexistent-cwd');
    expect(result.diagnostics).toEqual([]);
  });
});

/**
 * 契约工具必须始终在白名单内（回归）：
 * 角色定义里的 tools 是能力白名单，但 SDK 的 tools 选项是硬白名单，不在名单里的工具
 * （包括内联扩展注册的 submit / task）会被移出注册表 —— 只读角色因此会被系统提示
 * 要求调用一个看不见的 submit。executor 现在用 withContractTools 取并集。
 */
describe('smoke: 子 agent 白名单与契约工具', () => {
  it('角色未声明 tools 时不限制（undefined 原样透传）', () => {
    expect(withContractTools(undefined)).toBeUndefined();
  });

  it('声明了 tools 的角色补上 submit / task 且不重复', () => {
    expect(withContractTools(['read', 'grep', 'find', 'ls'])).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'submit',
      'task'
    ]);
    expect(withContractTools(['read', 'submit'])).toEqual(['read', 'submit', 'task']);
  });

  it('内置只读角色(scout/reviewer)的白名单经合并后包含 submit', () => {
    const builtinDir = path.resolve(__dirname, '../../resources/agents');
    const { agents } = discoverAgents(builtinDir, '/nonexistent-user-dir', '/nonexistent-cwd');
    for (const name of ['scout', 'reviewer']) {
      const agent = agents.find((a) => a.name === name)!;
      expect(agent.tools).toBeDefined();
      expect(withContractTools(agent.tools)).toContain('submit');
    }
  });
});
