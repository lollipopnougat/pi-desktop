import { randomBytes } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  backgroundTaskPaths,
  loadPersistedBackgroundTasks,
  readBackgroundTaskLog,
  removeBackgroundTaskArtifacts,
  writeJsonDurable
} from './persistence';
import {
  isBackgroundTaskTerminal,
  type BackgroundTaskKillReason,
  type BackgroundTaskLogResult,
  type BackgroundTaskOwner,
  type BackgroundTaskRemoveResult,
  type BackgroundTaskSnapshot,
  type StartBackgroundTaskInput
} from './types';

export const DEFAULT_BACKGROUND_OUTPUT_LIMIT = 20 * 1024 * 1024;
export const MAX_BACKGROUND_LOG_READ_BYTES = 50 * 1024;
export const DEFAULT_BACKGROUND_TASK_RETENTION = 100;
const KILL_GRACE_MS = 3_000;

interface BackgroundTaskRecord {
  snapshot: BackgroundTaskSnapshot;
  taskDir: string;
  metadataPath: string;
  outputPath: string;
  child?: ChildProcess;
  stream?: WriteStream;
  timeoutHandle?: NodeJS.Timeout;
  killEscalationHandle?: NodeJS.Timeout;
  progressUpdateHandle?: NodeJS.Timeout;
  killReason?: BackgroundTaskKillReason;
  finalized: boolean;
  outputLimitReached: boolean;
  metadataWriteChain: Promise<void>;
  waiters: Array<() => void>;
}

export interface BackgroundTaskRegistryOptions {
  agentDir: string;
  maxOutputBytes?: number;
  maxRecentTasks?: number;
  now?: () => number;
  makeTaskId?: () => string;
  onChange?: (tasks: BackgroundTaskSnapshot[]) => void;
  onTerminal?: (task: BackgroundTaskSnapshot) => void | Promise<void>;
}

function makeDefaultTaskId(): string {
  return `bg-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function cloneSnapshot(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
  return { ...snapshot };
}

function normalizeName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('后台任务名称不能为空');
  if (trimmed.length > 120) throw new Error('后台任务名称不能超过 120 个字符');
  return trimmed;
}

function normalizeCommand(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('后台命令不能为空');
  if (trimmed.length > 32_768) throw new Error('后台命令不能超过 32768 个字符');
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1 || value > 7 * 24 * 60 * 60) {
    throw new Error('timeoutSeconds 必须在 1 到 604800 之间');
  }
  return Math.floor(value);
}

function shellInvocation(command: string): {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  if (process.platform === 'win32') {
    return {
      executable: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      windowsVerbatimArguments: true
    };
  }
  return {
    executable: process.env.SHELL || '/bin/sh',
    args: ['-lc', command]
  };
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly agentDir: string;
  private readonly maxOutputBytes: number;
  private readonly maxRecentTasks: number;
  private readonly now: () => number;
  private readonly makeTaskId: () => string;
  private readonly onChange: (tasks: BackgroundTaskSnapshot[]) => void;
  private readonly onTerminal: (task: BackgroundTaskSnapshot) => void | Promise<void>;
  private initialized = false;
  private shuttingDown = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: BackgroundTaskRegistryOptions) {
    this.agentDir = options.agentDir;
    this.maxOutputBytes = Math.max(1024, options.maxOutputBytes ?? DEFAULT_BACKGROUND_OUTPUT_LIMIT);
    this.maxRecentTasks = Math.max(1, options.maxRecentTasks ?? DEFAULT_BACKGROUND_TASK_RETENTION);
    this.now = options.now ?? Date.now;
    this.makeTaskId = options.makeTaskId ?? makeDefaultTaskId;
    this.onChange = options.onChange ?? (() => {});
    this.onTerminal = options.onTerminal ?? (() => {});
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const persisted = await loadPersistedBackgroundTasks(this.agentDir);
    persisted.sort((a, b) => a.snapshot.startTime - b.snapshot.startTime);

    for (const item of persisted) {
      const snapshot = cloneSnapshot(item.snapshot);
      if (snapshot.status === 'running') {
        snapshot.status = 'interrupted';
        snapshot.endTime = this.now();
        snapshot.error = '应用上次退出时任务仍在运行，无法恢复进程连接。';
        delete snapshot.pid;
      }
      const record: BackgroundTaskRecord = {
        snapshot,
        taskDir: item.taskDir,
        metadataPath: item.metadataPath,
        outputPath: item.outputPath,
        finalized: true,
        outputLimitReached: false,
        metadataWriteChain: Promise.resolve(),
        waiters: []
      };
      this.tasks.set(snapshot.id, record);
      if (item.snapshot.status === 'running') await this.persist(record);
    }

    await this.pruneOldTasks();
    this.initialized = true;
    this.emitChange();
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()]
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((a, b) => b.startTime - a.startTime);
  }

  get(idOrPrefix: string): BackgroundTaskSnapshot {
    return cloneSnapshot(this.resolveRecord(idOrPrefix).snapshot);
  }

  async start(
    input: StartBackgroundTaskInput,
    owner: BackgroundTaskOwner
  ): Promise<BackgroundTaskSnapshot> {
    await this.initialize();
    if (this.shuttingDown) throw new Error('应用正在退出，不能启动后台任务');

    const command = normalizeCommand(input.command);
    const name = normalizeName(input.name);
    const timeoutSeconds = normalizeTimeout(input.timeoutSeconds);
    const id = this.makeTaskId();
    if (!/^[A-Za-z0-9._-]+$/.test(id) || this.tasks.has(id)) {
      throw new Error(`无效或重复的后台任务 ID: ${id}`);
    }
    const paths = backgroundTaskPaths(this.agentDir, owner.cwd, id);
    await mkdir(paths.taskDir, { recursive: true, mode: 0o700 });

    const notifyOnCompletion = input.notifyOnCompletion !== false;
    const snapshot: BackgroundTaskSnapshot = {
      id,
      name,
      command,
      status: 'running',
      cwd: owner.cwd,
      projectKey: paths.projectKey,
      sessionId: owner.sessionId,
      outputPath: paths.outputPath,
      startTime: this.now(),
      bytesWritten: 0,
      isAgent: input.isAgent === true,
      notifyOnCompletion,
      triggerOnCompletion: notifyOnCompletion && input.triggerOnCompletion !== false
    };
    const description = input.description?.trim().slice(0, 2_000);
    if (description) snapshot.description = description;
    if (timeoutSeconds !== undefined) snapshot.timeoutSeconds = timeoutSeconds;

    const record: BackgroundTaskRecord = {
      snapshot,
      taskDir: paths.taskDir,
      metadataPath: paths.metadataPath,
      outputPath: paths.outputPath,
      finalized: false,
      outputLimitReached: false,
      metadataWriteChain: Promise.resolve(),
      waiters: []
    };
    this.tasks.set(id, record);
    record.stream = createWriteStream(record.outputPath, {
      flags: 'a',
      encoding: 'utf8',
      mode: 0o600
    });
    record.stream.on('error', (error) => {
      if (record.finalized) return;
      record.snapshot.error = `后台日志写入失败: ${error.message}`;
      record.killReason = 'output_limit';
      this.requestStop(record);
    });

    try {
      const invocation = shellInvocation(command);
      const child = spawn(invocation.executable, invocation.args, {
        cwd: owner.cwd,
        detached: process.platform !== 'win32',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
      });
      record.child = child;
      if (child.pid !== undefined) record.snapshot.pid = child.pid;
      this.captureOutput(record, child.stdout);
      this.captureOutput(record, child.stderr);
      child.once('error', (error) => {
        void this.finalize(record, 'failed', null, null, `启动失败: ${error.message}`);
      });
      child.once('close', (code, signal) => {
        const terminal = this.classifyTerminal(record, code, signal);
        void this.finalize(record, terminal.status, code, signal, terminal.error);
      });

      if (timeoutSeconds !== undefined) {
        record.timeoutHandle = setTimeout(() => {
          if (record.finalized) return;
          record.killReason = 'timeout';
          record.snapshot.error = `运行超时（${timeoutSeconds} 秒）`;
          this.writeNotice(record, `\n[后台任务超时: ${timeoutSeconds} 秒]\n`);
          this.requestStop(record);
        }, timeoutSeconds * 1000);
        record.timeoutHandle.unref?.();
      }

      await this.persist(record);
      this.emitChange();
      return cloneSnapshot(record.snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalize(record, 'failed', null, null, `启动失败: ${message}`);
      throw new Error(`后台任务启动失败: ${message}`);
    }
  }

  async stop(
    idOrPrefix: string,
    reason: BackgroundTaskKillReason = 'user'
  ): Promise<BackgroundTaskSnapshot> {
    const record = this.resolveRecord(idOrPrefix);
    if (record.snapshot.status !== 'running' || record.finalized) {
      throw new Error(
        `后台任务 ${record.snapshot.id} 已结束，当前状态为 ${record.snapshot.status}`
      );
    }
    if (!record.killReason) record.killReason = reason;
    this.writeNotice(record, `\n[后台任务停止请求: ${reason}]\n`);
    this.requestStop(record);
    return cloneSnapshot(record.snapshot);
  }

  async stopAll(reason: BackgroundTaskKillReason = 'shutdown'): Promise<void> {
    const running = [...this.tasks.values()].filter(
      (record) => record.snapshot.status === 'running' && !record.finalized
    );
    await Promise.allSettled(running.map((record) => this.stop(record.snapshot.id, reason)));
  }

  /**
   * 删除后台任务记录（内存 + 磁盘 taskDir）。
   *
   * 只允许删除已进入终态的任务：运行中的任务删掉记录会丢失子进程句柄与完成通知，
   * 必须先通过 stop() 停止。单个任务失败不影响其他任务，结果里逐条回报。
   */
  async remove(ids: string[]): Promise<BackgroundTaskRemoveResult> {
    await this.initialize();
    const removed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    const targets = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))];

    for (const idOrPrefix of targets) {
      try {
        const record = this.resolveRecord(idOrPrefix);
        if (record.snapshot.status === 'running' || !record.finalized) {
          throw new Error(`任务 ${record.snapshot.id} 正在运行，请先停止后再删除`);
        }
        const id = record.snapshot.id;
        this.tasks.delete(id);
        // 等最后一次 metadata 写入落盘，避免删目录后又被在途写入重建
        await record.metadataWriteChain.catch(() => {});
        await removeBackgroundTaskArtifacts(record.taskDir).catch(() => {});
        removed.push(id);
      } catch (error) {
        failed.push({
          id: idOrPrefix,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (removed.length > 0) this.emitChange();
    return { removed, failed };
  }

  async readLogs(
    idOrPrefix: string,
    options: { tail?: boolean; maxBytes?: number } = {}
  ): Promise<BackgroundTaskLogResult> {
    const record = this.resolveRecord(idOrPrefix);
    const maxBytes = Math.min(
      MAX_BACKGROUND_LOG_READ_BYTES,
      Math.max(1, Math.floor(options.maxBytes ?? MAX_BACKGROUND_LOG_READ_BYTES))
    );
    const tail = options.tail !== false;
    const result = await readBackgroundTaskLog(record.outputPath, maxBytes, tail);
    return {
      taskId: record.snapshot.id,
      outputPath: record.outputPath,
      tail,
      ...result
    };
  }

  waitForTerminal(idOrPrefix: string): Promise<BackgroundTaskSnapshot> {
    const record = this.resolveRecord(idOrPrefix);
    if (isBackgroundTaskTerminal(record.snapshot.status)) {
      return Promise.resolve(cloneSnapshot(record.snapshot));
    }
    return new Promise((resolve) => {
      record.waiters.push(() => resolve(cloneSnapshot(record.snapshot)));
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.shuttingDown = true;
    const running = [...this.tasks.values()].filter(
      (record) => record.snapshot.status === 'running'
    );
    this.disposePromise = (async () => {
      await this.stopAll('shutdown');
      // 等待 close/退出和终态落盘，确保 SIGKILL 升级定时器有机会执行。
      await Promise.allSettled(running.map((record) => this.waitForTerminal(record.snapshot.id)));
      await Promise.allSettled([...this.tasks.values()].map((record) => record.metadataWriteChain));
    })();
    return this.disposePromise;
  }

  private resolveRecord(idOrPrefix: string): BackgroundTaskRecord {
    const query = idOrPrefix.trim();
    if (!query) throw new Error('任务 ID 不能为空');
    const exact = this.tasks.get(query);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((record) =>
      record.snapshot.id.startsWith(query)
    );
    if (matches.length === 0) throw new Error(`未找到后台任务: ${query}`);
    if (matches.length > 1) throw new Error(`任务 ID 前缀不唯一: ${query}`);
    return matches[0];
  }

  private captureOutput(record: BackgroundTaskRecord, source: Readable | null): void {
    source?.on('data', (chunk: Buffer | string) => {
      if (record.finalized || record.outputLimitReached) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = this.maxOutputBytes - record.snapshot.bytesWritten;
      if (remaining <= 0) {
        this.failForOutputLimit(record);
        return;
      }
      const accepted = buffer.subarray(0, remaining);
      record.snapshot.bytesWritten += accepted.byteLength;
      record.stream?.write(accepted);
      this.scheduleProgressUpdate(record);
      if (
        accepted.byteLength < buffer.byteLength ||
        record.snapshot.bytesWritten >= this.maxOutputBytes
      ) {
        this.failForOutputLimit(record);
      }
    });
  }

  private scheduleProgressUpdate(record: BackgroundTaskRecord): void {
    if (record.progressUpdateHandle || record.finalized) return;
    record.progressUpdateHandle = setTimeout(() => {
      record.progressUpdateHandle = undefined;
      if (record.finalized) return;
      this.emitChange();
    }, 500);
    record.progressUpdateHandle.unref?.();
  }

  private failForOutputLimit(record: BackgroundTaskRecord): void {
    if (record.outputLimitReached || record.finalized) return;
    record.outputLimitReached = true;
    record.killReason = 'output_limit';
    record.snapshot.error = `日志超过上限 ${this.maxOutputBytes} 字节`;
    this.writeNotice(record, `\n[后台任务日志超过 ${this.maxOutputBytes} 字节上限，任务已终止]\n`);
    this.requestStop(record);
  }

  private writeNotice(record: BackgroundTaskRecord, text: string): void {
    try {
      record.stream?.write(text);
    } catch {
      // The original stream error is reported by its error listener.
    }
  }

  private classifyTerminal(
    record: BackgroundTaskRecord,
    code: number | null,
    signal: NodeJS.Signals | null
  ): { status: 'completed' | 'failed' | 'killed'; error?: string } {
    if (record.killReason === 'user' || record.killReason === 'shutdown') {
      return { status: 'killed' };
    }
    if (record.killReason === 'timeout' || record.killReason === 'output_limit') {
      return { status: 'failed', error: record.snapshot.error };
    }
    if ((code ?? 0) === 0) return { status: 'completed' };
    return {
      status: 'failed',
      error: `进程退出码 ${code === null ? 'null' : code}${signal ? ` (${signal})` : ''}`
    };
  }

  private requestStop(record: BackgroundTaskRecord): void {
    const child = record.child;
    if (!child || record.finalized) return;
    const pid = child.pid;

    if (process.platform === 'win32' && pid !== undefined) {
      const graceful = spawn('taskkill', ['/PID', String(pid), '/T'], {
        stdio: 'ignore',
        windowsHide: true
      });
      graceful.once('error', () => {
        try {
          child.kill();
        } catch {}
      });
    } else {
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    }

    if (record.killEscalationHandle) return;
    record.killEscalationHandle = setTimeout(() => {
      if (record.finalized) return;
      if (process.platform === 'win32' && pid !== undefined) {
        const forced = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        });
        forced.once('error', () => {
          record.snapshot.error = [record.snapshot.error, '强制终止进程树失败，可能残留子进程']
            .filter(Boolean)
            .join('; ');
          try {
            child.kill('SIGKILL');
          } catch {}
        });
      } else {
        try {
          if (pid !== undefined) process.kill(-pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }
    }, KILL_GRACE_MS);
    record.killEscalationHandle.unref?.();
  }

  private async closeOutput(record: BackgroundTaskRecord): Promise<void> {
    const stream = record.stream;
    record.stream = undefined;
    if (!stream || stream.destroyed || stream.closed) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private async finalize(
    record: BackgroundTaskRecord,
    status: 'completed' | 'failed' | 'killed',
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error?: string
  ): Promise<void> {
    if (record.finalized) return;
    record.finalized = true;
    if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
    if (record.killEscalationHandle) clearTimeout(record.killEscalationHandle);
    if (record.progressUpdateHandle) clearTimeout(record.progressUpdateHandle);

    await this.closeOutput(record).catch((closeError) => {
      status = 'failed';
      error = [error, `关闭日志失败: ${String(closeError)}`].filter(Boolean).join('; ');
    });

    record.snapshot.status = status;
    record.snapshot.endTime = this.now();
    record.snapshot.exitCode = exitCode;
    record.snapshot.signal = signal;
    if (error) record.snapshot.error = error;
    delete record.snapshot.pid;

    try {
      await this.persist(record);
    } catch (persistError) {
      record.snapshot.status = 'failed';
      record.snapshot.error = [
        record.snapshot.error,
        `保存终态失败: ${persistError instanceof Error ? persistError.message : String(persistError)}`
      ]
        .filter(Boolean)
        .join('; ');
    }

    for (const waiter of record.waiters.splice(0)) waiter();
    this.emitChange();
    if (!this.shuttingDown) {
      try {
        await this.onTerminal(cloneSnapshot(record.snapshot));
      } catch (notificationError) {
        console.error('[background-tasks] completion notification failed:', notificationError);
      }
    }
    await this.pruneOldTasks();
  }

  private persist(record: BackgroundTaskRecord): Promise<void> {
    record.metadataWriteChain = record.metadataWriteChain
      .catch(() => {})
      .then(() => writeJsonDurable(record.metadataPath, record.snapshot));
    return record.metadataWriteChain;
  }

  private emitChange(): void {
    try {
      this.onChange(this.list());
    } catch (error) {
      console.error('[background-tasks] state update failed:', error);
    }
  }

  private async pruneOldTasks(): Promise<void> {
    if (this.tasks.size <= this.maxRecentTasks) return;
    const removable = [...this.tasks.values()]
      .filter((record) => isBackgroundTaskTerminal(record.snapshot.status))
      .sort(
        (a, b) =>
          (a.snapshot.endTime ?? a.snapshot.startTime) -
          (b.snapshot.endTime ?? b.snapshot.startTime)
      );
    while (this.tasks.size > this.maxRecentTasks && removable.length > 0) {
      const record = removable.shift();
      if (!record) break;
      this.tasks.delete(record.snapshot.id);
      await removeBackgroundTaskArtifacts(record.taskDir).catch(() => {});
    }
  }
}
