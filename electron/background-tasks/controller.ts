import type { BrowserWindow } from 'electron';
import { t } from '../../src/i18n/zh';
import { showSystemNotification } from '../notifications';
import { BackgroundTaskRegistry } from './registry';
import type {
  BackgroundTaskLogResult,
  BackgroundTaskOwner,
  BackgroundTaskRemoveResult,
  BackgroundTaskSnapshot,
  BackgroundTaskSnapshotList,
  StartBackgroundTaskInput
} from './types';

interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details: BackgroundTaskSnapshot;
}

interface CompletionMessageOptions {
  deliverAs: 'followUp';
  triggerTurn: boolean;
}

interface SessionBinding {
  token: object;
  cwd: string;
  sessionId: string;
  sendMessage: (message: CompletionMessage, options: CompletionMessageOptions) => void;
}

export interface BackgroundTaskHost {
  readonly win: BrowserWindow | null;
  readonly cwd: string;
  readonly agentDir: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function completionContent(task: BackgroundTaskSnapshot): string {
  const exitCode = task.exitCode === undefined ? '' : `\n  <exit-code>${task.exitCode}</exit-code>`;
  const error = task.error ? `\n  <error>${escapeXml(task.error)}</error>` : '';
  return [
    '<background-task-notification>',
    `  <task-id>${escapeXml(task.id)}</task-id>`,
    `  <task-name>${escapeXml(task.name)}</task-name>`,
    `  <status>${task.status}</status>`,
    exitCode,
    error,
    `  <output-file>${escapeXml(task.outputPath)}</output-file>`,
    `  <summary>${escapeXml(`后台任务“${task.name}”${t.backgroundTasks.statusText(task.status)}`)}</summary>`,
    '  <guidance>终态已经持久化，不要调用 bg_status 重复确认；仅在需要输出内容时调用 bg_logs。</guidance>',
    '</background-task-notification>'
  ]
    .filter(Boolean)
    .join('\n');
}

export class BackgroundTaskController {
  private readonly host: BackgroundTaskHost;
  private readonly registry: BackgroundTaskRegistry;
  /**
   * 每个会话槽一份绑定（key = 扩展持有的 token）：后台任务完成时按任务所属会话回灌，
   * 多会话下不会把 A 会话的任务通知发到 B 会话（旧实现是单槽，后者会顶掉前者）。
   */
  private readonly bindings = new Map<object, SessionBinding>();

  constructor(host: BackgroundTaskHost) {
    this.host = host;
    this.registry = new BackgroundTaskRegistry({
      agentDir: host.agentDir,
      onChange: (tasks) => this.emitUpdate(tasks),
      onTerminal: (task) => this.handleTerminal(task)
    });
  }

  initialize(): Promise<void> {
    return this.registry.initialize();
  }

  bindSession(
    token: object,
    owner: BackgroundTaskOwner,
    sendMessage: SessionBinding['sendMessage']
  ): void {
    this.bindings.set(token, { token, ...owner, sendMessage });
    this.emitUpdate(this.registry.list());
  }

  unbindSession(token: object): void {
    this.bindings.delete(token);
  }

  start(
    input: StartBackgroundTaskInput,
    owner: BackgroundTaskOwner
  ): Promise<BackgroundTaskSnapshot> {
    return this.registry.start(input, owner);
  }

  getSnapshot(): BackgroundTaskSnapshotList {
    return { tasks: this.registry.list() };
  }

  stop(taskId: string): Promise<BackgroundTaskSnapshot> {
    return this.registry.stop(taskId, 'user');
  }

  /** 清理后台任务记录（含磁盘日志）。运行中的任务会被拒绝，需先 stop。 */
  remove(taskIds: string[]): Promise<BackgroundTaskRemoveResult> {
    return this.registry.remove(taskIds);
  }

  readLogs(
    taskId: string,
    options?: { tail?: boolean; maxBytes?: number }
  ): Promise<BackgroundTaskLogResult> {
    return this.registry.readLogs(taskId, options);
  }

  async dispose(): Promise<void> {
    this.bindings.clear();
    await this.registry.dispose();
  }

  private emitUpdate(tasks: BackgroundTaskSnapshot[]): void {
    const win = this.host.win;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('pi:backgroundTaskUpdate', { tasks });
    } catch {
      // The renderer may disappear while a task is emitting progress.
    }
  }

  private handleTerminal(task: BackgroundTaskSnapshot): void {
    if (!task.notifyOnCompletion || this.registry.isShuttingDown()) return;

    showSystemNotification(
      this.host.win,
      'backgroundTask',
      t.backgroundTasks.notificationTitle,
      t.backgroundTasks.notificationBody(task.name, task.status)
    );

    // 回灌到「任务所属」的会话（按 sessionId + cwd 匹配；会话已关就只留系统通知）
    const binding = [...this.bindings.values()].find(
      (candidate) => candidate.sessionId === task.sessionId && candidate.cwd === task.cwd
    );
    if (!binding) return;

    binding.sendMessage(
      {
        customType: 'background-task-notification',
        content: completionContent(task),
        display: true,
        details: task
      },
      {
        deliverAs: 'followUp',
        triggerTurn: task.triggerOnCompletion
      }
    );
  }
}
