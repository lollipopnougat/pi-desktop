/**
 * 子 session 工具白名单的**端到端**回归（真实 SDK session，不 mock，不调模型）：
 *
 * 角色定义里的 `tools`（如 scout/reviewer 的 `read, grep, find, ls`）会作为 SDK 的 `tools`
 * 选项传入，而 SDK 的 `tools` 是**硬白名单**：不在名单里的工具会被直接移出工具注册表，
 * 包括内联扩展注册的 `submit`（见 agent-session.js 的 `_isAllowedTool` / `_refreshToolRegistry`
 * 里的 `allCustomTools.filter(...)`）。这会让只读角色被系统提示要求调用一个自己看不见的 submit。
 * 因此 executor 用 `withContractTools` 把角色白名单与契约工具取并集。
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent';
import { childExtensionFactory, withContractTools } from '../../electron/subagents/child-extension';
import { discoverAgents } from '../../electron/subagents/registry';

/** 最小 ChildRunContext：只要 submit 工具能被注册出来即可 */
const ctx = {
  agentName: 'scout',
  rolePrompt: '你是 scout',
  depth: 1,
  maxDepth: 2,
  onSubmit: () => {},
  spawnableAgents: []
} as never;

const sessions: AgentSession[] = [];

/** 用真实的 services/session 装配路径创建子 session（与 executor.spawn 一致，只是 modelRuntime 用空实现） */
async function buildChildSession(tools: string[] | undefined): Promise<AgentSession> {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: path.join(os.tmpdir(), 'pi-desktop-subagent-tools-test'),
    // 子 session 的装配不依赖模型调用，这里只需满足 refresh 的存在性
    modelRuntime: new Proxy(
      {},
      { get: (_t, key) => (key === 'refresh' ? async () => {} : (..._a: unknown[]) => []) }
    ) as never,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [childExtensionFactory(ctx)]
    }
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(process.cwd()),
    tools,
    customTools: []
  });
  sessions.push(created.session);
  return created.session;
}

afterAll(() => {
  for (const session of sessions) {
    try {
      session.dispose();
    } catch {
      /* 忽略 */
    }
  }
});

describe('子 session 的工具白名单', () => {
  it('裸 tools 白名单会把内联扩展注册的 submit 移出注册表（复现问题）', async () => {
    const session = await buildChildSession(['read']);
    expect(session.getActiveToolNames()).toEqual(['read']);
    expect(session.getAllTools().map((t) => t.name)).not.toContain('submit');
  });

  it('经 withContractTools 合并后 submit 对模型可见可调', async () => {
    const session = await buildChildSession(withContractTools(['read']));
    expect(session.getActiveToolNames()).toContain('submit');
    expect(session.getAllTools().map((t) => t.name)).toContain('submit');
  });

  it('内置只读角色(scout/reviewer)的白名单合并后包含 submit', async () => {
    const builtinDir = path.resolve(__dirname, '../../resources/agents');
    const { agents } = discoverAgents(builtinDir, '/nonexistent-user-dir', '/nonexistent-cwd');
    for (const name of ['scout', 'reviewer']) {
      const agent = agents.find((a) => a.name === name)!;
      const session = await buildChildSession(withContractTools(agent.tools));
      expect(session.getActiveToolNames()).toContain('submit');
    }
  });

  it('未声明 tools 的角色不受限制（submit 照旧可用）', async () => {
    const session = await buildChildSession(withContractTools(undefined));
    expect(session.getActiveToolNames()).toContain('submit');
  });
});
