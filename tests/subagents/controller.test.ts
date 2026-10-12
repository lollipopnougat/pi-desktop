/**
 * SubagentController 单测:task 参数校验 / 单写者拒绝 / agent 不存在 / spawns 白名单 / 信号量排队。
 *
 * mock PiBridge + SubagentExecutor(不创建真实子 session),
 * 只测 controller 的调度与拒绝逻辑(纯逻辑部分)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentController } from '../../electron/subagents/controller';
import type { AgentDefinition } from '../../electron/subagents/types';

// ─── mock PiBridge ───

function createMockBridge(cwd = '/proj') {
  return {
    win: null,
    sendSessionEvent: () => false,
    cwd,
    agentDir: '/home/.pi-desktop',
    modelRuntime: { getModel: () => undefined },
    getSession: () => ({ model: { id: 'm' } }),
    sessionHost: () => ({
      current: () => ({ model: { id: 'm' } }),
      cwd: () => cwd,
      sendSessionEvent: () => true
    }),
    webContents: null
  } as any;
}

// ─── mock executor:替换 spawn 实现 ───

function makeDef(name: string, tools?: string[]): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    source: 'builtin',
    filePath: `/tmp/${name}.md`,
    tools,
    spawns: '',
    systemPrompt: `${name} prompt`
  };
}

function createController(defs: AgentDefinition[]) {
  const bridge = createMockBridge();
  const controller = new SubagentController(bridge, bridge.sessionHost());
  // 注入定义与 spawn mock
  (controller as any).definitions = { agents: defs, diagnostics: [] };
  (controller as any).loadedForCwd = bridge.cwd;
  const spawnMock = vi.fn(async (opts: any) => {
    opts.run.status = 'complete';
    opts.run.output = `${opts.run.agent} done`;
    opts.run.outputSource = 'submit';
    opts.run.endedAt = Date.now();
    return { run: opts.run };
  });
  (controller as any).executor = {
    spawn: spawnMock,
    stop: vi.fn(),
    steer: vi.fn(),
    builtinAgentsDir: '/tmp/agents',
    activeCount: 0
  };
  return { controller, spawnMock };
}

describe('SubagentController.executeTask 校验', () => {
  it('清理等待在途任务结束，并阻止旧会话结果回灌', async () => {
    const { controller, spawnMock } = createController([makeDef('worker')]);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    spawnMock.mockImplementation(async (opts: any) => {
      await finished;
      return { run: opts.run };
    });
    const followUp = vi.fn();
    controller.setFollowUpSender(followUp);
    await controller.executeTask({ agent: 'worker', task: 'work', async: true, depth: 0 });
    let stopped = false;
    const disposal = controller.dispose().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(
      (await controller.executeTask({ agent: 'worker', task: 'late', depth: 0 })).runIds
    ).toEqual([]);
    finish();
    await disposal;
    expect(followUp).not.toHaveBeenCalled();
  });

  it('缺少 agent/task 与 tasks → 错误', async () => {
    const { controller } = createController([makeDef('scout', ['read'])]);
    const r = await controller.executeTask({ depth: 0 });
    expect(r.text).toContain('错误');
    expect(r.runIds).toHaveLength(0);
  });

  it('agent 不存在 → 错误并列出可用名', async () => {
    const { controller } = createController([makeDef('scout', ['read'])]);
    const r = await controller.executeTask({ agent: 'nobody', task: 'x', depth: 0 });
    expect(r.text).toContain('不存在');
    expect(r.text).toContain('scout');
  });

  it('flat 单任务成功,结果合并', async () => {
    const { controller, spawnMock } = createController([makeDef('scout', ['read'])]);
    const r = await controller.executeTask({ agent: 'scout', task: '找 IPC 注册点', depth: 0 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(r.runIds).toHaveLength(1);
    expect(r.text).toContain('scout done');
    expect(r.text).toContain('成功');
  });

  it('batch 多任务全部执行并合并', async () => {
    const { controller, spawnMock } = createController([
      makeDef('scout', ['read']),
      makeDef('reviewer', ['read'])
    ]);
    const r = await controller.executeTask({
      context: '共享背景',
      tasks: [
        { name: '查X', agent: 'scout', task: '查 X' },
        { name: '查Y', agent: 'reviewer', task: '查 Y' }
      ],
      depth: 0
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(r.text).toContain('查X');
    expect(r.text).toContain('查Y');
  });

  it('一次调用多个可写 agent → 单写者拒绝', async () => {
    const { controller, spawnMock } = createController([
      makeDef('worker'), // 无 tools = 全量(可写)
      makeDef('fixer', ['edit', 'read'])
    ]);
    const r = await controller.executeTask({
      tasks: [
        { agent: 'worker', task: '改 A' },
        { agent: 'fixer', task: '改 B' }
      ],
      depth: 0
    });
    expect(r.text).toContain('错误');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('一个写者 + 多个只读 → 允许', async () => {
    const { controller } = createController([makeDef('worker'), makeDef('scout', ['read'])]);
    const r = await controller.executeTask({
      tasks: [
        { agent: 'worker', task: '改 A' },
        { agent: 'scout', task: '查 B' }
      ],
      depth: 0
    });
    expect(r.text).not.toContain('错误');
  });

  it('递归调用且 agent 不在 spawns 白名单 → 拒绝', async () => {
    const defs = [makeDef('scout', ['read']), makeDef('worker')];
    // scout spawns 为空串 → 不可派生
    const { controller } = createController(defs);
    const r = await controller.executeTask({
      agent: 'worker',
      task: 'x',
      depth: 1,
      callerAgent: 'scout'
    });
    expect(r.text).toContain('spawns');
  });

  it('递归调用且 agent 在 spawns 白名单 → 允许', async () => {
    const defs = [{ ...makeDef('scout', ['read']), spawns: 'worker' }, makeDef('worker')];
    const { controller } = createController(defs);
    const r = await controller.executeTask({
      agent: 'worker',
      task: 'x',
      depth: 1,
      callerAgent: 'scout'
    });
    expect(r.text).not.toContain('错误');
  });

  it('批量任务带共享 context:context 拼进每个任务', async () => {
    const { controller } = createController([makeDef('scout', ['read'])]);
    await controller.executeTask({
      context: '背景: pi-desktop',
      tasks: [{ agent: 'scout', task: '查 X' }],
      depth: 0
    });
    // spawn 收到的 run.task 应包含 context 前缀
    const calls = (controller as any).executor.spawn.mock.calls;
    expect(calls[0][0].run.task).toContain('背景: pi-desktop');
    expect(calls[0][0].run.task).toContain('查 X');
  });
});

describe('并发上限与 run 管理', () => {
  it('活跃任务过多时拒绝新任务', async () => {
    const { controller } = createController([makeDef('scout', ['read'])]);
    // 直接塞 10 个 running run 绕过 spawn
    for (let i = 0; i < 10; i++) {
      (controller as any).runs.push({
        id: `r${i}`,
        name: 'x',
        agent: 'scout',
        task: 'x',
        status: 'running',
        async: false,
        depth: 0,
        createdAt: Date.now()
      });
    }
    const r = await controller.executeTask({ agent: 'scout', task: '再塞一个', depth: 0 });
    expect(r.text).toContain('错误');
    expect(r.text).toContain('活跃');
  });

  it('queued run 停止后不再执行', async () => {
    const bridge = createMockBridge();
    const controller = new SubagentController(bridge, bridge.sessionHost());
    (controller as any).definitions = {
      agents: [makeDef('scout', ['read'])],
      diagnostics: []
    };
    (controller as any).loadedForCwd = bridge.cwd;
    const spawnMock = vi.fn();
    (controller as any).executor = { spawn: spawnMock, stop: vi.fn(), steer: vi.fn() };

    // 建一个 queued run,先停掉(status → stopped),再走 runOne 私有方法验证跳过
    const run = {
      id: 'sa-test',
      name: 'x',
      agent: 'scout',
      task: 'x',
      status: 'queued',
      async: false,
      depth: 0,
      createdAt: Date.now(),
      progress: { recentTools: [], turns: 0, tokens: 0, durationMs: 0 }
    };
    (controller as any).runs.push(run);
    await controller.stopRun(run.id); // queued → stopped
    expect(run.status).toBe('stopped');
    await (controller as any).runOne(run, makeDef('scout', ['read']), undefined, 0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('getSnapshot 返回倒序 runs 与 agents 元数据', async () => {
    const { controller } = createController([makeDef('scout', ['read'])]);
    await controller.executeTask({ agent: 'scout', task: 'x', depth: 0 });
    const snap = controller.getSnapshot();
    expect(snap.runs).toHaveLength(1);
    expect(snap.agents[0]).toMatchObject({ name: 'scout', source: 'builtin' });
  });
});
