import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BACKGROUND_TASK_METADATA_FILE,
  BACKGROUND_TASK_OUTPUT_FILE,
  backgroundTaskPaths,
  backgroundTaskProjectKey,
  loadPersistedBackgroundTasks,
  readBackgroundTaskLog,
  writeJsonDurable
} from '../../electron/background-tasks/persistence';
import type { BackgroundTaskSnapshot } from '../../electron/background-tasks/types';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piui-bg-persistence-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('background task persistence', () => {
  it('为同一 cwd 生成稳定且不泄露路径的 project key', () => {
    const first = backgroundTaskProjectKey('/tmp/project-a');
    const second = backgroundTaskProjectKey('/tmp/project-a');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(backgroundTaskProjectKey('/tmp/project-b')).not.toBe(first);
  });

  it('原子写入并恢复任务，同时以目录中的日志路径为准', async () => {
    const agentDir = await tempDir();
    const paths = backgroundTaskPaths(agentDir, '/tmp/project', 'bg-test');
    await mkdir(paths.taskDir, { recursive: true });
    await writeFile(paths.outputPath, 'hello', 'utf8');
    const snapshot: BackgroundTaskSnapshot = {
      id: 'bg-test',
      name: '测试任务',
      command: 'echo hello',
      status: 'completed',
      cwd: '/tmp/project',
      projectKey: paths.projectKey,
      sessionId: 'session-1',
      outputPath: '/tampered/output.log',
      startTime: 1,
      endTime: 2,
      exitCode: 0,
      bytesWritten: 5,
      isAgent: false,
      notifyOnCompletion: true,
      triggerOnCompletion: true
    };
    await writeJsonDurable(paths.metadataPath, snapshot);

    const loaded = await loadPersistedBackgroundTasks(agentDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].snapshot.outputPath).toBe(paths.outputPath);
    expect(path.basename(loaded[0].metadataPath)).toBe(BACKGROUND_TASK_METADATA_FILE);
    expect(path.basename(loaded[0].outputPath)).toBe(BACKGROUND_TASK_OUTPUT_FILE);
  });

  it('支持有界读取日志头部和尾部', async () => {
    const dir = await tempDir();
    const output = path.join(dir, 'output.log');
    await writeFile(output, '0123456789', 'utf8');

    const head = await readBackgroundTaskLog(output, 4, false);
    const tail = await readBackgroundTaskLog(output, 4, true);
    expect(head).toMatchObject({ content: '0123', totalBytes: 10, truncated: true });
    expect(tail).toMatchObject({ content: '6789', totalBytes: 10, truncated: true });
  });
});
