/**
 * SubagentExecutor:创建并驱动子 AgentSession(in-process)。
 *
 * 关键决策(参考 oh-my-pi 的 in-process 架构):
 * - 子 session 直接复用主进程的 ModelRuntime(鉴权/模型清单/缓存),零 IPC
 * - SessionManager.inMemory():子会话不落盘,不污染会话列表与树
 * - 复用 pi-bridge 的 createAgentSessionServices 装配方式(noExtensions,
 *   extensionFactories 注入 childExtensionFactory)
 * - session.subscribe 聚合进度 → controller 推渲染进程
 * - submit 契约:child-extension 的 onSubmit resolver;兜底取最后一条 assistant 文本
 */
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent
} from '@earendil-works/pi-coding-agent';
import path from 'path';
import type { PiBridge } from '../pi-bridge';
import type { SessionHost } from '../session-slot';
import type {
  AgentDefinition,
  ChildRun,
  ChildToolCall,
  ChildTranscriptItem,
  SubmitPayload
} from './types';
import { applyTranscriptEvent, trimTranscript } from './transcript';
import { ensureSubagentSessionDir } from './session-file';
import { childExtensionFactory, withContractTools, type ChildRunContext } from './child-extension';
import { resolveSpawnList } from './registry';
import type { SubagentController } from './controller';

export interface SpawnOptions {
  /** 逻辑 run 记录(controller 已建) */
  run: ChildRun;
  /** 已解析的 agent 定义 */
  definition: AgentDefinition;
  /** 模型覆盖(provider/modelId);缺省用定义或继承父会话模型 */
  modelOverride?: string;
  /** 递归 spawn 入口(由 controller 提供,用于深度内嵌套委派) */
  spawnChild?: ChildRunContext['spawnChild'];
  /** 完成回调(状态迁移后的 run) */
  onFinish: (run: ChildRun) => void;
  /** 进度回调(每次进度更新) */
  onProgress: (run: ChildRun) => void;
}

export interface SpawnOutcome {
  run: ChildRun;
}

let childSeq = 0;
function newRunId(): string {
  childSeq += 1;
  return `sa-${Date.now().toString(36)}-${childSeq}`;
}
export { newRunId };

export class SubagentExecutor {
  private piBridge: PiBridge;
  private controller: SubagentController;
  /** 所服务的父会话（Stage 0 = 焦点槽；多会话阶段按槽注入） */
  private host: SessionHost;
  /** 活跃子 session(run id → session),用于 stop/steer */
  private activeSessions = new Map<string, AgentSession>();
  /** submit resolver(run id → resolve) */
  private submitResolvers = new Map<string, (p: SubmitPayload) => void>();

  constructor(piBridge: PiBridge, controller: SubagentController, host: SessionHost) {
    this.piBridge = piBridge;
    this.controller = controller;
    this.host = host;
  }

  get builtinAgentsDir(): string {
    // 与 builtinSkillsDir 同款解析:打包后 extraResources,开发态项目源码目录
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged
      ? path.join(process.resourcesPath, 'agents')
      : path.resolve(__dirname, '..', 'resources', 'agents');
  }

  /**
   * 创建并驱动一个子 agent。
   * resolve 时机:submit 提交 / agent_settled(fallback) / 异常 / abort。
   */
  async spawn(opts: SpawnOptions): Promise<SpawnOutcome> {
    const { run, definition } = opts;
    run.startedAt = Date.now();
    run.status = 'running';
    run.progress = { recentTools: [], turns: 0, tokens: 0, durationMs: 0 };

    // submit 契约 resolver
    const submitPromise = new Promise<SubmitPayload | null>((resolve) => {
      // resolver 签名为 (p: SubmitPayload) => void,统一归一 null
      this.submitResolvers.set(run.id, (p) => resolve(p ?? null));
    });

    // 父会话当前模型(继承缺省)
    const parentModel = this.host.current()?.model;
    const modelRef = opts.modelOverride ?? definition.model;
    let model: typeof parentModel | undefined;
    if (modelRef) {
      const [providerId, modelId] = modelRef.split('/');
      const resolved = this.piBridge.modelRuntime?.getModel(providerId, modelId);
      if (!resolved) {
        run.status = 'failed';
        run.error = `模型 ${modelRef} 不可用(未配置 Key 或模型不存在)`;
        run.endedAt = Date.now();
        opts.onFinish(run);
        return { run };
      }
      model = resolved;
    } else {
      model = parentModel;
    }

    // 可派生的子 agent 名单(递归 task 工具 description 用)
    const spawnList = resolveSpawnList(definition.spawns);
    const spawnableAgents =
      spawnList === 'none'
        ? []
        : this.controller
            .getDefinitions()
            .filter((d) => (spawnList === 'any' ? true : spawnList.includes(d.name)));

    // 子 session 运行上下文
    const ctx: ChildRunContext = {
      agentName: definition.name,
      rolePrompt: definition.systemPrompt,
      depth: run.depth,
      maxDepth: this.controller.maxDepth,
      onSubmit: (payload) => {
        this.submitResolvers.get(run.id)?.(payload);
        this.submitResolvers.delete(run.id);
      },
      spawnChild: opts.spawnChild,
      spawnableAgents: spawnableAgents.map((d) => ({ name: d.name, description: d.description }))
    };

    let session: AgentSession;
    try {
      const cwd = this.host.cwd();
      const agentDir = this.piBridge.agentDir;
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: this.piBridge.modelRuntime!,
        resourceLoaderOptions: {
          noExtensions: true,
          // 子 agent 不加载 skills/prompts 等主会话资源,保持角色纯净
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [childExtensionFactory(ctx)]
        }
      });
      // 子会话落盘为标准 SDK 会话文件(独立目录,不进主会话列表);
      // 详情弹窗重启后靠它回放完整对话。目录不可写时退回内存会话(不影响执行)
      let sessionManager: SessionManager;
      try {
        sessionManager = SessionManager.create(cwd, ensureSubagentSessionDir(), {
          parentSession: this.host.current()?.sessionFile
        });
        run.sessionFile = sessionManager.getSessionFile();
      } catch {
        sessionManager = SessionManager.inMemory(cwd);
        run.sessionFile = undefined;
      }
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: model as never,
        thinkingLevel: definition.thinkingLevel,
        // 角色定义里的 tools 是能力白名单,但不能挡掉契约工具(submit / task):
        // SDK 的 tools 选项是硬白名单,不在名单里的扩展工具会被移出注册表。
        tools: withContractTools(definition.tools),
        customTools: []
      });
      session = created.session;
    } catch (e) {
      run.status = 'failed';
      run.error = `子 session 创建失败: ${(e as Error).message}`;
      run.endedAt = Date.now();
      opts.onFinish(run);
      return { run };
    }

    // 创建 services/session 的异步间隙内可能已切换或退出，不能再启动旧任务。
    if ((run.status as string) === 'stopped') {
      this.submitResolvers.delete(run.id);
      session.dispose();
      opts.onFinish(run);
      return { run };
    }

    this.activeSessions.set(run.id, session);

    // 进度聚合
    const startedMs = run.startedAt;
    const progress = run.progress!;
    // 工具调用流水(详情视图)
    const toolCalls: ChildToolCall[] = [];
    run.toolCalls = toolCalls;
    // 对话流(详情视图「对话」Tab;仅内存)
    const transcript: ChildTranscriptItem[] = [];
    run.transcript = transcript;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.handleChildEvent(run, event, progress, startedMs, opts, toolCalls, transcript);
    });

    // 驱动:prompt + 竞速(submit / settled fallback / abort)
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    try {
      const drivePromise = session.prompt(this.buildTaskPrompt(run, opts));
      const resultPromise = Promise.race([
        submitPromise.then((p) => ({ kind: 'submit' as const, payload: p })),
        drivePromise.then(() => ({ kind: 'settled' as const, payload: null }))
      ]);

      const raced = await resultPromise;

      if (raced.kind === 'submit' && raced.payload !== null) {
        const payload: SubmitPayload = raced.payload;
        settle(() => this.applySubmit(run, payload, session));
      } else {
        // prompt 结束但没 submit → 兜底取最后一条 assistant 文本
        settle(() => this.applyFallback(run, session));
      }
      // submit 后 prompt 可能仍在流式尾巴上,等待完全空闲再收尾
      await session.waitForIdle().catch(() => {});
    } catch (e) {
      const msg = (e as Error).message || String(e);
      settle(() => {
        // 用户停止(abort)与异常区分
        if (run.status === 'stopped') return;
        run.status = 'failed';
        run.error = `执行异常: ${msg}`;
        run.endedAt = Date.now();
      });
    } finally {
      this.submitResolvers.delete(run.id);
      this.activeSessions.delete(run.id);
      unsubscribe();
      this.flushUsage(run, session);
      try {
        session.dispose();
      } catch {}
      run.endedAt = run.endedAt ?? Date.now();
      opts.onProgress(run);
      opts.onFinish(run);
    }

    return { run };
  }

  /** 组装子 agent 的任务 prompt */
  private buildTaskPrompt(run: ChildRun, _opts: SpawnOptions): string {
    return run.task;
  }

  /** 处理子 session 事件 → 进度聚合 + 工具调用流水 */
  private handleChildEvent(
    run: ChildRun,
    event: AgentSessionEvent,
    progress: NonNullable<ChildRun['progress']>,
    startedMs: number,
    opts: SpawnOptions,
    toolCalls: ChildToolCall[],
    transcript: ChildTranscriptItem[]
  ): void {
    let dirty = false;
    try {
      // 对话流采集(与工具流水并行;顺序即模型输出顺序)
      if (applyTranscriptEvent(transcript, event)) dirty = true;
      switch (event.type) {
        case 'tool_execution_start': {
          progress.currentTool = event.toolName;
          progress.currentToolArgs = summarizeArgs(event.args);
          // 工具调用流水:开始入队(pending)
          toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            pending: true,
            startedAt: Date.now()
          });
          dirty = true;
          break;
        }
        case 'tool_execution_end': {
          progress.recentTools.push({ tool: event.toolName, endMs: Date.now() });
          if (progress.recentTools.length > 5) progress.recentTools.shift();
          progress.currentTool = undefined;
          progress.currentToolArgs = undefined;
          // 工具调用流水:回填结果(按 toolCallId 匹配)
          const tc = toolCalls.find((t) => t.toolCallId === event.toolCallId);
          if (tc) {
            tc.result = event.result;
            tc.isError = event.isError;
            tc.pending = false;
            tc.endedAt = Date.now();
          } else {
            // 兜底:start 事件未捕获时直接补一条完成记录
            toolCalls.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              pending: false,
              startedAt: Date.now(),
              endedAt: Date.now()
            });
          }
          dirty = true;
          break;
        }
        case 'message_end': {
          const msg = event.message as { role?: string };
          if (msg?.role === 'assistant') {
            progress.turns += 1;
            dirty = true;
          }
          break;
        }
        case 'agent_end': {
          this.flushUsage(run, this.activeSessions.get(run.id));
          dirty = true;
          break;
        }
      }
    } catch {
      // 进度聚合失败不影响子 agent 执行
    }
    if (dirty) {
      progress.durationMs = Date.now() - startedMs;
      // 流水上限 200 条,超出丢弃最旧(防长任务快照膨胀)
      if (toolCalls.length > 200) {
        toolCalls.splice(0, toolCalls.length - 200);
      }
      trimTranscript(transcript);
      opts.onProgress(run);
    }
  }

  /** submit 结果落地 */
  private applySubmit(run: ChildRun, payload: SubmitPayload, session: AgentSession): void {
    run.output = payload.summary;
    run.outputData = payload.data;
    run.outputSource = 'submit';
    run.status = payload.status === 'success' ? 'complete' : 'failed';
    if (run.status === 'failed' && !run.error) run.error = payload.summary;
    run.endedAt = Date.now();
    // submit 已是终点,中止仍在进行的循环(若有)
    session.abort().catch(() => {});
  }

  /** 未 submit 兜底:取最后一条 assistant 文本 */
  private applyFallback(run: ChildRun, session: AgentSession): void {
    let text: string | undefined;
    try {
      text = session.getLastAssistantText();
    } catch {}
    if (run.status === 'stopped') return;
    if (text && text.trim()) {
      run.output = text.trim();
      run.outputSource = 'fallback';
      run.status = 'complete';
      run.error = undefined;
    } else {
      run.status = 'failed';
      run.error = '子 agent 未调用 submit 且无 assistant 输出';
    }
    run.endedAt = Date.now();
  }

  /** 会话用量 → run.usage */
  private flushUsage(run: ChildRun, session?: AgentSession): void {
    try {
      const s = session ?? this.activeSessions.get(run.id);
      const stats = s?.getSessionStats?.();
      if (stats?.tokens) {
        run.usage = {
          input: stats.tokens.input ?? 0,
          output: stats.tokens.output ?? 0,
          cacheRead: stats.tokens.cacheRead ?? 0,
          cacheWrite: stats.tokens.cacheWrite ?? 0
        };
      }
    } catch {}
  }

  /** 停止运行中的子 agent(用户操作 / 会话切换清理) */
  async stop(runId: string): Promise<void> {
    const run = this.controller.getRun(runId);
    const session = this.activeSessions.get(runId);
    if (!session) return;
    if (run && (run.status === 'running' || run.status === 'queued')) {
      run.status = 'stopped';
      run.endedAt = Date.now();
    }
    this.submitResolvers.delete(runId);
    try {
      await session.abort();
    } catch {}
  }

  /** 向运行中的子 agent 发送指导(steer) */
  async steer(runId: string, text: string): Promise<boolean> {
    const session = this.activeSessions.get(runId);
    if (!session) return false;
    try {
      await session.steer(text);
      return true;
    } catch {
      return false;
    }
  }

  get hasActiveSessions(): boolean {
    return this.activeSessions.size > 0;
  }

  /** 当前活跃子 session 数(并发观测) */
  get activeCount(): number {
    return this.activeSessions.size;
  }
}

/** 工具参数摘要(进度展示用,截断长参数) */
function summarizeArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return undefined;
  }
}

/** 供 controller 构建 run 时的 id 生成(导出已上面) */
export function isWritableAgent(definition: AgentDefinition): boolean {
  // 工具白名单为空 = 全量(含写);含 edit/write/bash 视为可写
  if (!definition.tools) return true;
  return definition.tools.some((t) => ['edit', 'write', 'bash'].includes(t));
}
