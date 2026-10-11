/**
 * IPC 模块访问 PiBridge 的上下文接口。
 * PiBridge 实现此接口，IPC 注册函数接收它来访问 runtime/session 等。
 */
import type { SessionAccess } from '../session-access';
import type { SessionIdentity } from '../../src/types/session';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

export interface PiBridgeContext {
  /** 当前 AgentSessionRuntime */
  readonly runtime: any;
  /** 当前 cwd */
  readonly cwd: string;
  /** 获取当前 AgentSession */
  getSession(): any;
  /** runtime 切换 session 后同步 this.session 并 rebind 事件订阅 */
  syncSession(): Promise<void>;
  readonly sessionAccess: SessionAccess;
  getSessionIdentity(): SessionIdentity;
  runSessionOperation<T>(operation: () => Promise<T>): Promise<T>;
  createRuntimeFor(cwd: string, sessionManager?: SessionManager): Promise<void>;
  /** 切换 plan 模式（限制为只读工具集 / 恢复全部工具） */
  setPlanMode(enabled: boolean): void;
}
