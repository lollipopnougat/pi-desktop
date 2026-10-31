/**
 * 评审员会话的创建与复用。
 *
 * 三个安全边界（改动前请读 docs/APPROVE-FOR-ME.md §3.3）：
 * 1. **只读工具白名单**：`read / grep / find / ls`，**绝不给 bash**
 *    —— 本项目没有 OS 级 sandbox，给了 bash 等于给了写入与网络。
 * 2. **不加载任何扩展**（`noExtensions`）：评审员会话不会被权限闸门包装，因此不会递归审批。
 * 3. **内存会话**（`SessionManager.inMemory`）：评审对话是过程数据，不落盘、不进会话列表。
 *
 * 系统提示词用 `systemPromptOverride` **整体替换**成安全策略：评审员不需要编程助手的
 * preamble（那会诱导它去改文件），也不需要用户自己的 APPEND_SYSTEM.md。
 *
 * 会话复用（session pool）：一个槽一个池，键 = 模型 + 策略指纹 + cwd。复用能让
 * prompt cache 命中，但会话轮数太多会自我强化且吃掉上下文，所以到阈值就重建。
 */
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager
} from '@earendil-works/pi-coding-agent';
import { REVIEWER_TOOL_NAMES } from './policy-prompt';

/** 单个评审员会话最多承载多少次评审（超过就重建，防上下文膨胀与自我强化） */
export const MAX_REVIEWS_PER_SESSION = 12;

/** 只依赖用到的几个方法，便于测试注入假会话 */
export interface ReviewerSessionLike {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
  waitForIdle?(): Promise<void>;
}

export interface CreateReviewerSessionOptions {
  cwd: string;
  agentDir: string;
  /** ModelRuntime（复用主进程实例：鉴权/模型清单零 IPC） */
  modelRuntime: unknown;
  /** 已解析好的模型对象（评审员默认跟随会话模型） */
  model: unknown;
  /** 系统提示词（安全策略全文） */
  systemPrompt: string;
  /** 是否给只读工具（设置页可关：纯凭转录判断，最省 token） */
  readOnlyTools: boolean;
}

/** 创建评审员会话（一次评审一个 turn；由 ReviewerSessionPool 负责复用与释放） */
export async function createReviewerSession(
  options: CreateReviewerSessionOptions
): Promise<ReviewerSessionLike> {
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime as never,
    resourceLoaderOptions: {
      // 评审员不挂任何扩展：它不该有工具以外的能力，更不该被权限闸门包住（否则递归审批）
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // AGENTS.md 由 buildReviewRequest 摘录注入（可信证据之一），不交给 loader 自动加载
      noContextFiles: true,
      systemPromptOverride: () => options.systemPrompt
    }
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(options.cwd),
    model: options.model as never,
    thinkingLevel: 'low',
    // SDK 的 tools 是硬白名单：只读查询能力，没有 bash / 写工具
    tools: options.readOnlyTools ? [...REVIEWER_TOOL_NAMES] : [],
    customTools: []
  });
  return created.session as unknown as ReviewerSessionLike;
}

interface PoolEntry {
  key: string;
  session: ReviewerSessionLike;
  reviews: number;
}

/**
 * 槽级评审员会话池。
 *
 * `runExclusive` 把同一槽的评审串行化：评审员会话是有状态的复用对象，
 * 两次评审并发跑同一个 session 会互相污染上下文。
 */
export class ReviewerSessionPool {
  private entry: PoolEntry | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  /** 串行执行一次评审（失败不会打断后续任务链） */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /** 取会话：键相同且未超复用上限就复用，否则丢弃重建 */
  async acquire(
    key: string,
    create: () => Promise<ReviewerSessionLike>
  ): Promise<ReviewerSessionLike> {
    if (this.disposed) throw new Error('评审员会话池已释放');
    if (this.entry && this.entry.key === key && entryUsable(this.entry)) {
      this.entry.reviews += 1;
      return this.entry.session;
    }
    await this.drop();
    const session = await create();
    if (this.disposed) {
      // 创建期间池被释放（槽销毁/策略切换）：立刻回收，避免泄漏一个永不释放的会话
      try {
        session.dispose();
      } catch {}
      throw new Error('评审员会话池已释放');
    }
    this.entry = { key, session, reviews: 1 };
    return session;
  }

  /** 丢弃当前会话（超时/中止后必须重建：会话可能停在半途状态） */
  async drop(): Promise<void> {
    const entry = this.entry;
    this.entry = null;
    if (!entry) return;
    try {
      entry.session.dispose();
    } catch {}
  }

  /** 释放整个池（槽销毁 / 权限策略切换 / PiBridge dispose） */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.drop();
    // 等排队中的评审收尾（它们会拿到「池已释放」并按 onFailure 处理）
    await this.tail.catch(() => {});
  }

  get size(): number {
    return this.entry ? 1 : 0;
  }
}

function entryUsable(entry: PoolEntry): boolean {
  return entry.reviews < MAX_REVIEWS_PER_SESSION;
}
