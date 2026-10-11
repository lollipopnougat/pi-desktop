import {
  defineTool,
  type ExtensionAPI,
  type InlineExtension
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BackgroundTaskController } from './controller';
import type { BackgroundTaskSnapshot } from './types';

function formatTask(task: BackgroundTaskSnapshot): string {
  const elapsed = (task.endTime ?? Date.now()) - task.startTime;
  const seconds = Math.max(0, Math.round(elapsed / 1000));
  const exit = task.exitCode === undefined ? '' : `, exit=${task.exitCode}`;
  const error = task.error ? `\n  error: ${task.error}` : '';
  const command = task.command.length > 500 ? `${task.command.slice(0, 500)}…` : task.command;
  return `${task.id} [${task.status}] ${task.name} (${seconds}s${exit})\n  ${command}${error}`;
}

function ownerFromContext(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

export function backgroundTaskExtensionFactory(
  controller: BackgroundTaskController
): InlineExtension {
  return {
    name: 'background-tasks',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const bindingToken = {};

      pi.registerTool(
        defineTool({
          name: 'bg_run',
          label: '后台运行',
          description:
            '在后台启动一个具名 shell 命令并立即返回任务 ID。适合测试、构建、开发服务器和 watcher 等长任务。任务结束后默认发送持久完成通知并自动触发 follow-up；不要用 sleep 或反复查询状态等待。',
          promptSnippet: '启动长时间 shell 命令并在完成时自动通知',
          promptGuidelines: [
            '长时间测试、构建、开发服务器或 watcher 应使用 bg_run，而不是让 bash 长时间阻塞。',
            'bg_run 默认会在任务结束时发送通知并唤醒后续轮次；启动后不要通过 sleep、bg_status 或 bg_logs 轮询等待。',
            '调用 bg_run 时提供简短明确的 name；仅当命令实际启动 Pi/LLM agent 时才设置 isAgent=true。',
            '后台命令拥有完整 shell 权限；不要用 bg_run 绕过用户权限审批。'
          ],
          parameters: Type.Object({
            command: Type.String({
              description: '要执行的 shell 命令',
              minLength: 1,
              maxLength: 32768
            }),
            name: Type.String({
              description: '2-6 个词的简短任务名',
              minLength: 1,
              maxLength: 120
            }),
            description: Type.Optional(
              Type.String({ description: '更详细的任务说明', maxLength: 2000 })
            ),
            isAgent: Type.Optional(
              Type.Boolean({ description: '命令是否会启动 Pi/LLM agent，默认 false' })
            ),
            notifyOnCompletion: Type.Optional(
              Type.Boolean({ description: '结束后发送通知，默认 true' })
            ),
            triggerOnCompletion: Type.Optional(
              Type.Boolean({ description: '通知是否自动触发 Agent 后续轮次，默认 true' })
            ),
            timeoutSeconds: Type.Optional(
              Type.Integer({
                description: '可选超时秒数，范围 1-604800',
                minimum: 1,
                maximum: 604800
              })
            )
          }),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const task = await controller.start(
              {
                command: params.command,
                name: params.name,
                description: params.description,
                isAgent: params.isAgent,
                notifyOnCompletion: params.notifyOnCompletion,
                triggerOnCompletion: params.triggerOnCompletion,
                timeoutSeconds: params.timeoutSeconds
              },
              ownerFromContext(ctx)
            );
            const delivery = task.notifyOnCompletion
              ? task.triggerOnCompletion
                ? '结束后会通知并自动触发后续轮次，无需轮询。'
                : '结束后会通知，但不会自动触发后续轮次。'
              : '完成通知已关闭；仅在确有需要时手动查询，勿高频轮询。';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `后台任务已启动：${task.name} (${task.id})\n日志：${task.outputPath}\n${delivery}`
                }
              ],
              details: { task }
            };
          }
        })
      );

      pi.registerTool(
        defineTool({
          name: 'bg_status',
          label: '后台任务状态',
          description:
            '查看一个后台任务或最近任务列表的即时状态。它不是等待原语；默认完成通知已足够，不要反复轮询。',
          promptSnippet: '按需查看后台任务即时状态，不用于轮询等待',
          promptGuidelines: [
            '仅在用户明确要求进度、自动通知被关闭或有具体证据表明任务卡住时调用 bg_status。',
            '收到后台任务终态通知后不要再调用 bg_status 重复确认。'
          ],
          parameters: Type.Object({
            taskId: Type.Optional(Type.String({ description: '完整任务 ID 或唯一前缀' }))
          }),
          async execute(_toolCallId, params) {
            const tasks = params.taskId
              ? [controller.getSnapshot().tasks.find((task) => task.id === params.taskId) ?? null]
              : controller.getSnapshot().tasks;
            let selected = tasks.filter((task): task is BackgroundTaskSnapshot => task !== null);
            if (params.taskId && selected.length === 0) {
              // Controller/registry also supports unique prefixes; use log-free lookup via a tiny read.
              const all = controller
                .getSnapshot()
                .tasks.filter((task) => task.id.startsWith(params.taskId!));
              if (all.length === 0) throw new Error(`未找到后台任务: ${params.taskId}`);
              if (all.length > 1) throw new Error(`任务 ID 前缀不唯一: ${params.taskId}`);
              selected = all;
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    selected.length > 0 ? selected.map(formatTask).join('\n\n') : '暂无后台任务。'
                }
              ],
              details: { tasks: selected }
            };
          }
        })
      );

      pi.registerTool(
        defineTool({
          name: 'bg_logs',
          label: '后台任务日志',
          description:
            '按需读取后台任务的有界日志，最多返回 50KB，并提供完整日志文件路径。不要通过连续调用此工具等待任务完成。',
          promptSnippet: '读取后台任务的有界日志片段',
          promptGuidelines: [
            '只在确实需要诊断任务输出时调用 bg_logs；不要反复 tail 日志来等待任务完成。'
          ],
          parameters: Type.Object({
            taskId: Type.String({ description: '完整任务 ID 或唯一前缀', minLength: 1 }),
            tail: Type.Optional(Type.Boolean({ description: 'true 读取尾部，false 读取头部' })),
            maxBytes: Type.Optional(
              Type.Integer({
                description: '最大返回字节数，最多 51200',
                minimum: 1,
                maximum: 51200
              })
            )
          }),
          async execute(_toolCallId, params) {
            const result = await controller.readLogs(params.taskId, {
              tail: params.tail,
              maxBytes: params.maxBytes
            });
            let text = result.content || '(暂无日志输出)';
            if (result.truncated) {
              text += result.tail
                ? `\n\n[日志前部已省略；完整日志：${result.outputPath}]`
                : `\n\n[日志后部已省略；完整日志：${result.outputPath}]`;
            }
            return {
              content: [{ type: 'text' as const, text }],
              details: result
            };
          }
        })
      );

      pi.registerTool(
        defineTool({
          name: 'bg_kill',
          label: '停止后台任务',
          description: '停止一个正在运行的后台任务。已经结束或不存在的任务会明确报错。',
          promptSnippet: '停止指定后台任务',
          parameters: Type.Object({
            taskId: Type.String({ description: '完整任务 ID 或唯一前缀', minLength: 1 })
          }),
          async execute(_toolCallId, params) {
            const task = await controller.stop(params.taskId);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `已请求停止后台任务 ${task.name} (${task.id})。终态将在进程退出后发布。`
                }
              ],
              details: { task }
            };
          }
        })
      );

      pi.on('session_start', (_event, ctx) => {
        controller.bindSession(bindingToken, ownerFromContext(ctx), (message, options) => {
          pi.sendMessage(message, options);
        });
      });

      pi.on('session_shutdown', () => {
        controller.unbindSession(bindingToken);
      });
    }
  };
}
