export const BACKGROUND_TASK_STATUSES = [
  'running',
  'completed',
  'failed',
  'killed',
  'interrupted'
] as const;

export type BackgroundTaskStatus = (typeof BACKGROUND_TASK_STATUSES)[number];
export type BackgroundTaskKillReason = 'user' | 'timeout' | 'output_limit' | 'shutdown';

export interface BackgroundTaskSnapshot {
  id: string;
  name: string;
  command: string;
  description?: string;
  status: BackgroundTaskStatus;
  cwd: string;
  projectKey: string;
  sessionId: string;
  outputPath: string;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  bytesWritten: number;
  isAgent: boolean;
  error?: string;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number;
}

export interface BackgroundTaskSnapshotList {
  tasks: BackgroundTaskSnapshot[];
}

/** 单条删除失败的详情（如任务仍在运行、ID 未知） */
export interface BackgroundTaskRemoveFailure {
  id: string;
  error: string;
}

/** 批量删除后台任务记录的结果；failed 非空表示部分/全部未删除成功 */
export interface BackgroundTaskRemoveResult {
  removed: string[];
  failed: BackgroundTaskRemoveFailure[];
}

export interface BackgroundTaskLogResult {
  taskId: string;
  content: string;
  outputPath: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
  tail: boolean;
}

export interface StartBackgroundTaskInput {
  command: string;
  name: string;
  description?: string;
  isAgent?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  timeoutSeconds?: number;
}

export interface BackgroundTaskOwner {
  cwd: string;
  sessionId: string;
}

export function isBackgroundTaskStatus(value: unknown): value is BackgroundTaskStatus {
  return (
    typeof value === 'string' && (BACKGROUND_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return status !== 'running';
}
