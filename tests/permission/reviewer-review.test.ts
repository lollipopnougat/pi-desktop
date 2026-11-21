/**
 * 评审编排单测（`electron/permission/reviewer/review.ts`）。
 *
 * 用假会话驱动，覆盖四条关键路径：
 * - 正常拿到 JSON → 直接给结论
 * - 输出不是 JSON → 同一会话重问一次
 * - 超时 → abort + 丢弃会话 + 返回 timeout（**不重试**：重试只会让用户多等一倍）
 * - 取消 → 返回 aborted（attemp 0，不创建会话）
 */
import { describe, it, expect, vi } from 'vitest';
import { MAX_REVIEW_ATTEMPTS, runReview } from '../../electron/permission/reviewer/review';
import type { ReviewerSessionLike } from '../../electron/permission/reviewer/session-pool';

/** 按脚本依次返回 assistant 文本的假会话 */
function makeSession(replies: (string | (() => never))[], hooks: { prompts?: string[] } = {}) {
  const state = { index: 0, aborted: 0, disposed: 0 };
  const session: ReviewerSessionLike = {
    async prompt(text: string) {
      hooks.prompts?.push(text);
      const reply = replies[state.index];
      state.index += 1;
      if (typeof reply === 'function') reply();
    },
    async abort() {
      state.aborted += 1;
    },
    dispose() {
      state.disposed += 1;
    },
    getLastAssistantText() {
      const reply = replies[state.index - 1];
      return typeof reply === 'string' ? reply : '';
    }
  };
  return { session, state };
}

function baseInput(session: ReviewerSessionLike, overrides: Record<string, unknown> = {}) {
  const dropped = { count: 0 };
  return {
    input: {
      runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      acquire: async () => session,
      drop: async () => {
        dropped.count += 1;
      },
      userMessage: '## 待审动作\n工具：bash',
      timeoutMs: 200,
      ...overrides
    },
    dropped
  };
}

describe('runReview', () => {
  it('合法 JSON → 返回 allow 结论，一次尝试', async () => {
    const { session } = makeSession(['{"outcome":"allow","risk_level":"low"}']);
    const { input, dropped } = baseInput(session);
    const result = await runReview(input);
    expect(result.kind).toBe('allow');
    expect(result.verdict?.outcome).toBe('allow');
    expect(result.attempts).toBe(1);
    expect(dropped.count).toBe(0);
  });

  it('deny 结论同样带 verdict 与理由', async () => {
    const { session } = makeSession([
      '{"outcome":"deny","risk_level":"high","rationale":"未授权"}'
    ]);
    const { input } = baseInput(session);
    const result = await runReview(input);
    expect(result.kind).toBe('deny');
    expect(result.verdict?.rationale).toBe('未授权');
  });

  it('输出不是 JSON → 同一会话重问一次（第二次提示只输出 JSON）', async () => {
    const prompts: string[] = [];
    const { session } = makeSession(['我觉得可以放行', '{"outcome":"allow"}'], { prompts });
    const { input } = baseInput(session);
    const result = await runReview(input);
    expect(result.kind).toBe('allow');
    expect(result.attempts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('只输出一个 JSON 对象');
  });

  it('连续两次都不是 JSON → error + 丢弃会话', async () => {
    const { session } = makeSession(['nope', 'still nope']);
    const { input, dropped } = baseInput(session);
    const result = await runReview(input);
    expect(result.verdict).toBeNull();
    expect(result.kind).toBe('error');
    expect(result.attempts).toBe(MAX_REVIEW_ATTEMPTS);
    expect(result.note).toContain('不是合法 JSON');
    expect(dropped.count).toBe(1);
  });

  it('超时 → abort 会话 + 丢弃 + timeout（不重试）', async () => {
    const { session, state } = makeSession([
      () => {
        // 永不 resolve
        return new Promise<never>(() => {}) as never;
      }
    ]);
    // prompt 需要真的挂住：用自定义 session 覆盖
    const hanging: ReviewerSessionLike = {
      ...session,
      prompt: () => new Promise<void>(() => {})
    };
    const { input, dropped } = baseInput(hanging, { timeoutMs: 30 });
    const result = await runReview(input);
    expect(result.kind).toBe('timeout');
    expect(result.verdict).toBeNull();
    expect(result.attempts).toBe(1);
    expect(state.aborted).toBe(1);
    expect(dropped.count).toBe(1);
  });

  it('开始前已取消 → aborted 且不创建会话', async () => {
    const { session } = makeSession(['{"outcome":"allow"}']);
    const controller = new AbortController();
    controller.abort();
    let acquired = 0;
    const { input } = baseInput(session, {
      signal: controller.signal,
      acquire: async () => {
        acquired += 1;
        return session;
      }
    });
    const result = await runReview(input);
    expect(result.kind).toBe('aborted');
    expect(result.attempts).toBe(0);
    expect(acquired).toBe(0);
  });

  it('会话创建失败 → error 且带原因', async () => {
    const { session } = makeSession(['{"outcome":"allow"}']);
    const { input } = baseInput(session, {
      acquire: async () => {
        throw new Error('no api key');
      }
    });
    const result = await runReview(input);
    expect(result.kind).toBe('error');
    expect(result.note).toContain('no api key');
  });

  it('prompt 抛错 → error + 丢弃会话', async () => {
    const { session } = makeSession([
      () => {
        throw new Error('upstream 500');
      }
    ]);
    const { input, dropped } = baseInput(session);
    const result = await runReview(input);
    expect(result.kind).toBe('error');
    expect(result.note).toContain('upstream 500');
    expect(dropped.count).toBe(1);
  });

  it('读取结果抛错 → error 且丢弃会话', async () => {
    const { session } = makeSession(['{"outcome":"allow"}']);
    const broken: ReviewerSessionLike = {
      ...session,
      getLastAssistantText: () => {
        throw new Error('boom');
      }
    };
    const { input, dropped } = baseInput(broken);
    const result = await runReview(input);
    expect(result.kind).toBe('error');
    expect(result.note).toContain('读取评审结果失败');
    expect(dropped.count).toBe(1);
  });

  it('串行化入口被使用（同一槽不会并发评审）', async () => {
    const { session } = makeSession(['{"outcome":"allow"}']);
    const runExclusive = vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn());
    const { input } = baseInput(session, { runExclusive });
    await runReview(input);
    expect(runExclusive).toHaveBeenCalledTimes(1);
  });

  it('waitForIdle 被等待（避免读到半截 JSON）', async () => {
    const { session } = makeSession(['{"outcome":"allow"}']);
    const waitForIdle = vi.fn(async () => {});
    const { input } = baseInput({ ...session, waitForIdle });
    await runReview(input);
    expect(waitForIdle).toHaveBeenCalled();
  });
});
