/**
 * 钩子扩展的 `before_agent_start` 载荷（SDK 1.2.0 起该事件是 `user | custom` 联合类型）：
 * - user run：`prompt` 用 `event.prompt`，`messageType` 透传 "user"
 * - custom run（`pi.sendMessage(..., { triggerTurn: true })`）：事件里没有 `prompt`，
 *   用起始自定义消息的文本兜底，`messageType` 为 "custom"
 *
 * 回归背景：旧实现直接 `event.prompt`，custom run 上会让钩子脚本收到 "undefined"
 * （`truncate(undefined)` 会把 undefined 当字符串），且 1.4.0 的类型检查直接报 TS2339。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const { runHooksForEventMock } = vi.hoisted(() => ({
  runHooksForEventMock: vi.fn(async () => ({}))
}));

vi.mock('../../electron/hooks/runner', () => ({ runHooksForEvent: runHooksForEventMock }));

import { hookExtensionFactory } from '../../electron/hooks/extension';

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function setup(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const api = {
    on: (name: string, cb: Handler) => {
      handlers[name] = cb;
    }
  };
  hookExtensionFactory().factory(api as unknown as ExtensionAPI);
  return handlers;
}

const ctx = { cwd: '/tmp/project' };

describe('hooks before_agent_start 载荷', () => {
  beforeEach(() => {
    runHooksForEventMock.mockClear();
  });

  it('user run：prompt 取自 event.prompt', async () => {
    const handlers = setup();
    await handlers.before_agent_start(
      {
        type: 'before_agent_start',
        messageType: 'user',
        prompt: '帮我看下这个报错',
        systemPrompt: 'SYS'
      },
      ctx
    );

    expect(runHooksForEventMock).toHaveBeenCalledTimes(1);
    const [event, payload, cwd] = runHooksForEventMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string
    ];
    expect(event).toBe('before_agent_start');
    expect(cwd).toBe('/tmp/project');
    expect(payload).toMatchObject({
      hookEvent: 'before_agent_start',
      messageType: 'user',
      cwd: '/tmp/project',
      prompt: '帮我看下这个报错',
      systemPrompt: 'SYS'
    });
  });

  it('custom run：没有 prompt，用自定义消息文本兜底（字符串 content）', async () => {
    const handlers = setup();
    await handlers.before_agent_start(
      {
        type: 'before_agent_start',
        messageType: 'custom',
        message: { customType: 'background-task', content: '后台任务 bg_1 已完成', display: false },
        systemPrompt: 'SYS'
      },
      ctx
    );

    const [, payload] = runHooksForEventMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>
    ];
    expect(payload.messageType).toBe('custom');
    expect(payload.prompt).toBe('后台任务 bg_1 已完成');
  });

  it('custom run：content 是内容数组时取文本片段', async () => {
    const handlers = setup();
    await handlers.before_agent_start(
      {
        type: 'before_agent_start',
        messageType: 'custom',
        message: {
          customType: 'background-task',
          content: [{ type: 'text', text: '数组形式的消息文本' }],
          display: false
        },
        systemPrompt: 'SYS'
      },
      ctx
    );

    const [, payload] = runHooksForEventMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>
    ];
    expect(payload.prompt).toBe('数组形式的消息文本');
  });
});
