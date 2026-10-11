import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundTaskRegistry } from '../../electron/background-tasks/registry';
import { backgroundTaskPaths, writeJsonDurable } from '../../electron/background-tasks/persistence';
import type { BackgroundTaskSnapshot } from '../../electron/background-tasks/types';

const tempDirs: string[] = [];
const registries: BackgroundTaskRegistry[] = [];

async function createFixture(options?: {
  maxOutputBytes?: number;
  onTerminal?: ReturnType<typeof vi.fn>;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piui-bg-registry-'));
  tempDirs.push(root);
  const cwd = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  let sequence = 0;
  const registry = new BackgroundTaskRegistry({
    agentDir,
    maxOutputBytes: options?.maxOutputBytes,
    makeTaskId: () => `bg-test-${++sequence}`,
    onTerminal: options?.onTerminal
  });
  registries.push(registry);
  await registry.initialize();
  return { registry, cwd, agentDir };
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function scriptCommand(cwd: string, name: string, source: string): Promise<string> {
  const scriptPath = path.join(cwd, `${name}.cjs`);
  await writeFile(scriptPath, source, 'utf8');
  return `${quote(process.execPath)} ${quote(scriptPath)}`;
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BackgroundTaskRegistry', () => {
  it('退出等待后台进程停止并保存终态，重复调用共享清理过程', async () => {
    const { registry, cwd } = await createFixture();
    const command = await scriptCommand(
      cwd,
      'quit',
      "process.stdout.write('ready'); setInterval(() => {}, 1000)"
    );
    const task = await registry.start(
      { command, name: '退出清理' },
      { cwd, sessionId: 'session-quit' }
    );
    await vi.waitFor(async () =>
      expect((await registry.readLogs(task.id)).content).toContain('ready')
    );
    const first = registry.dispose();
    expect(registry.dispose()).toBe(first);
    await first;
    expect(await registry.waitForTerminal(task.id)).toMatchObject({ status: 'killed' });
  });

  it('运行命令、持久化终态并读取日志', async () => {
    const onTerminal = vi.fn();
    const { registry, cwd } = await createFixture({ onTerminal });
    const command = await scriptCommand(cwd, 'success', "process.stdout.write('hello background')");
    const started = await registry.start(
      { command, name: '成功任务' },
      { cwd, sessionId: 'session-1' }
    );
    expect(started.status).toBe('running');

    const terminal = await registry.waitForTerminal(started.id);
    expect(terminal).toMatchObject({ status: 'completed', exitCode: 0, bytesWritten: 16 });
    const logs = await registry.readLogs(started.id);
    expect(logs.content).toBe('hello background');
    expect(logs.truncated).toBe(false);
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
  });

  it('超过输出上限时失败并终止进程', async () => {
    const { registry, cwd } = await createFixture({ maxOutputBytes: 1024 });
    const command = await scriptCommand(
      cwd,
      'large-output',
      "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"
    );
    const started = await registry.start(
      { command, name: '大日志任务' },
      { cwd, sessionId: 'session-1' }
    );
    const terminal = await registry.waitForTerminal(started.id);
    expect(terminal.status).toBe('failed');
    expect(terminal.error).toContain('日志超过上限');
    expect(terminal.bytesWritten).toBe(1024);
  });

  it('超时后终止进程并记录失败原因', async () => {
    const { registry, cwd } = await createFixture();
    const command = await scriptCommand(cwd, 'timeout', 'setInterval(() => {}, 1000)');
    const started = await registry.start(
      { command, name: '超时任务', timeoutSeconds: 1 },
      { cwd, sessionId: 'session-1' }
    );
    const terminal = await registry.waitForTerminal(started.id);
    expect(terminal.status).toBe('failed');
    expect(terminal.error).toContain('运行超时');
  });

  it('用户停止运行中的任务后进入 killed 终态', async () => {
    const { registry, cwd } = await createFixture();
    const command = await scriptCommand(cwd, 'long-running', 'setInterval(() => {}, 1000)');
    const started = await registry.start(
      { command, name: '长任务', notifyOnCompletion: false },
      { cwd, sessionId: 'session-1' }
    );
    await registry.stop(started.id);
    const terminal = await registry.waitForTerminal(started.id);
    expect(terminal.status).toBe('killed');
  });

  it('启动时把遗留 running 记录标为 interrupted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piui-bg-restore-'));
    tempDirs.push(root);
    const cwd = path.join(root, 'project');
    const agentDir = path.join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const paths = backgroundTaskPaths(agentDir, cwd, 'bg-stale');
    const stale: BackgroundTaskSnapshot = {
      id: 'bg-stale',
      name: '遗留任务',
      command: 'sleep 100',
      status: 'running',
      cwd,
      projectKey: paths.projectKey,
      sessionId: 'old-session',
      outputPath: paths.outputPath,
      startTime: 1,
      pid: 123,
      bytesWritten: 0,
      isAgent: false,
      notifyOnCompletion: true,
      triggerOnCompletion: true
    };
    await mkdir(paths.taskDir, { recursive: true });
    await writeFile(paths.outputPath, '', 'utf8');
    await writeJsonDurable(paths.metadataPath, stale);

    const registry = new BackgroundTaskRegistry({ agentDir });
    registries.push(registry);
    await registry.initialize();
    const restored = registry.get('bg-stale');
    expect(restored.status).toBe('interrupted');
    expect(restored).not.toHaveProperty('pid');
  });

  it('删除已结束任务的记录与磁盘产物', async () => {
    const { registry, cwd, agentDir } = await createFixture();
    const command = await scriptCommand(cwd, 'removable', "process.stdout.write('bye')");
    const started = await registry.start(
      { command, name: '待清理任务' },
      { cwd, sessionId: 'session-1' }
    );
    await registry.waitForTerminal(started.id);
    const taskDir = backgroundTaskPaths(agentDir, cwd, started.id).taskDir;
    await expect(stat(taskDir)).resolves.toBeTruthy();

    const result = await registry.remove([started.id]);
    expect(result.removed).toEqual([started.id]);
    expect(result.failed).toEqual([]);
    expect(registry.list().map((task) => task.id)).not.toContain(started.id);
    expect(() => registry.get(started.id)).toThrow();
    await expect(stat(taskDir)).rejects.toThrow();
  });

  it('清理后的记录在重新加载时不再出现', async () => {
    const { registry, cwd, agentDir } = await createFixture();
    const command = await scriptCommand(cwd, 'gone', "process.stdout.write('x')");
    const started = await registry.start(
      { command, name: '消失任务' },
      { cwd, sessionId: 'session-1' }
    );
    await registry.waitForTerminal(started.id);
    await registry.remove([started.id]);

    const reloaded = new BackgroundTaskRegistry({ agentDir });
    registries.push(reloaded);
    await reloaded.initialize();
    expect(reloaded.list()).toEqual([]);
  });

  it('拒绝删除运行中的任务，且不影响同一批次里已结束的任务', async () => {
    const { registry, cwd } = await createFixture();
    const quick = await scriptCommand(cwd, 'quick', "process.stdout.write('ok')");
    const done = await registry.start({ command: quick, name: '已结束' }, { cwd, sessionId: 's1' });
    await registry.waitForTerminal(done.id);
    const slow = await scriptCommand(cwd, 'slow', 'setInterval(() => {}, 1000)');
    const running = await registry.start(
      { command: slow, name: '运行中', notifyOnCompletion: false },
      { cwd, sessionId: 's1' }
    );

    const result = await registry.remove([running.id, done.id]);
    expect(result.removed).toEqual([done.id]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(running.id);
    expect(result.failed[0].error).toContain('正在运行');
    expect(registry.get(running.id).status).toBe('running');

    await registry.stop(running.id);
    await registry.waitForTerminal(running.id);
  });

  it('未知任务 ID 返回失败项而不抛错', async () => {
    const { registry } = await createFixture();
    const result = await registry.remove(['bg-does-not-exist']);
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('bg-does-not-exist');
  });
});
