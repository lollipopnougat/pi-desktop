/**
 * Subagent run 持久化(仿 goal/persistence.ts 模式)。
 *
 * 设计:
 * - 每次 run 状态落定时(终态),把「该 run 的记录」追加为一条 subagent-state
 *   custom entry(appendCustomEntry 不参与 LLM 上下文,只落会话分支)
 * - 增量追加而非全量快照:一次 batch 产生 N 条 entry,天然随分叉/导航裁剪
 * - 恢复:从 entries 收集全部 subagent-state,按 createdAt 排序重建 run 列表
 * - 序列化时剔除 toolCalls 流水(体积大,恢复场景只需要结果摘要)
 *
 * 与 goal 的差异:goal 只有一个活跃对象(全量覆盖),subagent 是 append-only
 * 事件流——用「增量 entry + 读时聚合」更贴合。
 */
import type { ChildRun, ChildToolCall } from './types';

export const SUBAGENT_STATE_ENTRY_TYPE = 'subagent-state';

/** 序列化到 session entry 的 run 结构(剔除 progress/toolCalls 等运行时字段) */
export interface SerializedChildRun {
  id: string;
  name: string;
  agent: string;
  task: string;
  status: ChildRun['status'];
  output?: string;
  outputData?: unknown;
  outputSource?: 'submit' | 'fallback';
  error?: string;
  async: boolean;
  depth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  usage?: ChildRun['usage'];
  /** 子 agent 会话文件路径(独立目录 subagent-sessions/;重启后回放对话用) */
  sessionFile?: string;
}

/** 序列化(剔除运行时临时字段) */
export function serializeChildRun(run: ChildRun): SerializedChildRun {
  const {
    id,
    name,
    agent,
    task,
    status,
    output,
    outputData,
    outputSource,
    error,
    async,
    depth,
    createdAt,
    startedAt,
    endedAt,
    usage,
    sessionFile
  } = run;
  const s: SerializedChildRun = { id, name, agent, task, status, async, depth, createdAt };
  if (output !== undefined) s.output = output;
  if (outputData !== undefined) s.outputData = outputData;
  if (outputSource !== undefined) s.outputSource = outputSource;
  if (error !== undefined) s.error = error;
  if (startedAt !== undefined) s.startedAt = startedAt;
  if (endedAt !== undefined) s.endedAt = endedAt;
  if (usage !== undefined) s.usage = usage;
  if (sessionFile !== undefined) s.sessionFile = sessionFile;
  return s;
}

/** 反序列化 + 规整(非法数据返回 null) */
export function deserializeChildRun(data: unknown): ChildRun | null {
  if (!data || typeof data !== 'object') return null;
  const r = data as Partial<SerializedChildRun>;
  if (
    typeof r.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.agent !== 'string' ||
    typeof r.task !== 'string' ||
    typeof r.status !== 'string' ||
    !['queued', 'running', 'complete', 'failed', 'stopped'].includes(r.status)
  ) {
    return null;
  }
  const run: ChildRun = {
    id: r.id,
    name: r.name,
    agent: r.agent,
    task: r.task,
    status: r.status as ChildRun['status'],
    async: r.async === true,
    depth: typeof r.depth === 'number' ? r.depth : 0,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    progress: { recentTools: [], turns: 0, tokens: 0, durationMs: 0 }
  };
  if (typeof r.output === 'string') run.output = r.output;
  if (r.outputData !== undefined) run.outputData = r.outputData;
  if (r.outputSource === 'submit' || r.outputSource === 'fallback') {
    run.outputSource = r.outputSource;
  }
  if (typeof r.error === 'string') run.error = r.error;
  if (typeof r.startedAt === 'number') run.startedAt = r.startedAt;
  if (typeof r.endedAt === 'number') run.endedAt = r.endedAt;
  if (typeof r.sessionFile === 'string') run.sessionFile = r.sessionFile;
  if (r.usage && typeof r.usage === 'object') {
    run.usage = {
      input: r.usage.input ?? 0,
      output: r.usage.output ?? 0,
      cacheRead: r.usage.cacheRead ?? 0,
      cacheWrite: r.usage.cacheWrite ?? 0
    };
  }
  return run;
}

/** 是否为终态(可持久化落盘) */
export function isTerminalRunStatus(s: ChildRun['status']): boolean {
  return s === 'complete' || s === 'failed' || s === 'stopped';
}

/**
 * 从 session entries 收集全部 subagent-state 记录,重建 run 列表。
 * 同 id 多条时取最后一条(状态演进);按 createdAt 升序返回。
 * 上限 50 条(与内存 trackRuns 一致),超出丢最旧。
 */
export function loadRunsFromEntries(entries: any[]): ChildRun[] {
  const byId = new Map<string, ChildRun>();
  for (const e of entries) {
    if (!e || e.type !== 'custom' || e.customType !== SUBAGENT_STATE_ENTRY_TYPE) continue;
    const data = e.data ?? e.content;
    const raw = (data as { run?: unknown } | undefined)?.run ?? data;
    const restored = deserializeChildRun(raw);
    if (restored) byId.set(restored.id, restored); // 后写覆盖同 id
  }
  const runs = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  return runs.length > 50 ? runs.slice(-50) : runs;
}
