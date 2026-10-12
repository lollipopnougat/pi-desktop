import type { SessionIdentity } from '../src/types/session';
import { SessionAccess } from './session-access';

/** agent 流式增量的合帧窗口（ms）：约 33 帧/秒，肉眼已无区别，IPC 体积降一个量级 */
const EVENT_FLUSH_MS = 30;

/**
 * 会话槽（SessionSlot）：一个「活着的会话」在主进程侧需要的全部状态。
 *
 * 为什么要这一层：这些状态过去直接作为 PiBridge 的字段存在
 * （runtime/session/cwd/sessionManager/sessionAccess/事件合帧），隐含了
 * 「进程内同时只有一个会话」的前提。多会话后台运行（方案 B）要求把它们
 * 变成 `Map<会话键, SessionSlot>` + 一个焦点键，所以这里先把状态收进槽对象，
 * 并让所有访问都必须先经过会话键解析（PiBridge.sessionFor）。
 *
 * 多会话（Stage 1）：PiBridge 持有 `Map<槽键, SessionSlot>`，焦点槽之外的都是后台槽——
 * 切焦点不销毁旧槽，那一轮继续跑完，切回来直接复用（不重建 runtime/不重载服务）。
 */
/**
 * 控制器/执行器访问「它所服务的那个会话」的最小面。
 *
 * Stage 0：由 PiBridge.sessionHost() 按焦点槽生成（进程内仍只有一个会话）。
 * 多会话阶段：每个会话槽生成一份并注入各自的控制器实例（控制器不再是进程级单例），
 * 这样后台会话的 goal/plan/subagent 状态推进不会落到前台会话上。
 */
/**
 * 会话槽的渲染进程投影（侧栏徽标 / 后台会话清单）。
 * 只含标量：后台槽不推聊天内容，渲染端只需知道「在跑/未读/等待审批」。
 */
export interface SessionSlotSnapshot {
  /** 槽键（IPC 按会话操作时用） */
  key: string;
  /** 会话 ID（渲染端按它匹配侧栏里的会话行） */
  sessionId: string | null;
  /** 会话文件路径（匹配不到 sessionId 时用） */
  sessionFile: string | null;
  cwd: string;
  /** 是否有工作在飞（在途回合或排队消息待跑） */
  running: boolean;
  /** 后台期间跑完了一轮/有挂起交互 → 侧栏未读点 */
  unread: boolean;
  /** 挂起的权限审批数（侧栏显示「等待审批」） */
  pendingApprovals: number;
  /** 挂起的 ask 提问数（侧栏同样显示「等待审批」，两者都要用户动手） */
  pendingAsks: number;
  /** 因并发上限（同时 3 个会话）排队中的用户回合数 */
  queuedPrompts: number;
  createdAt: number;
  lastActivityAt: number;
}

/** 槽状态推送的载荷 */
export interface SessionSlotsPayload {
  focusedKey: string;
  slots: SessionSlotSnapshot[];
}

export interface SessionHost {
  /** 所服务的会话；未就绪返回 null（保留原先 getSession()?.x 的容忍语义） */
  current(): any | null;
  /** 所服务的会话 cwd */
  cwd(): string;
  /** 向渲染进程推送该会话的事件（事件身份随槽） */
  sendSessionEvent(channel: string, payload: unknown): boolean;
  /** 切换该会话的 plan 模式（goal/plan 互斥，见 PiBridge.setPlanMode） */
  setPlanMode(enabled: boolean): void;
}

export class SessionSlot {
  /** AgentSessionRuntime（SDK 运行时；switchSession/fork 后 session 会变） */
  runtime: any = null;
  /** 当前 AgentSession */
  session: any = null;
  /** 该槽的 cwd（同一槽内不会变，换项目等于换槽/重建 runtime） */
  cwd = '';
  /** 该槽的 SessionManager（用于切换失败时恢复旧会话文件） */
  sessionManager: any = null;
  /**
   * 该槽自己的控制器（goal/plan/memory/subagent/permission）：随槽创建、随槽释放。
   * 每个槽一份 = 后台会话的 goal 续跑/计划状态/记忆注入/子 agent 都落在自己的槽上，
   * 不会写进前台会话。类型用 any 避开与控制器模块的循环依赖（真正的类型在 PiBridge 侧）。
   */
  goalController: any = null;
  planController: any = null;
  memoryController: any = null;
  subagentController: any = null;
  permissionController: any = null;
  /** 控制器是否已按槽创建（幂等标记：同一槽重建 runtime 时不重复创建） */
  controllersReady = false;
  /** 槽级控制器是否已销毁（幂等标记：退出流程里可能先收尾再释放槽） */
  controllersDisposed = false;
  /** 会话替换串行队列：每个槽独立，一个槽的切换不再阻塞别的槽 */
  readonly access = new SessionAccess();
  /** 槽创建时间 */
  readonly createdAt = Date.now();
  /** 最近活动时间（本槽 SDK 事件到达时刷新） */
  lastActivityAt = Date.now();
  /** 后台期间跑完了一轮/有挂起交互 → 未读；切到焦点时清掉 */
  unread = false;
  /**
   * 并发闸门排队中的用户回合（PiBridge.submitPrompt 写入）：
   * 同时在跑的会话数达到上限时先排在这里，有槽腾出来再自动发出。
   */
  readonly pendingPrompts: Array<{ text: string; options?: any }> = [];
  /** 该槽的 SDK 事件订阅解绑函数（每槽独立：切焦点不解绑，只有释放槽才解绑） */
  unsubscribe: (() => void) | null = null;
  /** 未推送的 message_update 增量（只保留最新一条，见 queueMessageUpdate） */
  private pendingUpdate: { event: any; identity: SessionIdentity } | null = null;
  private updateFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** 会话键：槽的唯一标识（多会话阶段由 renderer 传入的 sessionKey 解析得到） */
    readonly key: string,
    /** 事件发送器：把（已合帧的）会话事件推给窗口 */
    private readonly sendEvent: (event: any, identity: SessionIdentity) => void
  ) {}

  get revision(): number {
    return this.access.revision;
  }

  get ready(): boolean {
    return !!this.session;
  }

  /** 渲染进程投影（running 由 PiBridge 按会话状态判定后传入） */
  /**
   * 会话文件路径。
   * 注意「新会话在第一条消息落盘前没有文件」是 SDK 的设计（session-manager.js：
   * 「A new session file is created only once the session contains a user or assistant message」），
   * 所以这里可能是 null —— 会话列表要靠槽状态把它补出来（PiBridge.mergeSessionList）。
   */
  sessionFile(): string | null {
    try {
      return this.session?.sessionFile ?? this.sessionManager?.getSessionFile?.() ?? null;
    } catch {
      return null;
    }
  }

  snapshot(running: boolean, pendingAsks = 0): SessionSlotSnapshot {
    const sessionFile = this.sessionFile();
    return {
      key: this.key,
      sessionId: this.session?.sessionId ?? null,
      sessionFile,
      cwd: this.cwd,
      running,
      unread: this.unread,
      pendingApprovals: this.permissionController?.pendingCount?.() ?? 0,
      pendingAsks,
      queuedPrompts: this.pendingPrompts.length,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt
    };
  }

  /** 会话身份（sessionId + 会话版本）：未初始化时抛错，与原 PiBridge.getSession 语义一致 */
  identity(): SessionIdentity {
    return { sessionId: this.requireSession().sessionId, sessionRevision: this.access.revision };
  }

  /** 该槽当前的会话；未就绪时抛错 */
  requireSession(): any {
    if (!this.session) throw new Error('Session not initialized');
    return this.session;
  }

  /**
   * 高频增量合帧：message_update 每个 token 一条且带「累计到当前的完整消息」，
   * 渲染端只需要最后一份 → 合并成 ~30ms 一次的推送。identity 随事件暂存，
   * 合帧期间槽内换了会话也不会把旧事件标成新身份。
   */
  queueMessageUpdate(event: any, identity: SessionIdentity): void {
    this.pendingUpdate = { event, identity };
    if (!this.updateFlushTimer) {
      this.updateFlushTimer = setTimeout(() => this.flushPendingUpdate(), EVENT_FLUSH_MS);
    }
  }

  /** 立即推送暂存的增量（终端事件到达时先冲刷，保证顺序不倒置） */
  flushPendingUpdate(): void {
    if (this.updateFlushTimer) {
      clearTimeout(this.updateFlushTimer);
      this.updateFlushTimer = null;
    }
    const pending = this.pendingUpdate;
    this.pendingUpdate = null;
    if (pending) this.deliver(pending.event, pending.identity);
  }

  /**
   * 直接投递一个事件（不走合帧）：发送器自身会判断本槽是否还是焦点槽，
   * 后台槽的事件在这里被静默丢弃——「后台继续跑但不推给渲染进程」就靠这一层。
   */
  deliver(event: any, identity: SessionIdentity): void {
    this.sendEvent(event, identity);
  }

  /** 丢弃未推送的增量（换会话/销毁时用，防止旧会话的尾巴串到新会话） */
  dropPendingUpdate(): void {
    if (this.updateFlushTimer) {
      clearTimeout(this.updateFlushTimer);
      this.updateFlushTimer = null;
    }
    this.pendingUpdate = null;
  }
}
