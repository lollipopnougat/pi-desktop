/**
 * SubagentController:主进程侧状态机 + 调度 + 渲染进程推送。
 *
 * 职责(仿 GoalController 模式):
 * - 持有 agent 定义注册表(builtin < user < project 合并)
 * - run 表(活跃 + 最近结束,上限 50)
 * - 并发信号量(默认 3):batch 内排队执行
 * - 深度上限(默认 2):子 agent 到顶不注册 task 工具(executor 侧)
 * - task 工具执行入口(flat/batch/async,tools.ts 调用)
 * - stop / steer 控制(IPC)
 * - 快照推送 pi:subagentUpdate
 * - 异步 run 完成 → followUp 回灌父会话(经 subagent 扩展)
 *
 * 首版边界:不做 worktree 隔离 / 横向通信 / park-revive / 子 session 持久化。
 */
import type { PiBridge } from '../pi-bridge';
import type { SessionHost } from '../session-slot';
import { t } from '../../src/i18n/zh';
import { discoverAgents, resolveSpawnList, type RegistryResult } from './registry';
import { SubagentExecutor } from './executor';
import {
  SUBAGENT_STATE_ENTRY_TYPE,
  isTerminalRunStatus,
  serializeChildRun,
  loadRunsFromEntries
} from './persistence';
import type { ChildRun, SubagentSnapshot, TaskItem } from './types';
import {
  deleteSubagentSessionFile,
  readSubagentConversation,
  type SubagentConversation
} from './session-file';
import { buildAsyncResultMessage, buildSyncResultText } from './prompts';

/** 简易并发信号量(支持排队;释放严格配对) */
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return this.makeReleaser();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.permits -= 1;
    return this.makeReleaser();
  }
  private makeReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return; // 幂等,防重复释放
      released = true;
      this.permits += 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_DEPTH = 2;
const MAX_TRACKED_RUNS = 50;

export class SubagentController {
  private piBridge: PiBridge;
  /** 所服务的会话（Stage 0 = 焦点槽；多会话阶段按槽注入） */
  private host: SessionHost;
  private executor: SubagentExecutor;
  private definitions: RegistryResult = { agents: [], diagnostics: [] };
  private runs: ChildRun[] = [];
  private runPromises = new Set<Promise<void>>();
  private generation = 0;
  private stopping = false;
  /** 定义缓存键(cwd),切换项目时重扫 */
  private loadedForCwd = '';
  /** 异步完成回灌回调(由 subagent 扩展注入,解耦 controller ↔ extension) */
  private followUpSender: ((text: string) => void) | null = null;

  maxDepth = DEFAULT_MAX_DEPTH;
  maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  private semaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);

  constructor(piBridge: PiBridge, host: SessionHost) {
    this.piBridge = piBridge;
    this.host = host;
    this.executor = new SubagentExecutor(piBridge, this, host);
  }

  /** subagent 扩展启动时注入 followUp 通道 */
  setFollowUpSender(sender: ((text: string) => void) | null): void {
    this.followUpSender = sender;
  }

  get exec(): SubagentExecutor {
    return this.executor;
  }

  getDefinitions() {
    return this.definitions.agents;
  }

  getRun(id: string): ChildRun | undefined {
    return this.runs.find((r) => r.id === id);
  }

  get activeRuns(): ChildRun[] {
    return this.runs.filter((r) => r.status === 'running' || r.status === 'queued');
  }

  /** 加载 agent 定义(cwd 变化时重扫;每次 task 调用前确保已加载) */
  ensureDefinitionsLoaded(): RegistryResult {
    const cwd = this.host.cwd();
    if (this.loadedForCwd === cwd && this.definitions.agents.length >= 0) {
      // 已为当前 cwd 加载过(空结果也缓存,避免每次扫描)
      if (this.loadedForCwd === cwd) return this.definitions;
    }
    try {
      this.definitions = discoverAgents(
        this.executor.builtinAgentsDir,
        this.piBridge.agentDir,
        cwd
      );
    } catch {
      this.definitions = { agents: [], diagnostics: [] };
    }
    this.loadedForCwd = cwd;
    return this.definitions;
  }

  /** 强制重扫(设置页 agent 文件变更后可调用) */
  reloadDefinitions(): RegistryResult {
    this.loadedForCwd = '';
    return this.ensureDefinitionsLoaded();
  }

  // ─── task 工具执行入口(tools.ts 调用) ───

  /**
   * 执行一次 task 调用:flat 单任务或 batch 多任务。
   * 同步:等全部完成返回合并文本;异步:立即返回启动文本,完成时 followUp 回灌。
   */
  async executeTask(params: {
    agent?: string;
    task?: string;
    context?: string;
    tasks?: TaskItem[];
    async?: boolean;
    model?: string;
    /** 调用者深度(父会话 = 0;递归子 agent > 0) */
    depth: number;
    /** 调用者 agent 名(递归时用于 spawns 白名单校验;父会话为空) */
    callerAgent?: string;
  }): Promise<{ text: string; runIds: string[] }> {
    if (this.stopping) return { text: t.subagentSessionClosing, runIds: [] };
    const defs = this.ensureDefinitionsLoaded();

    // 归一为 item 列表
    let items: TaskItem[];
    const sharedContext = params.context;
    if (params.tasks && params.tasks.length > 0) {
      items = params.tasks;
    } else if (params.agent && params.task) {
      items = [{ agent: params.agent, task: params.task }];
    } else {
      return { text: '错误: 需要提供 agent + task,或 tasks 批量列表。', runIds: [] };
    }

    // 校验 agent 名与 spawns 白名单(递归时)
    const callerDef =
      params.depth > 0 ? (defs.agents.find((a) => a.name === params.callerAgent) ?? null) : null;
    const validItems: TaskItem[] = [];
    for (const item of items) {
      if (!item?.agent || !item.task) {
        return { text: '错误: 每个 tasks 项必须包含 agent 和 task。', runIds: [] };
      }
      const def = defs.agents.find((a) => a.name === item.agent);
      if (!def) {
        const available = defs.agents.map((a) => a.name).join(', ');
        return {
          text: `错误: agent "${item.agent}" 不存在。可用 agent: ${available || '(无,请检查 ~/.pi-desktop/agents/)'}。`,
          runIds: []
        };
      }
      // 递归 spawns 校验:子 agent 只能派生其定义允许的 agent
      if (params.depth > 0) {
        if (!callerDef) {
          return { text: '错误: 递归委派上下文丢失,拒绝执行。', runIds: [] };
        }
        const spawnList = resolveSpawnList(callerDef.spawns);
        if (spawnList === 'none' || (spawnList !== 'any' && !spawnList.includes(item.agent))) {
          return {
            text: `错误: agent "${callerDef.name}" 不允许派生 "${item.agent}"(spawns 白名单限制)。`,
            runIds: []
          };
        }
      }
      validItems.push(item);
    }
    const valid = validItems;

    // 单写者软校验:并行多个可写 agent 时拒绝(硬约束防竞态)
    const writable = valid.map((i) => {
      const def = defs.agents.find((a) => a.name === i.agent)!;
      return !def.tools || def.tools.some((t) => ['edit', 'write', 'bash'].includes(t));
    });
    if (writable.filter(Boolean).length > 1) {
      return {
        text: '错误: 一次 task 调用中最多一个可写(worker 类)agent。多个写者并行会互相覆盖;请拆成多次调用串行执行,或改用只读 agent。',
        runIds: []
      };
    }

    // 并发上限软校验(排队而非拒绝,超量时提示)
    const activeCount = this.activeRuns.length;
    if (activeCount + valid.length > this.maxConcurrency * 3) {
      return {
        text: `错误: 当前活跃子任务过多(${activeCount}),超过安全上限。请等待现有任务完成。`,
        runIds: []
      };
    }

    // 建 run 记录
    const isAsync = !!params.async;
    const created: ChildRun[] = valid.map((item, idx) => {
      const run: ChildRun = {
        id: `sa-${Date.now().toString(36)}-${idx + 1}-${Math.random().toString(36).slice(2, 6)}`,
        name: item.name || item.agent,
        agent: item.agent,
        task: sharedContext ? `${sharedContext}\n\n---\n\n${item.task}` : item.task,
        status: 'queued',
        async: isAsync,
        depth: params.depth,
        createdAt: Date.now(),
        progress: { recentTools: [], turns: 0, tokens: 0, durationMs: 0 }
      };
      return run;
    });
    this.trackRuns(created);
    this.emitUpdate();

    // 启动全部(信号量内并发)
    const defsByName = new Map(defs.agents.map((a) => [a.name, a]));
    const generation = this.generation;
    const promises = created.map((run) =>
      this.runOne(run, defsByName.get(run.agent)!, params.model, params.depth)
    );
    for (const promise of promises) {
      this.runPromises.add(promise);
      void promise.then(
        () => this.runPromises.delete(promise),
        () => this.runPromises.delete(promise)
      );
    }

    if (!isAsync) {
      // 同步:等待全部完成
      await Promise.all(promises);
      const text = buildSyncResultText(
        created.map((r) => ({
          name: r.name,
          agent: r.agent,
          status: r.status,
          output: r.output,
          outputSource: r.outputSource,
          error: r.error
        }))
      );
      return { text, runIds: created.map((r) => r.id) };
    }

    // 异步:立即返回,完成时 followUp 回灌
    void Promise.all(promises).then(() => {
      if (this.generation !== generation) return;
      const message = buildAsyncResultMessage(
        created.map((r) => ({
          name: r.name,
          agent: r.agent,
          status: r.status,
          output: r.output,
          error: r.error
        }))
      );
      this.followUpSender?.(message);
    });
    const started = created.map((r) => `${r.name}(${r.agent})`).join(', ');
    return {
      text: `已启动 ${created.length} 个后台子 agent: ${started}。任务完成后结果会自动送达;期间你可以继续其他工作。`,
      runIds: created.map((r) => r.id)
    };
  }

  /** 派生子 agent 的递归入口(child-extension 的 spawnChild 回调) */
  makeSpawnChild(
    depth: number,
    callerAgentName: string
  ): NonNullable<import('./child-extension').ChildRunContext['spawnChild']> {
    return async (args) => {
      const result = await this.executeTask({
        agent: args.agent,
        task: args.task,
        context: args.context,
        tasks: args.tasks,
        depth: depth + 1,
        callerAgent: callerAgentName
      });
      if (result.text.startsWith('错误:')) {
        return { ok: false, error: result.text };
      }
      return { ok: true, text: result.text };
    };
  }

  /** 执行单个 run(信号量包裹) */
  private async runOne(
    run: ChildRun,
    definition: import('./types').AgentDefinition,
    modelOverride?: string,
    depth = 0
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      if (run.status === 'stopped') return; // 排队期间被停止
      await this.executor.spawn({
        run,
        definition,
        modelOverride,
        spawnChild: this.makeSpawnChild(depth, definition.name),
        onFinish: () => {
          this.persistRun(run);
          this.emitUpdate();
        },
        onProgress: () => {
          this.throttledEmit();
        }
      });
    } finally {
      release();
    }
  }

  // ─── 控制(IPC) ───

  async stopRun(runId: string): Promise<boolean> {
    const run = this.getRun(runId);
    if (!run) return false;
    if (run.status === 'queued') {
      run.status = 'stopped';
      run.endedAt = Date.now();
      this.emitUpdate();
      return true;
    }
    if (run.status !== 'running') return false;
    run.status = 'stopped';
    run.endedAt = Date.now();
    await this.executor.stop(runId);
    this.emitUpdate();
    return true;
  }

  async steerRun(runId: string, text: string): Promise<boolean> {
    const run = this.getRun(runId);
    if (!run || run.status !== 'running') return false;
    return this.executor.steer(runId, text);
  }

  // ─── 快照与推送 ───

  private trackRuns(runs: ChildRun[]): void {
    this.runs.push(...runs);
    this.pruneRuns();
  }

  /** 保留最近 MAX_TRACKED_RUNS 条;被淘汰的记录同步删除其会话文件 */
  private pruneRuns(): void {
    if (this.runs.length <= MAX_TRACKED_RUNS) return;
    const dropped = this.runs.slice(0, this.runs.length - MAX_TRACKED_RUNS);
    this.runs = this.runs.slice(-MAX_TRACKED_RUNS);
    for (const run of dropped) deleteSubagentSessionFile(run.sessionFile);
  }

  /** 读取子 agent 会话文件里的完整对话(终态/重启后用);无文件返回 null */
  readSessionConversation(runId: string): SubagentConversation | null {
    const run = this.getRun(runId);
    return readSubagentConversation(run?.sessionFile);
  }

  getSnapshot(): SubagentSnapshot {
    const defs = this.ensureDefinitionsLoaded();
    return {
      runs: [...this.runs].reverse().map((r) => this.slimRun(r)),
      agents: defs.agents.map((a) => ({
        name: a.name,
        description: a.description,
        source: a.source,
        tools: a.tools
      }))
    };
  }

  /** IPC 传输瘦身:截断工具调用参数/结果与对话流文本,防止 read/bash 等大结果撑爆序列化 */
  private slimRun(run: ChildRun): ChildRun {
    const slimmed: ChildRun = { ...run };
    if (run.toolCalls) {
      slimmed.toolCalls = run.toolCalls.map((tc) => ({
        ...tc,
        args: slimValue(tc.args, 500),
        result: slimValue(tc.result, 2000)
      }));
    }
    if (run.transcript) {
      slimmed.transcript = run.transcript.map((item) => {
        if (item.kind === 'text' || item.kind === 'thinking') {
          return { ...item, text: slimText(item.text, MAX_SNAPSHOT_TEXT_CHARS) };
        }
        if (item.kind === 'stream') {
          return {
            ...item,
            text: slimText(item.text, MAX_SNAPSHOT_TEXT_CHARS),
            thinking: slimText(item.thinking, MAX_SNAPSHOT_TEXT_CHARS)
          };
        }
        return item;
      });
    }
    return slimmed;
  }

  private lastEmitMs = 0;
  private throttledEmit(): void {
    const now = Date.now();
    if (now - this.lastEmitMs < 250) return; // 进度推送节流 250ms
    this.lastEmitMs = now;
    this.emitUpdate();
  }

  emitUpdate(): void {
    try {
      this.host.sendSessionEvent('pi:subagentUpdate', this.getSnapshot());
    } catch {}
  }

  /** 会话切换:停止全部活跃 run(跨项目残留无意义),并从新会话恢复历史 run */
  onSessionSwitch(): void {
    this.stopping = false;
    for (const run of this.activeRuns) {
      void this.stopRun(run.id);
    }
    this.loadedForCwd = ''; // cwd 可能变化,重扫定义
    this.restoreFromSession();
    this.emitUpdate();
  }

  /** 从当前会话 entries 恢复历史 run 记录(切会话/重开应用后调面板不再为空) */
  restoreFromSession(): void {
    try {
      const sm = this.host.current()?.sessionManager;
      if (!sm) return;
      const entries = sm.getBranch?.() ?? sm.getEntries?.() ?? [];
      const restored = loadRunsFromEntries(entries);
      if (restored.length > 0) {
        // 恢复的终态 run 与内存现存 run 合并(同 id 以内存为准)
        const byId = new Map(restored.map((r) => [r.id, r]));
        for (const r of this.runs) byId.set(r.id, r);
        this.runs = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
        this.pruneRuns();
      }
    } catch {
      // 恢复失败不影响会话运行
    }
  }

  /** run 落到终态时持久化为 session custom entry(不参与 LLM 上下文) */
  private persistRun(run: ChildRun): void {
    if (!isTerminalRunStatus(run.status)) return;
    try {
      const sm = this.host.current()?.sessionManager;
      if (!sm || typeof sm.appendCustomEntry !== 'function') return;
      sm.appendCustomEntry(SUBAGENT_STATE_ENTRY_TYPE, { run: serializeChildRun(run) });
    } catch {
      // 持久化失败不影响运行结果回传
    }
  }

  /** 应用退出/项目切换清理 */
  async dispose(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.followUpSender = null;
    const stopping = this.activeRuns.map(async (run) => {
      run.status = 'stopped';
      run.endedAt = Date.now();
      await this.executor.stop(run.id);
    });
    await Promise.allSettled(stopping);
    await Promise.allSettled([...this.runPromises]);
    this.runs = [];
  }

  setMaxConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, Math.min(10, n));
    this.semaphore = new Semaphore(this.maxConcurrency);
  }
}

/** 快照中单条对话文本上限(超长截断,防 IPC 负载过大) */
const MAX_SNAPSHOT_TEXT_CHARS = 4000;

/** 序列化并截断任意值(IPC 传输瘦身用) */
function slimValue(v: unknown, maxChars: number): unknown {
  if (v == null) return v;
  try {
    const s = JSON.stringify(v);
    if (s.length <= maxChars) return v;
    // 返回截断后的字符串 + 标记
    return `${s.slice(0, maxChars)}…(已截断,原 ${s.length} 字符)`;
  } catch {
    return String(v).slice(0, maxChars);
  }
}

/** 截断纯文本(对话流条目专用;不走 JSON.stringify,避免多余引号) */
function slimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(已截断,原 ${text.length} 字符)`;
}
