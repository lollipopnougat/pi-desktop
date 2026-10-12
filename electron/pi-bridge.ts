import { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type AgentSessionEvent,
  type SessionStartEvent,
  type SessionInfo
} from '@earendil-works/pi-coding-agent';
import { registerSessionIpc } from './ipc/session-ipc';
import { registerStatisticsIpc } from './ipc/statistics-ipc';
import { registerModelIpc } from './ipc/model-ipc';
import { registerClassifierIpc } from './ipc/classifier-ipc';
import { applyClassifierProviders } from './classifier/registry';
import { registerSkillIpc } from './ipc/skill-ipc';
import { registerMiscIpc } from './ipc/misc-ipc';
import { registerTerminalIpc, killAllTerminals } from './ipc/terminal-ipc';
import { registerMcpIpc } from './ipc/mcp-ipc';
import { registerGoalIpc } from './ipc/goal-ipc';
import { registerPlanIpc } from './ipc/plan-ipc';
import { registerSettingsIpc, readUiSettingsForMain } from './ipc/settings-ipc';
import { registerMemoryIpc } from './ipc/memory-ipc';
import { registerGitIpc } from './ipc/git-ipc';
import { registerGitAiIpc } from './ipc/git-ai-ipc';
import { registerPermissionIpc } from './ipc/permission-ipc';
import { registerSubagentIpc } from './ipc/subagent-ipc';
import { registerBackgroundTaskIpc } from './ipc/background-task-ipc';
import { registerHookIpc } from './ipc/hook-ipc';
import { registerBrowserIpc } from './ipc/browser-ipc';
import { registerLogsIpc } from './ipc/logs-ipc';
import { logAgentEvent } from './logs/agent-events';
import { logAppEvent } from './logs/channel-logs';
import { normalizeLogConfig, setLogConfig } from './logs/logger';
import {
  updatePlanTool,
  askTool,
  setAskNotifier,
  resolveAsk,
  resolveAllAsks,
  pendingAskQuestions,
  hasPendingAsk,
  type AskQuestion
} from './tools';
import type { PermissionRequest } from './permission/controller';
import type { PendingInteractions } from './ipc/types';
import {
  readImgTool,
  setReadImgModelConfig,
  getReadImgModelConfig,
  setModelRuntimeAccessor,
  type ReadImgModelConfig
} from './tools';
import { mcpManager } from './mcp/manager';
import { mcpProxyTool } from './mcp/proxy-tool';
import { GoalController } from './goal/controller';
import { goalExtensionFactory } from './goal/extension';
import { PlanController } from './plan/controller';
import { planExtensionFactory } from './plan/extension';
import { MemoryController } from './memory/controller';
import { memoryExtensionFactory } from './memory/extension';
import { PermissionController } from './permission/controller';
import { DEFAULT_PERMISSION_POLICY } from './permission/policy';
import { SubagentController } from './subagents/controller';
import { subagentExtensionFactory } from './subagents/extension';
import { BackgroundTaskController } from './background-tasks/controller';
import { backgroundTaskExtensionFactory } from './background-tasks/extension';
import { hookExtensionFactory } from './hooks/extension';
import { gitAiExtensionFactory } from './git-ai/extension';
import { app } from 'electron';
import { getAgentDir, getSessionDir } from './provider-config';
import { BrowserController } from './browser/controller';
import {
  SessionSlot,
  type SessionHost,
  type SessionSlotSnapshot,
  type SessionSlotsPayload
} from './session-slot';
import { disposeRuntime } from './runtime-lifecycle';
import type { SessionIdentity } from '../src/types/session';
import { t } from '../src/i18n/zh';

// pi-desktop 独立配置目录 ~/.pi-desktop（不再与 pi CLI 共享 ~/.pi/agent）
// 所有 SDK 路径（models/auth/sessions/skills/settings 等）显式指向该目录。
const AGENT_DIR = getAgentDir();

/**
 * 内置技能目录：随安装包发布的只读技能（如 skill-creator）。
 * - 打包后：electron-builder extraResources 把 resources/skills 拷到 process.resourcesPath/skills
 * - 开发模式：使用项目源码目录 resources/skills
 * 通过 SDK 的 additionalSkillPaths 注入，不落入用户可写的 ~/.pi-desktop/skills，
 *   因此设置页的删除/写入操作对内置技能无效（前端据此隐藏删除按钮）。
 */
function getBuiltinSkillsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.resolve(__dirname, '..', 'resources', 'skills');
}

/**
 * 内置说明文档目录：随安装包发布的「pi-desktop 向模型说明」文档。
 * - 打包后：electron-builder extraResources 把 resources/docs 拷到 process.resourcesPath/docs
 * - 开发模式：使用项目源码目录 resources/docs
 * 其中 pi-desktop-system-prompt.md 注入系统提示词，pi-desktop.md 是完整说明（模型按需 read）。
 */
function getBuiltinDocsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'docs')
    : path.resolve(__dirname, '..', 'resources', 'docs');
}

/**
 * 系统提示词追加段：告诉模型它跑在 pi-desktop（GUI 宿主）里、有哪些 GUI 专有工具与约定。
 * 读不到资源文件时返回 null（静默跳过注入，不影响主流程）。
 */
function getDesktopPromptAddendum(): string | null {
  try {
    const docsDir = getBuiltinDocsDir();
    const promptFile = path.join(docsDir, 'pi-desktop-system-prompt.md');
    if (!fs.existsSync(promptFile)) return null;
    const body = fs.readFileSync(promptFile, 'utf8').trim();
    const guideFile = path.join(docsDir, 'pi-desktop.md');
    const guideLine = fs.existsSync(guideFile)
      ? `\n\n完整说明（架构、GUI 工具面、权限、路径约定）：${guideFile}`
      : '';
    return body + guideLine;
  } catch {
    return null;
  }
}

/**
 * 槽控制器替换工厂：测试/宿主注入替身用（正常路径全部走默认构造）。
 * 每个槽创建自己的控制器实例，所以后台会话的 goal/plan/memory/subagent 状态
 * 只落在自己槽上，不会写进前台会话。
 */
export interface SlotControllerFactories {
  goal?: (host: SessionHost) => GoalController;
  plan?: (host: SessionHost) => PlanController;
  memory?: (host: SessionHost) => MemoryController;
  subagent?: (host: SessionHost) => SubagentController;
  permission?: (piBridge: PiBridge) => PermissionController;
}

/**
 * 会话槽生命周期日志：排查「后台会话为什么停了 / 槽为什么被释放」时用。
 * 只记决策点（焦点切换、槽释放、中止、MCP 重指），不记高频事件。
 * 走 app 日志通道的 `slots` phase（默认关闭：需在设置页开启日志 + app 通道 + debug 级），
 * 所以默认零开销、零控制台噪声。
 */
function logSlots(message: string, detail?: unknown): void {
  logAppEvent({ phase: 'slots', message, detail }, 'debug');
}

export class PiBridge {
  win: BrowserWindow | null = null;
  modelRuntime: ModelRuntime | null = null;
  agentDir: string = AGENT_DIR;
  /** 内置只读技能目录（随安装包发布），供 SkillContext 使用 */
  get builtinSkillsDir(): string {
    return getBuiltinSkillsDir();
  }
  /**
   * 会话槽集合（槽键 → 槽）：进程内可以同时活着多个会话。
   * - 焦点槽 = focusedKey 指向的那个：只有它的事件推给渲染进程，只有它被「无会话参数」的
   *   入口（转发访问器 / getState / getMessages / 焦点态控制器）读取。
   * - 非焦点槽（后台会话）保留 runtime 与订阅，那一轮继续跑完；切焦点不中止、不销毁，
   *   切回来直接复用（不重建 runtime、不重载服务）。
   * 跨项目也保留在后台：MCP 只有一份客户端集合（currentCwd），切焦点时把它重指到焦点项目 ——
   * 取舍是后台会话若在别的项目里调用 MCP 工具会失败（mcpProjectCwd，见 syncSession）。
   */
  private readonly slots = new Map<string, SessionSlot>();
  /** 焦点槽键；空串 = 还没有任何槽（首次 init 前） */
  private focusedKey = '';
  /** 槽的 LRU（最近聚焦在前）：超上限时从尾部释放空闲槽 */
  private readonly slotOrder: string[] = [];
  /** 进程内同时保留的槽上限（含焦点槽）：超出的空闲槽按 LRU 释放 */
  static readonly MAX_SLOTS = 4;
  private slotSeq = 0;
  /** MCP 客户端当前指向的项目目录（mcpManager 只有一份 currentCwd；焦点项目变化时重指） */
  private mcpProjectCwd = '';
  /** 会话级操作的全局串行锁（跨槽）：切焦点/新建/fork/替换都不交错 */
  private opTail: Promise<unknown> = Promise.resolve();
  /** 审批请求 id → 所属槽：渲染端回传决策时只有 id，据此回到正确的控制器（后台槽审批） */
  private readonly permissionRequestSlots = new Map<string, SessionSlot>();
  /**
   * 焦点槽控制器的镜像（**不是**进程级单例）：focusSlot 时指向该槽的实例，
   * 供 `piBridge.goalController` 这类无会话参数的旧取用点继续工作。
   * 多会话语义下新代码应从槽上取（`SessionSlot.goalController`，1-C 起按会话解析）。
   */
  goalController: GoalController | null = null;
  planController: PlanController | null = null;
  memoryController: MemoryController | null = null;
  subagentController: SubagentController | null = null;
  backgroundTaskController!: BackgroundTaskController;
  permissionController!: PermissionController;
  browserController!: BrowserController;

  constructor(private readonly controllerFactories: SlotControllerFactories = {}) {}

  /**
   * 给槽创建它自己的控制器（幂等）。控制器经 sessionHost(槽键) 访问「自己的」会话；
   * 扩展工厂在 createRuntimeFor 里捕获这些实例，因此后台槽的推进不会落到前台会话上。
   */
  private createSlotControllers(slot: SessionSlot): void {
    if (slot.controllersReady) return;
    const host = this.sessionHost(slot.key);
    slot.goalController = this.controllerFactories.goal?.(host) ?? new GoalController(this, host);
    slot.planController = this.controllerFactories.plan?.(host) ?? new PlanController(this, host);
    slot.memoryController =
      this.controllerFactories.memory?.(host) ?? new MemoryController(this, host);
    slot.subagentController =
      this.controllerFactories.subagent?.(host) ?? new SubagentController(this, host);
    slot.permissionController =
      this.controllerFactories.permission?.(this) ?? new PermissionController(this, host);
    // 权限策略是全局设置，但控制器按槽建：新建槽时把权威副本套上去
    slot.permissionController?.restorePolicy?.(this.permissionDefaults.policy);
    slot.permissionController?.restoreAutoSafeConfig?.(this.permissionDefaults.autoSafe);
    slot.permissionController?.restoreClassifierConfig?.(this.permissionDefaults.classifier);
    slot.controllersReady = true;
    if (this.focusedKey === slot.key) this.mirrorSlotControllers(slot);
  }

  /** 焦点槽的控制器镜像到 PiBridge 字段：旧取用点（含 IPC 无会话参数入口）无需改动 */
  private mirrorSlotControllers(slot: SessionSlot): void {
    this.goalController = slot.goalController;
    this.planController = slot.planController;
    this.memoryController = slot.memoryController;
    this.subagentController = slot.subagentController;
    if (slot.permissionController) this.permissionController = slot.permissionController;
  }
  private slotsEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  /**
   * 权限策略/自动白名单/决策模型配置（ui-config.json 的权威副本）：
   * 每个槽的权限控制器创建时套用（权限控制器随槽创建，不再是进程级单例）。
   */
  private permissionDefaults: {
    policy: unknown;
    autoSafe?: unknown;
    classifier?: unknown;
  } = { policy: DEFAULT_PERMISSION_POLICY };
  /** IPC handler 只注册一次，避免重开窗口时 'second handler' 报错 */
  private handlersRegistered = false;
  /** runtime 是否已初始化（首次启动），重开窗口时复用 */
  private runtimeReady = false;
  private disposePromise: Promise<void> | null = null;

  /** 同时在跑的会话上限（用户拍板：3 个，超出的回合排队） */
  static readonly MAX_RUNNING_SESSIONS = 3;

  /**
   * 生成「会话访问面」（goal/plan/subagent 控制器与执行器用）：Stage 0 指向焦点槽。
   * 多会话阶段按会话键生成，控制器实例随槽创建，不再共享进程级单例。
   */
  sessionHost(key?: string | null): SessionHost {
    const slot = this.sessionFor(key);
    return {
      current: () => slot.session,
      cwd: () => slot.cwd,
      sendSessionEvent: (channel, payload) => this.sendSessionEventFor(slot, channel, payload),
      setPlanMode: (enabled) => this.setPlanModeFor(slot, enabled)
    };
  }

  /** 焦点槽（可能还没有）：转发访问器用这个，避免「没有会话」时抛错 */
  private get focus(): SessionSlot | null {
    return this.slots.get(this.focusedKey) ?? null;
  }

  /** 焦点槽，必须存在（与原 getSession 的语义一致） */
  private focusedSlot(): SessionSlot {
    const slot = this.focus;
    if (!slot) throw new Error('Session not initialized');
    return slot;
  }

  /** 所有槽的渲染进程投影（侧栏徽标/后台会话清单；焦点槽也包含在内） */
  slotSnapshots(): SessionSlotSnapshot[] {
    return [...this.slots.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((slot) => {
        const sessionId = slot.session?.sessionId;
        return slot.snapshot(
          this.isSlotBusy(slot),
          sessionId && hasPendingAsk(sessionId) ? 1 : 0
        );
      });
  }

  /** 立即推送槽状态（渲染端据此画徽标：在跑/未读/等审批） */
  emitSessionSlots(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send('pi:sessionSlots', this.sessionSlots());
    } catch {
      // 窗口正在销毁
    }
  }

  /**
   * 用户发起一个回合（并发闸门在这里）：
   * 目标会话已经在跑 → 直接交给 SDK（进它自己的队列，不占新额度）；
   * 否则要有一个空闲额度，超出「同时最多 3 个会话在跑」时在槽上排队，等 agent_end 放行。
   */
  async submitPrompt(
    text: string,
    options: any,
    key?: string | null
  ): Promise<{ queued: boolean }> {
    const slot = this.sessionFor(key);
    if (this.canStartTurn(slot)) {
      await slot.requireSession().prompt(text, options);
      return { queued: false };
    }
    slot.pendingPrompts.push({ text, options });
    this.scheduleSessionSlotsEmit();
    return { queued: true };
  }

  /** 目标槽是否还有额度开新一轮：已在跑的直接放行（不占新额度） */
  private canStartTurn(slot: SessionSlot): boolean {
    if (this.isSlotBusy(slot)) return true;
    let busy = 0;
    for (const candidate of this.slots.values()) {
      if (this.isSlotBusy(candidate)) busy++;
    }
    return busy < PiBridge.MAX_RUNNING_SESSIONS;
  }

  /** 有额度腾出来时放行排队中的回合（一轮只放行一个：放行后该槽立刻进入在跑状态） */
  private drainPendingPrompts(): void {
    if (!this.slots.size) return;
    let released = false;
    for (const slot of this.slots.values()) {
      if (!slot.pendingPrompts.length) continue;
      if (!this.canStartTurn(slot)) continue;
      const next = slot.pendingPrompts.shift()!;
      try {
        void Promise.resolve(slot.requireSession().prompt(next.text, next.options)).catch(() => {
          // 失败会在会话事件流里体现（UI 由事件同步，这里不再额外上报）
        });
      } catch {
        // 会话已失效等同步异常：丢掉这一条，避免卡住后面的排队回合
      }
      released = true;
      break;
    }
    if (released) this.scheduleSessionSlotsEmit();
  }

  /** 槽状态快照 + 焦点键（渲染端订阅/主动拉取同一份结构） */
  sessionSlots(): SessionSlotsPayload {
    return { focusedKey: this.focusedKey, slots: this.slotSnapshots() };
  }

  /** 节流推送槽状态：事件高频时合并成 ~120ms 一次（槽状态是标量，不需要实时） */
  scheduleSessionSlotsEmit(): void {
    if (this.slotsEmitTimer) return;
    this.slotsEmitTimer = setTimeout(() => {
      this.slotsEmitTimer = null;
      this.emitSessionSlots();
    }, 120);
  }

  /** 按会话键中止一个槽的在途回合（侧栏「停止」按钮用；不传=焦点槽） */
  async abortSlot(key?: string | null): Promise<void> {
    const slot = this.sessionFor(key);
    logSlots(`用户停止槽 ${slot.key}`, { sessionId: slot.session?.sessionId ?? null });
    // 停止 = 连排队中的回合一起取消（否则用户点「停止」后它还会自动发出去）
    slot.pendingPrompts.length = 0;
    try {
      await slot.session?.abort();
    } catch {
      // 中止失败不改状态：UI 会在下一次槽状态推送里看到真实状态
    }
    this.drainPendingPrompts();
    this.scheduleSessionSlotsEmit();
  }

  /** 焦点槽（没有就建一个）：首次创建 runtime / 宿主手工装配等场景用 */
  private ensureFocusedSlot(): SessionSlot {
    const existing = this.focus;
    if (existing) return existing;
    const slot = this.createSlot();
    this.focusSlot(slot);
    return slot;
  }

  /** 新建（尚未初始化 runtime 的）槽并登记 LRU；只有焦点槽的事件会推给渲染进程 */
  private createSlot(): SessionSlot {
    const key = `slot-${++this.slotSeq}`;
    const slot = new SessionSlot(key, (event, identity) => {
      if (this.focusedKey !== key) return;
      this.sendAgentEvent(event, identity);
    });
    this.slots.set(key, slot);
    this.slotOrder.unshift(key);
    this.scheduleSessionSlotsEmit();
    return slot;
  }

  /** 焦点切到指定槽：不碰 runtime（后台那一轮继续跑） */
  private focusSlot(slot: SessionSlot): void {
    const previousFocusKey = this.focusedKey;
    this.focusedKey = slot.key;
    if (previousFocusKey !== slot.key) {
      logSlots(`焦点 ${previousFocusKey || '(无)'} → ${slot.key}`, {
        sessionId: slot.session?.sessionId ?? null,
        cwd: slot.cwd
      });
    }
    // 切过来就算看过了
    slot.unread = false;
    // 焦点态取用点（IPC / 转发访问器）永远看焦点槽的控制器
    this.mirrorSlotControllers(slot);
    const index = this.slotOrder.indexOf(slot.key);
    if (index < 0) this.slotOrder.unshift(slot.key);
    else if (index > 0) {
      this.slotOrder.splice(index, 1);
      this.slotOrder.unshift(slot.key);
    }
    this.scheduleSessionSlotsEmit();
  }

  /** 按会话文件查找已打开的槽（同一文件绝不能有两个槽：两个 SessionManager 会互相覆盖） */
  private findSlotBySessionFile(sessionFile: string): SessionSlot | undefined {
    const target = path.resolve(sessionFile);
    for (const slot of this.slots.values()) {
      const file = slot.session?.sessionFile;
      if (file && path.resolve(file) === target) return slot;
    }
    return undefined;
  }

  /** 按会话 id 找槽（新建会话还没落盘时渲染端只能给 id） */
  private findSlotBySessionId(sessionId: string): SessionSlot | undefined {
    if (!sessionId) return undefined;
    for (const slot of this.slots.values()) {
      if (slot.session?.sessionId === sessionId) return slot;
    }
    return undefined;
  }

  /** 按会话文件路径或会话 id 查找已在槽里的会话；找不到返回 null（不抛错） */
  findSessionSlot(sessionFileOrId: string): SessionSlot | null {
    if (!sessionFileOrId) return null;
    return (
      this.findSlotBySessionFile(sessionFileOrId) ?? this.findSlotBySessionId(sessionFileOrId) ?? null
    );
  }

  /**
   * 删除会话文件后的槽收尾：把还持有该会话的槽放掉。
   *
   * 只处理非焦点、非运行中的槽：
   * - `'focused'`：要删的是当前激活会话 → 调用方拒绝删除；
   * - `'busy'`：后台槽还在跑 → 拒绝删除（文件删了也会被后续写入重建）；
   * - `'released'`：空闲后台槽已释放（连同内存副本），列表里不会再冒出来；
   * - `'none'`：没有槽持有它（普通磁盘会话）。
   */
  async dropSessionSlot(
    sessionFileOrId: string
  ): Promise<'focused' | 'busy' | 'released' | 'none'> {
    const slot = this.findSessionSlot(sessionFileOrId);
    if (!slot) return 'none';
    if (slot.key === this.focusedKey) return 'focused';
    if (this.isSlotBusy(slot)) return 'busy';
    await this.releaseSlot(slot, '会话被删除');
    return 'released';
  }

  /** 槽是否正忙（在途回合或排队消息）：忙槽不释放 */
  private isSlotBusy(slot: SessionSlot): boolean {
    const session = slot.session;
    if (!session) return false;
    try {
      if (session.isStreaming === true) return true;
      return session.agent?.hasQueuedMessages?.() === true;
    } catch {
      // 状态读不到时保守当作忙，避免误杀在途回合
      return true;
    }
  }

  /** 槽数超上限时释放最久未聚焦的空闲槽 */
  private async enforceSlotLimit(): Promise<void> {
    for (const key of [...this.slotOrder].reverse()) {
      if (this.slots.size <= PiBridge.MAX_SLOTS) return;
      if (key === this.focusedKey) continue;
      const slot = this.slots.get(key);
      if (!slot || this.isSlotBusy(slot)) continue;
      await this.releaseSlot(slot, 'LRU 槽上限');
    }
  }

  /** 释放一个空闲槽：移出集合 + 销毁 runtime + 销毁它的控制器（焦点槽不能这样释放） */
  private async releaseSlot(slot: SessionSlot, reason = 'unknown'): Promise<void> {
    if (slot.key === this.focusedKey) return;
    logSlots(`释放槽 ${slot.key}（${reason}）`, {
      sessionId: slot.session?.sessionId ?? null,
      cwd: slot.cwd
    });
    this.slots.delete(slot.key);
    const index = this.slotOrder.indexOf(slot.key);
    if (index >= 0) this.slotOrder.splice(index, 1);
    await this.releaseSlotRuntime(slot);
    await this.disposeSlotControllers(slot);
    this.scheduleSessionSlotsEmit();
  }

  /** 销毁槽级控制器：memory 的 disposed 是终态，只能在槽真正释放时调（幂等） */
  private async disposeSlotControllers(slot: SessionSlot): Promise<void> {
    if (slot.controllersDisposed) return;
    slot.controllersDisposed = true;
    try {
      await slot.memoryController?.dispose();
    } catch (error) {
      console.error('Memory cleanup failed:', error);
    }
  }

  /**
   * 会话槽解析：不传键取焦点槽；也可直接传 sessionId（renderer 只知 sessionId 的场合）。
   * 未知键直接抛错（不静默回退到别的会话——那正是多会话里最难查的串会话 bug）。
   */
  sessionFor(key?: string | null): SessionSlot {
    if (key === undefined || key === null || key === '') return this.focusedSlot();
    const byKey = this.slots.get(key);
    if (byKey) return byKey;
    for (const slot of this.slots.values()) {
      if (slot.session?.sessionId === key) return slot;
    }
    throw new Error(`UNKNOWN_SESSION: ${key}`);
  }

  // ---- 焦点槽的转发访问器（只代表「当前焦点会话」；无槽时给空值，不抛错）----
  get runtime(): any {
    return this.focus?.runtime ?? null;
  }
  get session(): any {
    return this.focus?.session ?? null;
  }
  get cwd(): string {
    return this.focus?.cwd ?? '';
  }
  get sessionAccess(): SessionSlot['access'] {
    return this.focusedSlot().access;
  }

  getSessionIdentity(): SessionIdentity {
    return this.sessionFor().identity();
  }

  /** 焦点槽的会话级推送（带该槽身份） */
  sendSessionEvent(channel: string, payload: unknown): boolean {
    return this.sendSessionEventFor(this.sessionFor(), channel, payload);
  }

  /** 会话级推送带该槽身份；切换中的过渡状态由完成后的快照重建。 */
  private sendSessionEventFor(
    slot: SessionSlot,
    channel: string,
    payload: unknown
  ): boolean {
    if (
      !slot.session ||
      slot.access.changing ||
      !this.win ||
      this.win.isDestroyed() ||
      this.win.webContents.isDestroyed()
    )
      return false;
    this.win.webContents.send(channel, payload, slot.identity());
    // 审批请求按 id 记住所属槽：渲染端回传决策时只有 id，需要据此回到正确的控制器
    if (channel === 'pi:permissionRequest') {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id) this.permissionRequestSlots.set(id, slot);
    }
    // 需要用户注意的交互事件（审批/提问/计划/目标）：刷新槽状态，让侧栏徽标跟上
    if (channel === 'pi:permissionRequest' || channel === 'pi:askUser') {
      if (this.focusedKey !== slot.key) slot.unread = true;
      this.scheduleSessionSlotsEmit();
    }
    return true;
  }

  /**
   * 渲染进程回传审批决策：按 id 找回所属槽——后台会话的审批不能被焦点槽的控制器结算
   * （那会拒绝/放行错工具，并且真正的请求永远挂在那里）。找不到映射时退回焦点槽兜底。
   */
  resolvePermissionRequest(id: string, decision: unknown): boolean {
    const slot = this.permissionRequestSlots.get(id);
    this.permissionRequestSlots.delete(id);
    if (slot) return slot.permissionController?.resolvePermission(id, decision) ?? false;
    return this.permissionController?.resolvePermission(id, decision) ?? false;
  }

  /**
   * ask 工具的提问按会话路由：用 sessionKey 显式解析所属槽，事件带该槽身份推送
   * （渲染端只展示焦点会话的提问；后台会话的提问在切回去时由 rebind 重推）。
   * init / rebind 各调一次（等价闭包，幂等），保证窗口重建与测试路径下都已装好。
   */
  pendingInteractions(): PendingInteractions {
    const slot = this.focus;
    const sessionId = slot?.session?.sessionId ?? '';
    const questions: AskQuestion[] | null = sessionId ? pendingAskQuestions(sessionId) : null;
    const permission: PermissionRequest | null =
      slot?.permissionController?.firstPendingRequest?.() ?? null;
    return {
      ask: questions ? { sessionId, questions } : null,
      permission
    };
  }

  private bindAskNotifier(): void {
    setAskNotifier((sessionKey, questions) => {
      let slot: SessionSlot | null = null;
      try {
        slot = this.sessionFor(sessionKey);
      } catch {
        slot = null;
      }
      if (!slot || !this.sendSessionEventFor(slot, 'pi:askUser', questions)) {
        resolveAsk(sessionKey, null);
      }
    });
  }

  /** 单条会话级 agent 事件推送（不含合帧，供内部使用） */
  private sendAgentEvent(event: any, identity: SessionIdentity): void {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send('pi:event', { ...event, ...identity });
  }

  /** 会话级操作的全局串行锁：一次失败不能阻断后续操作。 */
  private enqueueOp<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.opTail.then(operation);
    this.opTail = result.catch(() => {});
    return result;
  }

  /**
   * 会话**替换**操作（fork/navigate/导出临时切换/换项目）：串行执行，并中止焦点槽的当前轮。
   * 与 runFocusOperation 的区别：这里会打断焦点会话正在跑的那一轮（它要被替换掉）。
   */
  runSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposePromise) return Promise.reject(new Error('Application is closing'));
    return this.enqueueOp(() => {
      const slot = this.focusedSlot();
      return slot.access.run(async () => {
        if (this.disposePromise) throw new Error('Application is closing');
        const previousCwd = slot.cwd;
        const previousManager = slot.session?.sessionManager;
        slot.permissionController?.clearPending();
        if (slot.session?.sessionId) resolveAsk(slot.session.sessionId, null);
        slot.planController?.cancelPending({
          approved: false,
          feedback: t.sessionSwitchCancelled
        });
        logSlots(`中止焦点槽 ${slot.key}（runSessionOperation）`, {
          sessionId: slot.session?.sessionId ?? null
        });
        try {
          await Promise.allSettled([slot.subagentController?.dispose(), slot.session?.abort()]);
          return await operation();
        } catch (error) {
          // SDK 在创建新会话前已销毁旧 session。创建失败时用旧 manager 恢复会话，
          // 不把 disposed session 暴露给后续 IPC，也不让切换队列永久失效。
          if (!slot.session) {
            slot.runtime = null;
            try {
              await this.createRuntimeFor(previousCwd, previousManager, slot);
            } catch (recoveryError) {
              console.error('Failed to recover session:', recoveryError);
            }
          }
          throw error;
        } finally {
          if (slot.runtime && slot.session) await this.syncSession(slot);
        }
      });
    });
  }

  /**
   * 切焦点/新建会话：**不中止任何槽**——后台会话的那一轮继续跑完（「会话后台运行」的核心），
   * 只是不再推给渲染进程；切回来复用同一个 runtime。只与其它会话操作互斥。
   */
  runFocusOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposePromise) return Promise.reject(new Error('Application is closing'));
    return this.enqueueOp(operation);
  }

  async init(win: BrowserWindow, cwd: string) {
    this.win = win;
    if (!this.browserController) this.browserController = new BrowserController();
    this.browserController.attachWindow(win);
    // runtime 已就绪时（macOS 关窗后重开）：保留原项目 cwd，不要用 home 覆盖——
    // runtime/session 仍在原项目的会话上，覆盖会导致 getState/getCwd/git 探测全部失真
    if (!this.runtimeReady) {
      // 首个会话槽：之后所有会话访问都经 sessionFor 解析（见 slots 字段注释）。
      // 必须在控制器创建（sessionHost）之前——host 解析的就是焦点槽。
      const firstSlot = this.createSlot();
      this.focusSlot(firstSlot);
      firstSlot.cwd = cwd;
    }

    fs.mkdirSync(path.join(AGENT_DIR, 'sessions'), { recursive: true });

    // 首次启动才创建 ModelRuntime / runtime；macOS 关窗后重开时复用已有实例
    if (!this.runtimeReady) {
      // 显式指定 auth/models 路径，确保配置落在 ~/.pi-desktop（models-store.json 跟随 modelsPath 所在目录）
      this.modelRuntime = await ModelRuntime.create({
        authPath: path.join(AGENT_DIR, 'auth.json'),
        modelsPath: path.join(AGENT_DIR, 'models.json')
      });

      // 自定义决策模型（~/.pi-desktop/classifiers.json）注册进 runtime。
      // 必须在 ModelRuntime.create 之后：registerProvider 是 runtime 实例方法。
      // SDK 的 models.json schema 不支持 classifier（无 type 字段/无 classifiers），
      // 所以决策模型走独立配置文件 + 直接调用公开的 ModelRuntime.registerProvider。
      try {
        const classifierResult = applyClassifierProviders(this.modelRuntime);
        if (classifierResult.applied.length > 0) {
          console.log('[pi-bridge] 已注册决策模型 provider:', classifierResult.applied.join(', '));
        }
        for (const err of classifierResult.errors) {
          console.warn(`[pi-bridge] 决策模型 provider 「${err.key}」注册失败: ${err.message}`);
        }
      } catch (err) {
        console.warn('[pi-bridge] 决策模型 provider 注册异常:', err);
      }

      // 会话级控制器（goal/plan/memory/subagent/permission）随会话槽创建，
      // 见 createSlotControllers；后台任务控制器是进程级的（任务不随会话销毁）。
      if (!this.backgroundTaskController) {
        this.backgroundTaskController = new BackgroundTaskController(this);
        await this.backgroundTaskController.initialize();
      }

      // 权限策略从 ui-config.json 恢复（主进程侧权威副本，渲染进程 store 另行恢复）
      try {
        const ui = readUiSettingsForMain();
        // 权限控制器按槽创建，所以这里先存副本，建槽时逐个套用（见 createSlotControllers）
        this.permissionDefaults = {
          policy: ui.permissionPolicy ?? DEFAULT_PERMISSION_POLICY,
          autoSafe: ui.permissionAutoSafeConfig,
          // classifier-auto 决策模型配置（providerId/modelId/超时/置信度阈值）
          classifier: ui.permissionClassifierConfig
        };
        // read_img 图片识别模型配置恢复
        setReadImgModelConfig(this.normalizeReadImgConfig(ui.readImgModel));
        // 日志配置（总开关 / 等级 / 各功能开关 / 保留天数），必须在任何 logEvent 之前生效
        setLogConfig(normalizeLogConfig(ui.logConfig));
        await this.browserController.setEnabled(ui.browserEnabled === true);
        await this.browserController.setDevtoolsEnabled(ui.browserDevtoolsEnabled === true);
      } catch {}

      // read_img 工具的 modelRuntime 访问器（懒取，避免初始化顺序问题）
      setModelRuntimeAccessor(() => this.modelRuntime);

      // 启动记录：日志开关已就绪（上面 setLogConfig 之后），版本/路径写一行方便对齐时间线
      logAppEvent({
        phase: 'start',
        version: app.getVersion(),
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        node: process.versions.node ?? null,
        platform: `${process.platform} ${process.arch}`,
        packaged: app.isPackaged,
        pid: process.pid,
        cwd,
        agentDir: AGENT_DIR
      });

      this.bindAskNotifier();
      await this.createRuntimeFor(cwd);
      this.runtimeReady = true;
    } else {
      // runtime 已存在，只需把新窗口绑定回去并重订阅事件
      this.rebind();
      // 窗口重开时重置 MCP cwd 为当前 cwd（home），避免残留上一个项目的 currentCwd
      mcpManager.setCwd(this.cwd);
      this.mcpProjectCwd = this.cwd;
    }
  }

  /** 重开窗口时仅解绑窗口引用，不要销毁 runtime，避免下次 init 重建 */
  detachWindow() {
    this.browserController?.detachWindow();
    this.win = null;
  }

  /**
   * 是否有任何会话槽正在跑一轮（关窗/退出确认用）：后台会话也算。
   * 用主进程侧 session 的真实状态，而不是渲染进程可能滞后的 isStreaming。
   */
  isSessionRunning(): boolean {
    return this.runningSessionCount() > 0;
  }

  /** 在跑一轮的槽数（前台 + 后台）：退出确认文案会用到 */
  runningSessionCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      try {
        if (slot.session?.isStreaming === true) count++;
      } catch {
        // 单个槽状态读不到不影响其它槽
      }
    }
    return count;
  }

  /**
   * 中止所有槽的在途回合并等待落盘（abort 内部 waitForIdle 后才返回）。
   * 退出前调用：否则在途的部分回复会随进程消失，而不像切换会话那样被持久化。
   */
  async abortSession(): Promise<void> {
    await Promise.allSettled(
      [...this.slots.values()].map(async (slot) => {
        try {
          await slot.session?.abort();
        } catch {
          // 中止失败不阻断退出
        }
      })
    );
  }

  /**
   * 在指定槽（默认焦点槽）创建 AgentSessionRuntime。
   * @param sessionStartEvent 会话起始事件：从文件恢复用 reason: 'resume'，新建会话用 SDK 默认（startup）
   */
  async createRuntimeFor(
    cwd: string,
    sessionManager?: SessionManager,
    slot: SessionSlot = this.ensureFocusedSlot(),
    sessionStartEvent?: SessionStartEvent
  ) {
    // 同一槽重建（换项目/fork 失败恢复）：shutdown 扩展仍需访问旧 session，先等它结束
    if (slot.runtime) await this.releaseSlotRuntime(slot);
    // 建 runtime 的槽即焦点槽；控制器随槽创建（多会话下每槽一份）
    this.focusSlot(slot);
    this.createSlotControllers(slot);
    // 本项目会话第一次接入：断开旧项目的 MCP 客户端，避免同名服务器复用旧会话
    await mcpManager.disconnectAll();
    this.mcpProjectCwd = cwd;
    slot.cwd = cwd;
    // 会话目录显式指向 ~/.pi-desktop/sessions/<encoded-cwd>/，避免 SDK 默认落回 ~/.pi/agent
    slot.sessionManager = sessionManager ?? SessionManager.create(cwd, getSessionDir(cwd));
    const slotManager: SessionManager = slot.sessionManager;
    // 该槽自己的控制器（扩展工厂捕获它们：后台槽的状态推进只落在自己槽上）
    const slotGoal = slot.goalController;
    const slotPlan = slot.planController;
    const slotMemory = slot.memoryController;
    const slotSubagent = slot.subagentController;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: rtCwd,
      sessionManager: rtSm,
      sessionStartEvent: rtStartEvent
    }) => {
      const services = await createAgentSessionServices({
        cwd: rtCwd,
        // 复用主进程已创建的统一 ModelRuntime（避免 services 内部再建一个实例，
        // 否则 setProviderApiKey 只作用于 ctx.modelRuntime，而 AgentSession.setModel
        // 的 checkAuth 走另一个实例的陈旧 auth.json 缓存，导致 “No API key” 且重启后才恢复）
        modelRuntime: this.modelRuntime!,
        // agentDir 驱动 SDK 内部 skills/prompts/themes/settings/trust 等路径
        agentDir: AGENT_DIR,
        // pi-desktop 是 GUI 宿主，不加载 pi CLI 的扩展（extensions）。
        // 扩展是给 TUI 模式的 pi CLI 设计的，其 handler（如 pi-rewind 的
        // message_start checkpoint）在 pi-desktop 环境下会卡死 agent 循环。
        // skills/prompts/themes 是纯数据资源，保留加载（pi-desktop 有对应 UI）。
        // 注意:noExtensions 只关闭用户/CLI 扩展;goal 内联扩展经 extensionFactories
        // 注入,始终加载(见 SDK resource-loader.js:loadExtensionFactories 无条件调用)。
        resourceLoaderOptions: {
          noExtensions: true,
          // pi-desktop 自身说明：SDK 会把它渲染进 <addendum> 段
          // （完整段序：preamble/tools/rules/docs/addendum/project_context/skills/cwd，
          //  各扩展在 before_agent_start 里继续往后追加）。宿主环境认知由它提供。
          // 用 appendSystemPromptOverride 而非 appendSystemPrompt：显式传 appendSystemPrompt 会让
          // SDK 跳过对用户 APPEND_SYSTEM.md / 项目 .pi-desktop/APPEND_SYSTEM.md 的发现
          // （等于把用户自己的追加段整体顶掉）；override 只是在 base 之后追加，既不破坏发现也不改写用户文件。
          appendSystemPromptOverride: (base: string[]) => {
            const addendum = getDesktopPromptAddendum();
            return addendum ? [...base, addendum] : base;
          },
          // 内置只读技能（skill-creator 等），随安装包发布，经 additionalSkillPaths 注入。
          // 不放入用户可写的 ~/.pi-desktop/skills，避免被设置页删除。
          additionalSkillPaths: (() => {
            const paths = [getBuiltinSkillsDir()];
            // 项目级技能：用 <cwd>/.pi-desktop/skills 而非 SDK 默认的 <cwd>/.pi/skills，
            // 保持与 pi-desktop 的配置目录命名一致。.agents/skills 已由 SDK 自动加载。
            const projSkillDir = path.join(rtCwd, '.pi-desktop', 'skills');
            if (fs.existsSync(projSkillDir)) paths.push(projSkillDir);
            return paths;
          })(),
          // 屏蔽 SDK 默认加载的 <cwd>/.pi/skills：pi-desktop 项目级技能改用 .pi-desktop/skills。
          skillsOverride: (base) => {
            const piSkillsDir = path.resolve(rtCwd, '.pi', 'skills') + path.sep;
            const filtered = base.skills.filter(
              (s) => !path.resolve(s.filePath).startsWith(piSkillsDir)
            );
            return { skills: filtered, diagnostics: base.diagnostics };
          },
          extensionFactories: [
            goalExtensionFactory(slotGoal),
            planExtensionFactory(slotPlan),
            memoryExtensionFactory(slotMemory),
            subagentExtensionFactory(slotSubagent),
            backgroundTaskExtensionFactory(this.backgroundTaskController),
            // 用户生命周期钩子（~/.pi-desktop/hooks.json）：PreToolUse/PostToolUse/SessionStart/Stop
            hookExtensionFactory(),
            // git-ai 改动溯源：edit/write/bash 的 checkpoint 上报（git-ai log/blame 归属 AI 改动）
            gitAiExtensionFactory()
          ]
        }
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: rtSm,
          // 从文件恢复的槽用调用方给的事件（reason: 'resume'），否则用 SDK 默认（startup）
          sessionStartEvent: sessionStartEvent ?? rtStartEvent,
          customTools: [updatePlanTool, askTool, mcpProxyTool, readImgTool]
        })),
        services,
        diagnostics: services.diagnostics
      };
    };

    slot.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: AGENT_DIR,
      sessionManager: slotManager
    });

    slot.runtime.setBeforeSessionInvalidate(() => {
      slot.unsubscribe?.();
      slot.unsubscribe = null;
      slot.session = null;
    });
    slot.runtime.setRebindSession(async () => {
      slot.session = slot.runtime.session;
    });

    slot.session = slot.runtime.session;
    this.rebind(slot);
    // read_img 工具可见性：按当前模型是否支持视觉注入/移除
    this.syncReadImgTool(slot);
    // 权限闸门：链式包装 agent.beforeToolCall（切换 cwd 重建 runtime 后重新安装）
    slot.permissionController?.install(slot.session);
    // 重建/替换会话前若有挂起审批，按拒绝结算（只影响本槽）
    slot.permissionController?.clearPending();
    // Goal/Plan/Memory 模式：从本槽 session 恢复状态（session_start 扩展钩子也会调，这里幂等保底）
    slot.goalController?.onSessionSwitch();
    slot.planController?.onSessionSwitch();
    slot.memoryController?.onSessionSwitch();
    slot.subagentController?.onSessionSwitch();
    // MCP：设置当前 cwd 以便 loadMcpConfig 合并项目级 <cwd>/.mcp.json；
    // 会话创建时按配置决定是否自动连接服务器（懒加载默认不开）
    mcpManager.setCwd(cwd);
    await mcpManager.onSessionCreate().catch(() => {});
    this.runtimeReady = true;
    // 槽数超上限时按 LRU 释放空闲槽（忙的槽留到下次创建时回收）
    await this.enforceSlotLimit();
  }

  /**
   * 切换焦点到某个会话文件：
   * - 已经开着（含后台运行中）→ 只切焦点 + 重指焦点态单例；runtime/订阅/那一轮原样保留
   * - 没开过 → 新建一个槽并从该文件恢复（session_start reason: 'resume'）
   * 注意：切焦点不中止任何槽——后台会话继续跑完当前轮。
   */
  async openSessionInSlot(sessionFile: string): Promise<void> {
    // 参数既可以是会话文件路径，也可以是会话 id：新建会话在第一条消息落盘前没有文件，
    // 侧栏那一行只能按 id 切（见 mergeSessionList）。
    const existing = this.findSessionSlot(sessionFile);
    if (existing) {
      // 会话已在槽里（可能在后台跑着）：只切焦点，绝不重建 runtime
      logSlots(`切到已打开的槽 ${existing.key}（复用，不重建）`, { sessionFile });
      await this.syncSession(existing);
      return;
    }
    logSlots('切到未打开的会话：新建槽', { sessionFile });
    const sessionManager = SessionManager.open(sessionFile);
    const cwd = sessionManager.getCwd();
    const previousSessionFile = this.focus?.session?.sessionFile;
    const slot = this.createSlot();
    this.focusSlot(slot);
    // 新槽的 runtime 创建包在该槽的 access.run 里：revision 0→1，与「会话被替换/新建」语义一致
    await slot.access.run(() =>
      this.createRuntimeFor(cwd, sessionManager, slot, {
        type: 'session_start',
        reason: 'resume',
        previousSessionFile
      })
    );
  }

  /**
   * 会话列表投影：把「槽里已有、但扫描结果里没有」的**会话内容**补进列表。
   * 为什么需要：列表来自扫描 sessions 目录，而列表只在扫盘/agent_end 时更新，
   * 新建会话发完第一条消息后、扫描结果追上来之前，侧栏会看不到它。
   * 注意只补「已经有消息」的槽：空会话（刚新建、还没发消息）不该出现在列表里。
   * cwd 只在需要按项目过滤时传（当前项目的 current 列表）。
   */
  mergeSessionList(scanned: SessionInfo[], cwd?: string): SessionInfo[] {
    const seenIds = new Set(scanned.map((s) => s.id));
    const seenPaths = new Set(scanned.map((s) => s.path).filter(Boolean));
    const target = cwd ? path.resolve(cwd) : null;
    const merged = [...scanned];
    for (const slot of this.slots.values()) {
      const session = slot.session;
      const id: string | undefined = session?.sessionId;
      if (!id || seenIds.has(id)) continue;
      // 空会话不进列表（新建后还没发消息时不显示）
      const messageCount = session?.messages?.length ?? 0;
      if (messageCount === 0) continue;
      const file = slot.sessionFile();
      // 会话文件已被删（侧栏删掉、或在外部删掉）：槽里还留着内存副本，但列表里不该再出现——
      // 否则删完会话会多出一行「未命名会话」，要重开项目（清掉槽）才消失。
      if (file && !fs.existsSync(file)) continue;
      if (file && seenPaths.has(file)) continue;
      if (target !== null && (!slot.cwd || path.resolve(slot.cwd) !== target)) continue;
      merged.push({
        // 还没落盘时没有路径：渲染端用 id 作为切换参数（openSessionInSlot 两者都认）
        path: file ?? '',
        id,
        cwd: slot.cwd,
        name: session?.sessionName,
        parentSessionPath: undefined,
        created: new Date(slot.createdAt),
        modified: new Date(slot.lastActivityAt),
        messageCount,
        firstMessage: '',
        allMessagesText: ''
      });
      seenIds.add(id);
      if (file) seenPaths.add(file);
    }
    return merged;
  }

  /**
   * 新建会话：旧槽留在后台继续跑（不被中止/销毁），新会话进新槽并成为焦点。
   * cwd 与当前项目不同时只是换个项目目录新建（MCP 客户端重指到新项目）。
   */
  async newSessionInSlot(cwd?: string): Promise<void> {
    const previous = this.focus;
    const targetCwd = cwd ?? previous?.cwd ?? this.cwd;
    // 跨项目也开新槽：原焦点槽留在后台继续跑（MCP 在 createRuntimeFor 里重指到新项目）
    logSlots(`新建会话：新槽，原焦点槽 ${previous?.key ?? '(无)'} 留在后台继续跑`, {
      cwd: targetCwd
    });
    const slot = this.createSlot();
    this.focusSlot(slot);
    // 新槽的 runtime 创建包在该槽的 access.run 里：revision 0→1，与「会话被替换/新建」语义一致
    await slot.access.run(() => this.createRuntimeFor(targetCwd, undefined, slot));
  }

  /** 槽内 session 变化（或在槽之间切换焦点）后重指焦点态单例并 rebind 事件订阅 */
  async syncSession(slot: SessionSlot = this.focusedSlot()) {
    // 切焦点到别的槽时把它设为焦点：无会话参数的入口（getState/getMessages/控制器）都看它
    this.focusSlot(slot);
    const nextCwd = slot.runtime?.cwd ?? slot.cwd;
    if (nextCwd !== slot.cwd) slot.cwd = nextCwd;
    // MCP 只有一份客户端集合：焦点项目变了就断开重指（后台会话若在别的项目里调用 MCP
    // 工具会失败——这是跨项目后台运行的已知取舍，见类注释）
    if (this.mcpProjectCwd !== slot.cwd) {
      logSlots(`MCP 重指项目 ${this.mcpProjectCwd || '(无)'} → ${slot.cwd}`);
      await mcpManager.disconnectAll();
      mcpManager.setCwd(slot.cwd);
      await mcpManager.onSessionCreate().catch(() => {});
      this.mcpProjectCwd = slot.cwd;
    }
    slot.session = slot.runtime?.session ?? null;
    this.rebind(slot);
    // read_img：会话切换后按新会话模型重新同步可见性
    this.syncReadImgTool(slot);
    // 权限闸门：新 session 对象需重新安装（WeakSet 防重复包装）
    slot.permissionController?.install(slot.session);
    slot.permissionController?.clearPending();
    // 会话切换后恢复 goal/plan/memory 状态(session_start 扩展钩子也会调,这里作幂等保底)
    slot.goalController?.onSessionSwitch();
    slot.planController?.onSessionSwitch();
    slot.memoryController?.onSessionSwitch();
    slot.subagentController?.onSessionSwitch();
  }

  private rebind(slot: SessionSlot = this.focusedSlot()) {
    slot.unsubscribe?.();
    slot.unsubscribe = null;
    // 换会话时丢弃旧会话未推送的增量（新会话订阅建立后它们已无意义）
    slot.dropPendingUpdate();
    const session = slot.session;
    if (!session) return;
    const identity = slot.identity();
    slot.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // 日志先记：与窗口状态无关（窗口关掉后仍能落盘）
      logAgentEvent(event);
      if (slot.session !== session || slot.access.changing) return;
      // 槽活动跟踪（侧栏徽标）：后台槽跑完一轮就标未读，切过去自动清
      slot.lastActivityAt = Date.now();
      if (event.type === 'agent_end' && this.focusedKey !== slot.key) slot.unread = true;
      this.scheduleSessionSlotsEmit();
      if (event.type === 'agent_end') this.drainPendingPrompts();
      if (event.type === 'message_update') {
        // 高频增量：只留最新一条，定时冲刷（见 SessionSlot.queueMessageUpdate）
        slot.queueMessageUpdate(event, identity);
        return;
      }
      // 其余事件立即推送；先冲刷增量，避免渲染端先看到工具开始/消息结束却缺最后一段文本。
      // 走 slot.deliver（内部判断是否焦点槽）：后台槽的事件在这里被静默丢弃。
      slot.flushPendingUpdate();
      slot.deliver(event, identity);
    });
    this.bindAskNotifier();
    // 切回来时把本槽挂起的交互重新推给渲染进程：后台期间的事件带的是后台槽身份，
    // 被渲染端按「焦点会话」过滤丢掉了，不重推就会看不到审批面板/提问面板。
    slot.permissionController?.replayPending();
    const pendingQuestions = slot.session ? pendingAskQuestions(slot.session.sessionId) : null;
    if (pendingQuestions) this.sendSessionEventFor(slot, 'pi:askUser', pendingQuestions);
  }

  /**
   * 切换 plan 模式:委托给 PlanController 的阶段状态机。
   * 工具裁剪 + 阶段切换由 controller 管;plan 提示词注入改走 before_agent_start
   * 扩展钩子(避免旧实现被 SDK 每轮 refresh 覆盖,导致 plan 指令到不了模型)。
   */
  setPlanMode(enabled: boolean) {
    this.setPlanModeFor(this.focusedSlot(), enabled);
  }

  /** 指定槽的 plan 模式切换：goal/plan 互斥；退出 plan 后让本槽的 goal 重新拿回工具可见性 */
  private setPlanModeFor(slot: SessionSlot, enabled: boolean): void {
    if (enabled) slot.planController?.enterPlanning();
    else slot.planController?.exitToIdle();
    if (!enabled) slot.goalController?.refreshGoalToolVisibility();
  }

  /**
   * read_img：归一化设置页保存的视觉模型配置（非法/不完整 → null = 不启用）
   */
  normalizeReadImgConfig(v: unknown): ReadImgModelConfig | null {
    if (!v || typeof v !== 'object') return null;
    const c = v as { provider?: unknown; modelId?: unknown };
    if (typeof c.provider !== 'string' || typeof c.modelId !== 'string') return null;
    if (!c.provider || !c.modelId) return null;
    return { provider: c.provider, modelId: c.modelId };
  }

  /**
   * read_img：按当前模型是否支持视觉同步工具可见性。
   * - 未配置视觉模型 → 移除（任何情况不提供）
   * - 当前模型支持视觉（input 含 'image'）→ 移除（agent 直接可看图）
   * - 当前模型不支持视觉且已配置 → 注入
   * 在 createRuntimeFor 后与 pi:setModel 时调用。
   */
  syncReadImgTool(slot: SessionSlot = this.focusedSlot()): void {
    try {
      const session = slot.session;
      if (!session?.setActiveToolsByName) return;
      const config = getReadImgModelConfig();
      const model = session.model ?? session.agent?.state?.model;
      const currentSupportsVision = Array.isArray(model?.input) && model.input.includes('image');
      const shouldHave = !!config && !currentSupportsVision;

      const active: string[] = session.getActiveToolNames();
      const has = active.includes('read_img');
      if (shouldHave && !has) {
        session.setActiveToolsByName([...active, 'read_img']);
      } else if (!shouldHave && has) {
        session.setActiveToolsByName(active.filter((n) => n !== 'read_img'));
      }
    } catch {
      // 同步失败不阻塞会话（read_img 仅是能力增强）
    }
  }

  /**
   * 设置页更新 read_img 视觉模型配置（立即生效）：更新工具内配置并同步可见性
   */
  setReadImgModel(provider: string | null, modelId: string | null): void {
    const config = provider && modelId ? { provider, modelId } : null;
    setReadImgModelConfig(this.normalizeReadImgConfig(config));
    // 所有槽都要跟着变：后台会话的模型可能和焦点会话不同
    for (const slot of this.slots.values()) this.syncReadImgTool(slot);
  }

  registerHandlers() {
    if (this.handlersRegistered) return;
    registerSessionIpc(this);
    registerModelIpc(this);
    registerClassifierIpc(this);
    registerSkillIpc(this);
    registerMiscIpc(this);
    registerTerminalIpc(this);
    registerMcpIpc(this);
    registerGoalIpc(this);
    registerPlanIpc(this);
    registerSettingsIpc(this);
    registerStatisticsIpc();
    registerMemoryIpc(this);
    registerGitIpc(this);
    registerGitAiIpc();
    registerPermissionIpc(this);
    registerSubagentIpc(this);
    registerBackgroundTaskIpc(this);
    registerHookIpc(this);
    registerBrowserIpc(this.browserController);
    registerLogsIpc();
    this.handlersRegistered = true;
  }

  /** 释放一个槽的 runtime（槽对象保留，可再次使用）：解绑订阅 + 销毁 SDK 运行时 */
  private async releaseSlotRuntime(slot: SessionSlot): Promise<void> {
    const runtime = slot.runtime;
    const focused = slot.key === this.focusedKey;
    logSlots(`销毁槽 runtime ${slot.key}`, {
      sessionId: slot.session?.sessionId ?? null,
      focused,
      running: this.isSlotBusy(slot)
    });
    if (runtime && focused) {
      slot.permissionController?.clearPending();
      if (slot.session?.sessionId) resolveAsk(slot.session.sessionId, null);
      slot.planController?.cancelPending({
        approved: false,
        feedback: t.sessionSwitchCancelled
      });
    }
    try {
      if (runtime) {
        // 子 agent 会话绑定在控制器上：runtime 被替换/槽被释放时停掉本槽的子 agent
        // （onSessionSwitch 会复位 stopping，所以同一个控制器可按槽继续用）
        const childrenStopped = slot.subagentController?.dispose();
        try {
          await disposeRuntime(runtime);
        } finally {
          await childrenStopped;
        }
      }
    } catch (error) {
      console.error('Failed to dispose runtime:', error);
    } finally {
      slot.unsubscribe?.();
      slot.unsubscribe = null;
      slot.session = null;
      slot.runtime = null;
      if (focused) this.runtimeReady = false;
    }
  }

  /** 释放所有槽的 runtime 并清空槽集合（退出用） */
  private async releaseAllSlots(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slotOrder.length = 0;
    for (const slot of slots) {
      // 先清空集合再逐个释放：释放过程里 session_shutdown 扩展可能回调 PiBridge
      this.slots.delete(slot.key);
      slot.dropPendingUpdate();
      await this.releaseSlotRuntime(slot);
      await this.disposeSlotControllers(slot);
    }
    this.focusedKey = '';
    this.emitSessionSlots();
  }

  /** 等待 SDK shutdown 和所有异步清理；重复退出共享同一个 Promise。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.enqueueOp(async () => {
      // 未冲刷的增量不再推送：窗口正在关闭，避免定时器在销毁后还发 IPC
      for (const slot of this.slots.values()) slot.dropPendingUpdate();
      if (this.slotsEmitTimer) {
        clearTimeout(this.slotsEmitTimer);
        this.slotsEmitTimer = null;
      }
      // memory 控制器先收尾（等它的提取/合并任务结束）再销毁 runtime——保持原顺序语义
      await Promise.allSettled(
        [...this.slots.values()].map((slot) => this.disposeSlotControllers(slot))
      );
      // 槽级控制器的销毁在 releaseAllSlots 里逐个完成（含 memory/subagent）
      await this.releaseAllSlots();
      setAskNotifier(null);
      resolveAllAsks();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => killAllTerminals()),
        Promise.resolve().then(() => this.backgroundTaskController?.dispose()),
        Promise.resolve().then(() => this.browserController?.setEnabled(false))
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.error('Cleanup failed:', result.reason);
      }
      await mcpManager.disconnectAll();
    });
    return this.disposePromise;
  }
}
