import { describe, expect, it } from 'vitest';
import {
  askTool,
  hasPendingAsk,
  pendingAskQuestions,
  resolveAsk,
  setAskNotifier
} from '../../electron/tools/ask-tool';

function params(question: string) {
  return { questions: [{ id: 'q1', question, options: [{ label: 'A' }, { label: 'B' }] }] };
}
/** 工具 execute 的 ctx：只要 sessionManager.getSessionId 即可解析会话键 */
function ctxFor(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId } } as never;
}
/** execute(toolCallId, params, signal, onUpdate, ctx) */
function run(question: string, sessionId: string, signal?: AbortSignal) {
  return askTool.execute(
    'call',
    params(question) as never,
    signal as never,
    undefined as never,
    ctxFor(sessionId)
  );
}

describe('ask 工具：多会话按会话分键', () => {
  it('两个会话同时提问互不覆盖，答案各回各的会话', async () => {
    const notified: Array<{ key: string; question: string }> = [];
    setAskNotifier((key, questions) => notified.push({ key, question: questions[0].question }));
    try {
      const askA = run('A 的问题', 'session-A');
      const askB = run('B 的问题', 'session-B');
      await Promise.resolve();
      await Promise.resolve();

      expect(notified.map((n) => n.key)).toEqual(['session-A', 'session-B']);
      expect(hasPendingAsk('session-A')).toBe(true);
      expect(hasPendingAsk('session-B')).toBe(true);

      // 先回答 A：只结算 A，B 继续挂起等自己的答案
      expect(resolveAsk('session-A', [{ questionId: 'q1', selectedLabels: ['A'] }])).toBe(true);
      const resultA = await askA;
      expect(resultA.details.cancelled).toBe(false);
      expect(hasPendingAsk('session-A')).toBe(false);
      expect(hasPendingAsk('session-B')).toBe(true);
      expect(pendingAskQuestions('session-B')?.[0].question).toBe('B 的问题');

      expect(resolveAsk('session-B', null)).toBe(true);
      expect((await askB).details.cancelled).toBe(true);
      // 每个会话只能结算自己的挂起提问
      expect(resolveAsk('session-A', null)).toBe(false);
    } finally {
      setAskNotifier(null);
    }
  });

  it('本轮被 abort（停止/替换会话）时按取消结算，工具不挂死', async () => {
    setAskNotifier(() => {});
    try {
      const controller = new AbortController();
      const pending = run('会被中断', 'session-C', controller.signal);
      await Promise.resolve();
      expect(hasPendingAsk('session-C')).toBe(true);

      controller.abort();

      expect((await pending).details.cancelled).toBe(true);
      expect(hasPendingAsk('session-C')).toBe(false);
    } finally {
      setAskNotifier(null);
    }
  });

  it('没有通知器（窗口已销毁）时立即按取消结算', async () => {
    setAskNotifier(null);
    const result = await run('没人看的问题', 'session-D');
    expect(result.details.cancelled).toBe(true);
    expect(hasPendingAsk('session-D')).toBe(false);
  });
});
