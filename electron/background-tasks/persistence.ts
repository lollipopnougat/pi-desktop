import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isBackgroundTaskStatus, type BackgroundTaskSnapshot } from './types';

export const BACKGROUND_TASKS_DIR_NAME = 'tasks';
export const BACKGROUND_TASK_METADATA_FILE = 'metadata.json';
export const BACKGROUND_TASK_OUTPUT_FILE = 'output.log';

export interface PersistedBackgroundTask {
  snapshot: BackgroundTaskSnapshot;
  taskDir: string;
  metadataPath: string;
  outputPath: string;
}

/** Stable project bucket without exposing the cwd in directory names. */
export function backgroundTaskProjectKey(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function backgroundTasksRoot(agentDir: string): string {
  return path.join(agentDir, BACKGROUND_TASKS_DIR_NAME);
}

export function backgroundTaskPaths(agentDir: string, cwd: string, taskId: string) {
  const projectKey = backgroundTaskProjectKey(cwd);
  const taskDir = path.join(backgroundTasksRoot(agentDir), projectKey, taskId);
  return {
    projectKey,
    taskDir,
    metadataPath: path.join(taskDir, BACKGROUND_TASK_METADATA_FILE),
    outputPath: path.join(taskDir, BACKGROUND_TASK_OUTPUT_FILE)
  };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(tempPath: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST');
      if (!retryable || attempt === 5) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  await rm(tempPath, { force: true }).catch(() => {});
  throw lastError;
}

/** Write JSON using temp + fsync + rename; the rename is the commit point. */
export async function writeJsonDurable(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await replaceFile(tempPath, filePath);
  await syncDirectory(dir);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseBackgroundTaskSnapshot(
  value: unknown,
  outputPath: string,
  projectKey: string
): BackgroundTaskSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.command !== 'string' ||
    !isBackgroundTaskStatus(raw.status) ||
    typeof raw.cwd !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.startTime !== 'number' ||
    !Number.isFinite(raw.startTime)
  ) {
    return null;
  }

  const snapshot: BackgroundTaskSnapshot = {
    id: raw.id,
    name: raw.name,
    command: raw.command,
    status: raw.status,
    cwd: raw.cwd,
    projectKey,
    sessionId: raw.sessionId,
    outputPath,
    startTime: raw.startTime,
    bytesWritten: optionalFiniteNumber(raw.bytesWritten) ?? 0,
    isAgent: raw.isAgent === true,
    notifyOnCompletion: raw.notifyOnCompletion !== false,
    triggerOnCompletion: raw.triggerOnCompletion !== false
  };
  const description = optionalString(raw.description);
  const error = optionalString(raw.error);
  const endTime = optionalFiniteNumber(raw.endTime);
  const exitCode = raw.exitCode === null ? null : optionalFiniteNumber(raw.exitCode);
  const signal = raw.signal === null ? null : optionalString(raw.signal);
  const pid = optionalFiniteNumber(raw.pid);
  const timeoutSeconds = optionalFiniteNumber(raw.timeoutSeconds);
  if (description !== undefined) snapshot.description = description;
  if (error !== undefined) snapshot.error = error;
  if (endTime !== undefined) snapshot.endTime = endTime;
  if (exitCode !== undefined || raw.exitCode === null) snapshot.exitCode = exitCode;
  if (signal !== undefined || raw.signal === null) snapshot.signal = signal;
  if (pid !== undefined) snapshot.pid = pid;
  if (timeoutSeconds !== undefined) snapshot.timeoutSeconds = timeoutSeconds;
  return snapshot;
}

export async function loadPersistedBackgroundTasks(
  agentDir: string
): Promise<PersistedBackgroundTask[]> {
  const root = backgroundTasksRoot(agentDir);
  const loaded: PersistedBackgroundTask[] = [];
  let projects: fs.Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let taskDirs: fs.Dirent[];
    try {
      taskDirs = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const taskDirEntry of taskDirs) {
      if (!taskDirEntry.isDirectory()) continue;
      const taskDir = path.join(projectDir, taskDirEntry.name);
      const metadataPath = path.join(taskDir, BACKGROUND_TASK_METADATA_FILE);
      const outputPath = path.join(taskDir, BACKGROUND_TASK_OUTPUT_FILE);
      try {
        const raw = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
        const snapshot = parseBackgroundTaskSnapshot(raw, outputPath, project.name);
        if (!snapshot || snapshot.id !== taskDirEntry.name) continue;
        try {
          snapshot.bytesWritten = (await stat(outputPath)).size;
        } catch {
          snapshot.bytesWritten = 0;
        }
        loaded.push({ snapshot, taskDir, metadataPath, outputPath });
      } catch {
        // A corrupt task record is isolated to its own directory.
      }
    }
  }
  return loaded;
}

export async function readBackgroundTaskLog(
  outputPath: string,
  maxBytes: number,
  tail: boolean
): Promise<{
  content: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
}> {
  let info;
  try {
    info = await stat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: '', totalBytes: 0, returnedBytes: 0, truncated: false };
    }
    throw error;
  }
  const totalBytes = info.size;
  const returnedBytes = Math.min(totalBytes, maxBytes);
  const start = tail ? Math.max(0, totalBytes - returnedBytes) : 0;
  const handle = await open(outputPath, 'r');
  try {
    const buffer = Buffer.alloc(returnedBytes);
    if (returnedBytes > 0) await handle.read(buffer, 0, returnedBytes, start);
    return {
      content: buffer.toString('utf8'),
      totalBytes,
      returnedBytes,
      truncated: returnedBytes < totalBytes
    };
  } finally {
    await handle.close();
  }
}

export async function removeBackgroundTaskArtifacts(taskDir: string): Promise<void> {
  await rm(taskDir, { recursive: true, force: true });
}
