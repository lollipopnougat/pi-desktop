/**
 * Subagent registry 单测:定义解析 / 优先级合并 / spawns 解析。
 */
import { describe, it, expect } from 'vitest';
import {
  parseAgentDefinition,
  mergeDefinitions,
  resolveSpawnList
} from '../../electron/subagents/registry';
import type { AgentDefinition } from '../../electron/subagents/types';

function makeAgent(name: string, source: AgentDefinition['source']): AgentDefinition {
  return {
    name,
    description: `${name} desc`,
    source,
    filePath: `/tmp/${source}/${name}.md`,
    spawns: '',
    systemPrompt: `${name} prompt`
  };
}

const VALID = `---
name: scout
description: 只读侦察
tools: read, grep
spawns: ""
---

你是 scout。`;

describe('parseAgentDefinition', () => {
  it('解析合法定义', () => {
    const { agent, error } = parseAgentDefinition(VALID, 'user', '/tmp/scout.md');
    expect(error).toBeUndefined();
    expect(agent).toMatchObject({
      name: 'scout',
      description: '只读侦察',
      source: 'user',
      tools: ['read', 'grep'],
      spawns: '',
      systemPrompt: '你是 scout。'
    });
  });

  it('解析缺省字段(tools/spawns 可省略)', () => {
    const md = `---
name: worker
description: 写者
---
正文`;
    const { agent } = parseAgentDefinition(md, 'builtin', '/tmp/worker.md');
    expect(agent?.tools).toBeUndefined();
    expect(agent?.spawns).toBe('');
  });

  it('拒绝缺少 frontmatter', () => {
    const { agent, error } = parseAgentDefinition('正文无 frontmatter', 'user', '/x.md');
    expect(agent).toBeNull();
    expect(error).toBeTruthy();
  });

  it('拒绝未闭合 frontmatter', () => {
    const { agent } = parseAgentDefinition('---\nname: x', 'user', '/x.md');
    expect(agent).toBeNull();
  });

  it('拒绝空正文', () => {
    const { agent } = parseAgentDefinition('---\nname: x\ndescription: y\n---\n', 'user', '/x.md');
    expect(agent).toBeNull();
  });

  it('拒绝非法 name(大写/连字符开头/空)', () => {
    for (const name of ['Scout', '-x', '']) {
      const md = `---\nname: ${name || '""'}\ndescription: d\n---\n正文`;
      const { agent } = parseAgentDefinition(md, 'user', '/x.md');
      expect(agent).toBeNull();
    }
  });

  it('拒绝非法 model 格式', () => {
    const md = `---\nname: x\ndescription: d\nmodel: no-slash\n---\n正文`;
    const { agent, error } = parseAgentDefinition(md, 'user', '/x.md');
    expect(agent).toBeNull();
    expect(error).toContain('model');
  });

  it('拒绝非法 thinkingLevel', () => {
    const md = `---\nname: x\ndescription: d\nthinkingLevel: turbo\n---\n正文`;
    const { agent } = parseAgentDefinition(md, 'user', '/x.md');
    expect(agent).toBeNull();
  });

  it('拒绝非逗号字符串的 tools', () => {
    const md = `---\nname: x\ndescription: d\ntools:\n  - read\n---\n正文`;
    const { agent } = parseAgentDefinition(md, 'user', '/x.md');
    expect(agent).toBeNull();
  });
});

describe('mergeDefinitions(优先级合并)', () => {
  it('高优先级覆盖同名:project > user > builtin', () => {
    const result = mergeDefinitions([
      { source: 'builtin', agents: [makeAgent('scout', 'builtin')], failedNames: [] },
      {
        source: 'user',
        agents: [makeAgent('scout', 'user'), makeAgent('mine', 'user')],
        failedNames: []
      },
      { source: 'project', agents: [makeAgent('scout', 'project')], failedNames: [] }
    ]);
    const scout = result.agents.find((a) => a.name === 'scout');
    expect(scout?.source).toBe('project');
    expect(result.agents.find((a) => a.name === 'mine')?.source).toBe('user');
  });

  it('不同名共存', () => {
    const result = mergeDefinitions([
      {
        source: 'builtin',
        agents: [makeAgent('scout', 'builtin'), makeAgent('worker', 'builtin')],
        failedNames: []
      },
      { source: 'user', agents: [makeAgent('reviewer', 'user')], failedNames: [] }
    ]);
    expect(result.agents.map((a) => a.name).sort()).toEqual(['reviewer', 'scout', 'worker']);
  });

  it('高优先级解析失败时阻止低优先级回退(不静默用错版本)', () => {
    const result = mergeDefinitions([
      { source: 'builtin', agents: [makeAgent('scout', 'builtin')], failedNames: [] },
      { source: 'user', agents: [], failedNames: ['scout'] }
    ]);
    expect(result.agents.find((a) => a.name === 'scout')).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('低优先级解析失败不影响高优先级可用定义', () => {
    const result = mergeDefinitions([
      { source: 'builtin', agents: [], failedNames: ['scout'] },
      { source: 'user', agents: [makeAgent('scout', 'user')], failedNames: [] }
    ]);
    expect(result.agents.find((a) => a.name === 'scout')?.source).toBe('user');
  });
});

describe('resolveSpawnList', () => {
  it('空串 → none', () => {
    expect(resolveSpawnList('')).toBe('none');
  });
  it('* → any', () => {
    expect(resolveSpawnList('*')).toBe('any');
  });
  it('逗号名单 → 数组', () => {
    expect(resolveSpawnList('scout, reviewer ,worker')).toEqual(['scout', 'reviewer', 'worker']);
  });
});
