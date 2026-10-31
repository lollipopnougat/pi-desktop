/**
 * MemoryController：主进程侧记忆系统控制器。
 *
 * 职责（对齐 GoalController 模式）：
 * - 持有配置（config.json）与管道运行状态（防重入）
 * - 提供提取/合并入口（memory-ipc 调用），用 PiBridge 的 modelRuntime 做 LLM 调用
 * - 维护注入快照（session_start 冻结，extension 读取）
 * - 把进度事件推到渲染进程（pi:memoryProgress）
 *
 * 不直接调 SDK 扩展 API（pi.on/registerTool），那些在 memoryExtensionFactory 里注册。
 */
import path from 'path';
import { randomUUID } from 'crypto';
import { projectIdentity } from './config';
import { listCandidates, historyForProject, legacyProjects } from './review';
import type { PiBridge } from '../pi-bridge';
import type { SessionHost } from '../session-slot';
import {
  readMemoryConfig,
  writeMemoryConfig,
  type MemoryConfig,
  type MemoryModelRef
} from './config';
import {
  readMemoryFile,
  memoryStats,
  searchMemory,
  type MemorySearchHit,
  memoryTopicIndex,
  stripMetadata
} from './store';
import { memoryIndexStats, searchIndexedMemories } from './search-index';
import { rebuildSessionIndex, sessionIndexStats, type SessionIndexStats } from './session-index';
import { redactSecrets } from './secrets';
import { rebuildMemoryIndex } from './search-index';
import {
  runExtraction,
  runConsolidation,
  readState,
  listExtractionFiles,
  listFailedSessions,
  pendingForProject,
  type ExtractionProgress,
  type ExtractionResult,
  type ConsolidationResult
} from './pipeline';
import {
  buildMemoryInjectionSections,
  renderMemoryInjection,
  type MemoryInjectionSection
} from './prompts';

/** 渲染进程展示的项目名：取 cwd basename（与 sessions 侧栏一致） */
export function projectNameFromCwd(cwd: string): string {
  const base = path.basename(path.resolve(cwd || '/'));
  return base || 'default';
}

/** getStatus 最多携带的失败会话条数（Panel 展示用；failedCount 为总数） */
const MAX_FAILED_SESSIONS = 20;

export interface MemorySnapshotInfo {
  enabled: boolean;
  injection: string;
}

/** UI 展示用：本会话实际注入的记忆分段明细 */
export interface MemoryInjectionInfo {
  /** 本会话是否有注入串（启用后即使画像为空也注入检索规则） */
  active: boolean;
  /** 快照冻结时间（ISO），null 表示尚未冻结 */
  frozenAt: string | null;
  /** 注入串总字符数 */
  totalChars: number;
  /** 其中固定头/尾标记（<memory-context> 说明与结束标记）的字符数 */
  markerChars: number;
  /** USER.md 是否被截断后才注入 */
  truncated: boolean;
  /** 分段明细（含未注入的分段，便于 UI 显示「空，未注入」） */
  sections: MemoryInjectionSection[];
}

export class MemoryController {
  private piBridge: PiBridge;
  /** 所服务的会话（Stage 0 = 焦点槽；多会话阶段按槽注入） */
  private host: SessionHost;
  /** 冻结快照：session_start 时生成，会话期间不变（保护 prompt cache） */
  private frozenInjection: string | null = null;
  /** 冻结快照的分段明细（与 frozenInjection 同源，供记忆面板展示） */
  private frozenSections: MemoryInjectionSection[] = [];
  /** 快照冻结时间（ISO） */
  private frozenAt: string | null = null;
  /** 管道运行中标志（防重入） */
  private extracting = false;
  private consolidating = false;
  /** 注入用冻结的项目名 */
  private frozenProjectName = '';
  private job: { id: string; projectId: string; abort: AbortController } | null = null;
  private running: Promise<unknown> | null = null;
  private disposed = false;

  getProject() {
    return projectIdentity(this.host.cwd());
  }
  getProjectId(): string {
    return this.getProject().id;
  }
  cancel(): void {
    this.job?.abort.abort(new Error('记忆任务已取消'));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.running?.catch(() => {});
    this.clearSnapshot();
  }

  constructor(piBridge: PiBridge, host: SessionHost) {
    this.piBridge = piBridge;
    this.host = host;
  }

  // ─── 配置 ───

  getConfig(): MemoryConfig {
    return readMemoryConfig();
  }

  setConfig(patch: Partial<MemoryConfig>): MemoryConfig {
    const next = writeMemoryConfig(patch);
    if (!next.enabled) {
      this.cancel();
      this.clearSnapshot();
    }
    return next;
  }

  isEnabled(): boolean {
    return readMemoryConfig().enabled;
  }

  getProjectName(): string {
    // 优先当前注入冻结的项目名（与会话一致），否则取当前 cwd
    return this.frozenProjectName || projectNameFromCwd(this.host.cwd());
  }

  // ─── 注入快照（extension 调用） ───

  /**
   * session_start 时冻结快照：读 USER.md + STANDING.md 生成注入串。
   * 会话期间即使文件被提取更新也不刷新（下个会话生效）——hermes 已验证的设计，
   * 避免每轮 systemPrompt 变化打掉 provider prefix cache。
   */
  freezeSnapshot(): void {
    this.frozenProjectName = projectNameFromCwd(this.host.cwd());
    this.frozenAt = new Date().toISOString();
    try {
      const config = readMemoryConfig();
      if (!config.enabled) {
        this.frozenInjection = null;
        this.frozenSections = [];
        return;
      }
      const profile = readMemoryFile('USER.md');
      const standing = readMemoryFile('STANDING.md');
      const truncatedProfile =
        config.userProfileCharLimit > 0 && profile.length > config.userProfileCharLimit;
      // 分段明细是注入串的唯一来源：先构造分段，再渲染（两者必定一致）
      const sections = buildMemoryInjectionSections({
        userProfile: boundedEntries(profile, config.userProfileCharLimit),
        standing: boundedEntries(standing, 4000),
        topicIndex: memoryTopicIndex(this.getProjectId()),
        projectName: this.frozenProjectName,
        truncatedProfile,
        originalProfileChars: profile.length
      });
      const injection = renderMemoryInjection(sections);
      // 检索规则与主题概览也属于同一冻结快照
      this.frozenSections = sections;
      this.frozenInjection = injection.length > 0 ? injection : null;
    } catch {
      // 记忆系统绝不拖垮主循环（oh-my-pi 黄金法则）
      this.frozenInjection = null;
      this.frozenSections = [];
    }
  }

  /** 会话关闭时清快照 */
  clearSnapshot(): void {
    this.frozenInjection = null;
    this.frozenSections = [];
    this.frozenAt = null;
  }

  /** before_agent_start 每轮取同一冻结串 */
  getInjection(): string | null {
    return this.frozenInjection;
  }

  /** 记忆面板展示用：本会话注入串的分段明细（与 getInjection 同源，非重算磁盘） */
  getInjectionInfo(): MemoryInjectionInfo {
    const markerChars = this.frozenSections
      .filter((s) => s.id === 'context-header' || s.id === 'context-footer')
      .reduce((sum, s) => sum + s.chars, 0);
    return {
      active: this.frozenInjection !== null,
      frozenAt: this.frozenAt,
      totalChars: this.frozenInjection?.length ?? 0,
      markerChars,
      truncated: this.frozenSections.some((s) => s.truncated === true),
      sections: this.frozenSections
    };
  }

  // ─── LLM 调用 ───

  /** 解析提取模型：config 指定 → 当前会话模型；都无则 null */
  resolveModel(): { provider: string; modelId: string; model: any } | null {
    const config = readMemoryConfig();
    try {
      const mr = this.piBridge.modelRuntime;
      if (!mr) return null;
      if (config.extractModel) {
        const m = mr.getModel(config.extractModel.provider, config.extractModel.modelId);
        if (m) return { ...config.extractModel, model: m };
        // 配置的模型失效则回退当前模型
      }
      const cur = this.host.current()?.model;
      if (cur) return { provider: cur.provider, modelId: cur.id, model: cur };
      const avail = mr.getAvailableSnapshot?.() ?? [];
      const first = avail[0];
      if (first) return { provider: first.provider, modelId: first.id, model: first };
      return null;
    } catch {
      return null;
    }
  }

  /** 构造 completeFn（注入 pipeline），失败时抛错 */
  makeCompleteFn(): (system: string, user: string, signal?: AbortSignal) => Promise<string> {
    const resolved = this.resolveModel();
    if (!resolved) {
      throw new Error('没有可用的模型（未配置 API key 或未选择模型）');
    }
    const mr = this.piBridge.modelRuntime!;
    return async (system, user, parentSignal) => {
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000);
      signal.throwIfAborted();
      const response = await withAbort(
        mr.completeSimple(
          resolved.model,
          {
            systemPrompt: system,
            messages: [
              {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: user }],
                timestamp: Date.now()
              } as any
            ]
          },
          { maxTokens: 8192, cacheRetention: 'none' as const, signal }
        ),
        signal
      );
      signal.throwIfAborted();
      if (['error', 'aborted', 'length'].includes((response as any)?.stopReason)) {
        throw new Error(`LLM 调用失败: ${(response as any)?.errorMessage || 'unknown'}`);
      }
      // 提取 assistant 文本
      const content = (response as any)?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text || '')
          .join('');
      }
      return '';
    };
  }

  // ─── 管道入口（memory-ipc 调用） ───

  /** 一个控制器同时只运行一个管道任务；项目切换/禁用/退出都取消。 */
  async triggerExtraction(): Promise<{ ok: boolean; result?: ExtractionResult; error?: string }> {
    if (this.job || this.disposed) return { ok: false, error: '记忆任务正在运行或窗口正在关闭' };
    if (!this.isEnabled()) return { ok: false, error: '记忆系统已禁用' };
    const project = this.getProject();
    const job = { id: randomUUID(), projectId: project.id, abort: new AbortController() };
    this.job = job;
    this.extracting = true;
    const task = (async () => {
      try {
        const result = await runExtraction(
          this.host.cwd(),
          project.name,
          this.makeCompleteFn(),
          (p) => this.emitProgress({ kind: 'extraction', ...p }),
          { signal: job.abort.signal }
        );
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error) };
      } finally {
        this.extracting = false;
        this.emitProgress({ kind: 'extraction', phase: 'done', total: 0, done: 0 });
        this.job = null;
      }
    })();
    this.running = task;
    return task;
  }

  async triggerConsolidation(): Promise<ConsolidationResult> {
    if (this.job || this.disposed)
      return { ok: false, merged: 0, error: '记忆任务正在运行或窗口正在关闭' };
    if (!this.isEnabled()) return { ok: false, merged: 0, error: '记忆系统已禁用' };
    const job = { id: randomUUID(), projectId: this.getProjectId(), abort: new AbortController() };
    this.job = job;
    this.consolidating = true;
    const task = (async () => {
      try {
        return await runConsolidation(job.projectId, this.makeCompleteFn(), {
          signal: job.abort.signal
        });
      } catch (error) {
        return {
          ok: false,
          merged: 0,
          error: String(error instanceof Error ? error.message : error)
        };
      } finally {
        this.consolidating = false;
        this.emitProgress({ kind: 'consolidation', phase: 'done', total: 0, done: 0 });
        this.job = null;
      }
    })();
    this.running = task;
    return task;
  }

  // ─── 自动沉淀（extension 的 turn_end / 纠错捕获 / 压缩前 flush 调用） ───

  /**
   * 后台沉淀：跑一次增量提取（会话水位线保证只处理有新内容的会话），
   * 待合并提取数达到阈值时再自动合并成候选。
   *
   * 三条约束：
   * 1. 已有任务在跑就直接跳过（不排队，避免每轮都堆一个任务）；
   * 2. 任何异常都吞掉——记忆绝不拖垮主循环；
   * 3. 产物只到候选（extractions → candidates），永不直接改记忆文件。
   */
  async autoSediment(reason: 'nudge' | 'correction' | 'compact'): Promise<void> {
    if (this.disposed) return;
    try {
      const config = readMemoryConfig();
      if (!config.enabled) return;
      if (reason === 'correction' ? !config.correctionDetect : !config.autoExtract) return;
      if (reason === 'compact' && !config.preCompactFlush) return;
      if (this.job || this.extracting) return;
      const result = await this.triggerExtraction();
      if (!result.ok) return;
      await this.autoConsolidate(config);
    } catch {
      /* 自动沉淀失败不影响对话 */
    }
  }

  private async autoConsolidate(config: MemoryConfig): Promise<void> {
    try {
      if (this.job || this.consolidating) return;
      const pending = pendingForProject(readState(), this.getProjectId()).length;
      if (pending < Math.max(1, config.consolidateThreshold)) return;
      await this.triggerConsolidation();
    } catch {
      /* 合并失败留到手工触发 */
    }
  }

  isBusy(): { extracting: boolean; consolidating: boolean } {
    return { extracting: this.extracting, consolidating: this.consolidating };
  }

  // ─── 状态查询（UI） ───

  getStatus() {
    const config = readMemoryConfig();
    const state = readState();
    const projectName = projectNameFromCwd(this.host.cwd());
    // 失败会话：水位线里带 error 的条目（再点提取会重试它们）
    const projectId = this.getProjectId();
    const failedSessions = listFailedSessions(state, projectId);
    return {
      enabled: config.enabled,
      extractModel: config.extractModel,
      consolidateThreshold: config.consolidateThreshold,
      files: memoryStats(projectId),
      pendingExtractions: pendingForProject(state, projectId).length,
      failedCount: failedSessions.length,
      failedSessions: failedSessions.slice(0, MAX_FAILED_SESSIONS),
      extractionFiles: listExtractionFiles(projectId).slice(-20),
      index: { ...memoryIndexStats(false), sessions: sessionIndexStats(false) },
      lastConsolidation: state.lastConsolidation ?? null,
      processedCount: Object.values(state.processed).filter((p) => p.projectId === projectId)
        .length,
      stats: state.stats ?? { extractions: 0, consolidations: 0 },
      busy: this.isBusy(),
      injected: this.frozenInjection !== null,
      injection: this.getInjectionInfo(),
      projectName,
      projectId,
      job: this.job ? { id: this.job.id, projectId: this.job.projectId } : null,
      candidates: listCandidates(projectId),
      history: historyForProject(projectId).map((tx) => ({
        id: tx.id,
        at: tx.at,
        reason: tx.reason,
        files: tx.changes.map((c) => c.file)
      })),
      legacyProjects: legacyProjects().map((p) => p.name),
      unassignedExtractions: state.pendingExtractions.filter(
        (id) => !state.extractions?.[id]?.projectId
      ).length
    };
  }

  /** 检索：索引可用时走 FTS5（BM25 + 使用度），否则回退子串检索 */
  search(query: string): MemorySearchHit[] {
    const projectId = this.getProjectId();
    return searchIndexedMemories(query, projectId) ?? searchMemory(query, projectId);
  }

  /**
   * 待审核候选数（记忆按钮角标用）。只读 candidates 目录，不碰索引/水位线，
   * 可以安全地被渲染进程随时调用。
   */
  getPendingReviewCount(): number {
    if (!this.isEnabled()) return 0;
    try {
      return listCandidates(this.getProjectId()).length;
    } catch {
      return 0;
    }
  }

  /** 记忆索引状态（面板展示；不触发增量同步，避免状态轮询产生 IO） */
  getIndexStats() {
    return { ...memoryIndexStats(false), sessions: sessionIndexStats(false) };
  }

  /** 全量重建两类索引（记忆 + 会话），返回重建后的状态 */
  rebuildIndexes() {
    const memory = rebuildMemoryIndex();
    const sessions: SessionIndexStats = rebuildSessionIndex();
    return { ...memory, sessions };
  }

  /** config.extractModel 设置（UI 选择器） */
  setExtractModel(ref: MemoryModelRef | null): void {
    writeMemoryConfig({ extractModel: ref });
  }

  // ─── 渲染进程推送 ───

  private emitProgress(payload: ExtractionProgress & { kind: string }): void {
    try {
      this.piBridge.win?.webContents.send('pi:memoryProgress', {
        ...payload,
        jobId: this.job?.id,
        projectId: this.job?.projectId
      });
    } catch {
      /* 窗口可能已关闭 */
    }
  }

  /** 会话切换钩子（pi-bridge 在 createRuntimeFor/syncSession 后调用） */
  onSessionSwitch() {
    if (this.job && this.job.projectId !== this.getProjectId()) this.cancel();
    this.freezeSnapshot();
  }
}

/** 按完整行取预算，不把条目/HTML 元数据切成半句。 */
function boundedEntries(text: string, budget: number): string {
  let result = '';
  for (const line of text.split('\n')) {
    const clean = redactSecrets(stripMetadata(line));
    if (result.length + clean.length + 1 > budget) continue;
    result += clean + '\n';
  }
  return result.trimEnd();
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('记忆任务已取消'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
