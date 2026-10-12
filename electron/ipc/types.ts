/**
 * IPC 模块访问 PiBridge 的上下文接口。
 * PiBridge 实现此接口，IPC 注册函数接收它来访问 runtime/session 等。
 */
import type { SessionSlot } from '../session-slot';
import type { SessionIdentity } from '../../src/types/session';
import type { SessionSlotSnapshot, SessionSlotsPayload } from '../session-slot';
import type { SessionInfo, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AskQuestion } from '../tools';
import type { PermissionRequest } from '../permission/controller';

/** 焦点会话挂起的交互（提问 / 审批）：渲染端刷新会话状态后主动拉取 */
export interface PendingInteractions {
  ask: { sessionId: string; questions: AskQuestion[] } | null;
  permission: PermissionRequest | null;
}

export interface PiBridgeContext {
  /** 当前 AgentSessionRuntime */
  readonly runtime: any;
  /** 当前 cwd */
  readonly cwd: string;
  /**
   * 会话槽解析（会话相关逻辑的唯一入口）：不传键 = 焦点槽。
   * handler 应在方法**入口**解析一次，把 slot/session 作为局部变量向下传；
   * 不要在 await 之后重新解析或调用 getSession()——那等于隐式依赖「调用时的当前会话」，
   * 多会话后台运行时会把操作落到别人身上。
   */
  sessionFor(key?: string | null): SessionSlot;
  /**
   * 按会话文件路径或会话 id 查找已经在槽里的会话（含后台槽）；找不到返回 null。
   * 用于「只读地碰某个会话、不要惊人地切换/中止焦点会话」的场景（如导出 HTML）。
   */
  findSessionSlot(key: string): SessionSlot | null;
  /**
   * 删除会话文件后的槽收尾：释放还持有该会话的空闲后台槽。
   * 返回 `'focused'`（是当前激活会话）/ `'busy'`（后台还在跑）/ `'released'` / `'none'`。
   */
  dropSessionSlot(sessionFileOrId: string): Promise<'focused' | 'busy' | 'released' | 'none'>;
  /** runtime 切换 session 后同步 this.session 并 rebind 事件订阅（不传 = 焦点槽） */
  syncSession(): Promise<void>;
  readonly sessionAccess: SessionSlot['access'];
  getSessionIdentity(): SessionIdentity;
  /**
   * 会话**替换**操作（fork/navigate/导出临时切换/换项目）：串行执行，并中止焦点槽的当前轮。
   * 切换会话请用 runFocusOperation + openSessionInSlot（不中止任何槽）。
   */
  runSessionOperation<T>(operation: () => Promise<T>): Promise<T>;
  /** 切焦点/新建会话：不中止任何槽（后台会话继续跑完当前轮），只与其它会话操作互斥 */
  runFocusOperation<T>(operation: () => Promise<T>): Promise<T>;
  /** 切换焦点到某个会话文件（已打开的会话复用其槽：后台运行不受影响） */
  openSessionInSlot(sessionFile: string): Promise<void>;
  /** 新建会话（旧会话留在后台继续跑）；cwd 变化视为换项目 */
  newSessionInSlot(cwd?: string): Promise<void>;
  createRuntimeFor(cwd: string, sessionManager?: SessionManager): Promise<void>;
  /**
   * 中止指定槽的在途回合（默认焦点槽）：侧栏「停止」按钮用——
   * 可以停后台会话而不必先切过去。
   */
  abortSlot(key?: string | null): Promise<void>;
  /**
   * 用户发起一个回合（并发闸门入口）：返回 queued=true 表示已达「同时 3 个会话」上限、
   * 已排队等空位（渲染端据此提示用户），否则已交给 SDK。
   */
  submitPrompt(text: string, options: any, key?: string | null): Promise<{ queued: boolean }>;
  /** 所有会话槽的渲染进程投影（在跑/未读/等待审批） */
  slotSnapshots(): SessionSlotSnapshot[];
  /** 槽状态快照 + 焦点键（渲染端订阅/主动拉取同一份结构） */
  sessionSlots(): SessionSlotsPayload;
  /**
   * 会话列表投影：扫描结果 + 槽内存里尚未落盘的新会话（否则新建会话首轮结束前不在列表里）。
   * cwd 只在需要按项目过滤时传。
   */
  mergeSessionList(scanned: SessionInfo[], cwd?: string): SessionInfo[];
  /**
   * 焦点槽挂起的交互（提问/审批）：渲染端在会话状态刷新后主动拉一次。
   * 推送路径（rebind 的 replay）在切换过程中会被渲染端按「焦点会话」过滤丢掉，拉取才可靠。
   */
  pendingInteractions(): PendingInteractions;
  /** 切换 plan 模式（限制为只读工具集 / 恢复全部工具） */
  setPlanMode(enabled: boolean): void;
}
