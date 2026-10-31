/**
 * 单次评审的编排：超时、取消、一次解析重试、会话池复用。
 *
 * 与 Codex 的一处**有意不同**：这里**不 fail-closed**。评审员不可用（超时/解析失败/没配模型）
 * 时返回 `verdict: null`，由权限控制器按配置决定「回退人工审批」（默认）还是「直接拒绝」。
 * 理由：桌面端用户就在旁边，回退人工比直接拒绝更安全，也不会把任务卡死在一次模型抖动上。
 *
 * 重试策略：只有**解析失败**重试一次（同一 deadline 内），超时/取消不重试 ——
 * 超时意味着模型慢，重试只会让用户多等一倍。
 */
import { parseReviewerVerdict, type ReviewerVerdict } from './verdict';
import type { ReviewerSessionLike } from './session-pool';

/** 单次评审最多两次尝试（第二次只是提醒模型「只输出 JSON」） */
export const MAX_REVIEW_ATTEMPTS = 2;

export type ReviewFailureKind = 'timeout' | 'aborted' | 'error';

export interface RunReviewInput {
  /** 会话池的串行化入口（同一槽的评审不并发，评审员会话是有状态的复用对象） */
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** 取（或创建）复用的评审会话 */
  acquire: () => Promise<ReviewerSessionLike>;
  /** 超时/异常后丢弃复用的会话（半途状态不可复用） */
  drop: () => Promise<void>;
  /** 策略 + 动作 + 转录组装好的 user 消息 */
  userMessage: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ReviewRunResult {
  /** null = 没判出来（按 onFailure 处理），不是拒绝 */
  verdict: ReviewerVerdict | null;
  /** verdict 非空时等于 verdict.outcome */
  kind: 'allow' | 'deny' | ReviewFailureKind;
  elapsedMs: number;
  attempts: number;
  /** 失败原因（中文，直接展示给用户 / 写日志） */
  note?: string;
}

interface PromptOutcome {
  kind: 'ok' | ReviewFailureKind;
  error?: string;
}

const FAILURE_NOTES: Record<ReviewFailureKind, string> = {
  timeout: '评审员未在超时内完成',
  aborted: '评审已取消',
  error: '评审员调用失败'
};

/** 给 prompt 套上超时与取消；超时/取消时会 abort 那个会话 */
async function promptWithDeadline(
  session: ReviewerSessionLike,
  text: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PromptOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  const timeout = new Promise<PromptOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const aborted = new Promise<PromptOutcome>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const done = session.prompt(text).then(
    (): PromptOutcome => ({ kind: 'ok' }),
    (error: unknown): PromptOutcome => ({
      kind: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  );

  const result = await Promise.race([done, timeout, aborted]);
  if (timer) clearTimeout(timer);
  if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  if (result.kind === 'timeout' || result.kind === 'aborted') {
    try {
      await session.abort();
    } catch {}
  }
  return result;
}

/** 执行一次评审（串行：同一槽不会有两个评审员并存） */
export async function runReview(input: RunReviewInput): Promise<ReviewRunResult> {
  const startedAt = Date.now();
  const fail = (kind: ReviewFailureKind, attempts: number, note?: string): ReviewRunResult => ({
    verdict: null,
    kind,
    elapsedMs: Date.now() - startedAt,
    attempts,
    note: note ?? FAILURE_NOTES[kind]
  });

  if (input.signal?.aborted) return fail('aborted', 0);

  return input.runExclusive(async () => {
    const deadline = startedAt + input.timeoutMs;
    let attempts = 0;

    for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt += 1) {
      if (input.signal?.aborted) return fail('aborted', attempts);

      let session: ReviewerSessionLike;
      try {
        session = await input.acquire();
      } catch (error) {
        return fail('error', attempts, `评审员会话创建失败：${describeError(error)}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await input.drop();
        return fail('timeout', attempts + 1);
      }

      attempts += 1;
      const text =
        attempt === 0
          ? input.userMessage
          : `${input.userMessage}\n\n（上一次输出不是合法 JSON。这次只输出一个 JSON 对象，不要任何其它文字或代码块。）`;
      const outcome = await promptWithDeadline(session, text, remaining, input.signal);
      if (outcome.kind !== 'ok') {
        // 超时/取消/异常后会话停在半途：丢弃重建，下次干净开始
        await input.drop();
        return fail(outcome.kind, attempts, outcome.error);
      }
      if (session.waitForIdle) {
        // 流式尾巴收干净再读最后一条 assistant 文本（否则可能读到半截 JSON）
        await session.waitForIdle().catch(() => {});
      }

      let lastText: string | undefined;
      try {
        lastText = session.getLastAssistantText();
      } catch (error) {
        await input.drop();
        return fail('error', attempts, `读取评审结果失败：${describeError(error)}`);
      }

      const verdict = parseReviewerVerdict(lastText ?? '');
      if (verdict) {
        return {
          verdict,
          kind: verdict.outcome,
          elapsedMs: Date.now() - startedAt,
          attempts
        };
      }
      // 解析失败：同一会话再问一次（上下文是干净的，重试比新建会话更省）
    }

    // 连续解析失败：会话可能已脏（模型陷在某种输出惯性里），丢弃
    await input.drop();
    return fail('error', attempts, '评审员输出不是合法 JSON');
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
