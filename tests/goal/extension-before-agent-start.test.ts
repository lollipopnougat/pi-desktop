/**
 * `before_agent_start` 联合事件处理（SDK 1.2.0 起是 `user | custom`）：
 * - user run + 自己的续跑 marker → automatic + claimContinuation
 * - user run + 普通输入 → manual
 * - custom run（`pi.sendMessage(..., { triggerTurn: true })`，事件里没有 prompt）→ manual，
 *   且仍然注入 goal 系统提示（不能因为读不到 prompt 就整个跳过）
 *
 * 回归背景：SDK 1.4.0 把该事件改成联合类型后，直接读 `event.prompt` 会在 custom run 上
 * 拿到 undefined（旧代码 `isOwnContinuation(undefined)` 只是恰好没崩，类型检查也过不了）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { goalExtensionFactory } from '../../electron/goal/extension';
import type { GoalController } from '../../electron/goal/controller';
import type { ActiveGoal } from '../../electron/goal/persistence';

const CONTINUATION_MARKER = '<!-- goal-continuation: g1:turn3 -->';
const CONTINUATION_PROMPT = `继续目标 ${CONTINUATION_MARKER}`;

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeGoal(): ActiveGoal {
  return {
    id: 'g1',
    text: '把登录页的按钮挪到状态栏',
    status: 'active',
    startedAt: 0,
    updatedAt: 0,
    iteration: 2,
    tokensUsed: 1200,
    timeUsedSeconds: 30,
    baselineTokens: 0,
    automaticModelTurns: 2,
    toolFreeRepeatCount: 0
  } as ActiveGoal;
}

function setup() {
  const rt = {
    goal: makeGoal(),
    isOwnContinuation: vi.fn((text: string) =>
      /<!-- goal-continuation: [\w:-]+ -->/.test(text)
    ),
    claimContinuation: vi.fn(() => true),
    beginAgentRun: vi.fn(),
    requestContinuation: vi.fn(() => CONTINUATION_MARKER),
    dispatchContinuation: vi.fn(() => null),
    shouldBlockToolCall: vi.fn(() => false)
  };
  const controller = { rt } as unknown as GoalController;
  const api = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn()
  };
  goalExtensionFactory(controller).factory(api as unknown as ExtensionAPI);
  const handler = api.on.mock.calls.find((c) => c[0] === 'before_agent_start')?.[1] as Handler;
  return { handler, rt };
}

function userEvent(prompt: string) {
  return {
    type: 'before_agent_start',
    messageType: 'user',
    prompt,
    systemPrompt: 'BASE_SYSTEM_PROMPT',
    systemPromptOptions: {}
  };
}

function customEvent(content: string) {
  return {
    type: 'before_agent_start',
    messageType: 'custom',
    message: { customType: 'background-task', content, display: false },
    systemPrompt: 'BASE_SYSTEM_PROMPT',
    systemPromptOptions: {}
  };
}

describe('goal before_agent_start 联合事件', () => {
  it('user run + 自己的续跑 marker：按 automatic 记账并认领票据', () => {
    const { handler, rt } = setup();
    const result = handler(userEvent(CONTINUATION_PROMPT), {}) as { systemPrompt: string };

    expect(rt.isOwnContinuation).toHaveBeenCalledWith(CONTINUATION_PROMPT);
    expect(rt.beginAgentRun).toHaveBeenCalledWith('automatic');
    expect(rt.claimContinuation).toHaveBeenCalledWith(CONTINUATION_PROMPT);
    expect(result.systemPrompt).toContain('BASE_SYSTEM_PROMPT');
    expect(result.systemPrompt).toContain('<goal_mode_active>');
  });

  it('user run + 普通输入：按 manual 记账', () => {
    const { handler, rt } = setup();
    handler(userEvent('顺便把那个按钮颜色改一下'), {});

    expect(rt.beginAgentRun).toHaveBeenCalledWith('manual');
    expect(rt.claimContinuation).not.toHaveBeenCalled();
  });

  it('custom run（无 prompt）：按 manual 记账，且仍注入 goal 系统提示', () => {
    const { handler, rt } = setup();
    const result = handler(customEvent('后台任务已完成'), {}) as { systemPrompt: string };

    expect(rt.isOwnContinuation).not.toHaveBeenCalled();
    expect(rt.beginAgentRun).toHaveBeenCalledWith('manual');
    expect(rt.claimContinuation).not.toHaveBeenCalled();
    expect(result.systemPrompt).toContain('BASE_SYSTEM_PROMPT');
    expect(result.systemPrompt).toContain('<goal_mode_active>');
  });

  it('没有活跃 goal 时不记账、不注入', () => {
    const { handler, rt } = setup();
    (rt as { goal: ActiveGoal | null }).goal = null;
    const result = handler(userEvent('随便说点什么'), {});
    expect(result).toBeUndefined();
    expect(rt.beginAgentRun).not.toHaveBeenCalled();
  });
});
