/**
 * 记忆扩展的钩子接线测试：确认 turn_end / before_agent_start / session_before_compact
 * 真的挂上了、并且按阈值与开关触发自动沉淀（不依赖真实 SDK 运行）。
 *
 * 用假 pi 收集 `on()` 注册的 handler，再手动派发事件。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { memoryExtensionFactory } from '../../electron/memory/extension';
import { resetAllNudgeCounters } from '../../electron/memory/nudge';
import type { MemoryConfig } from '../../electron/memory/config';

type Handler = (event: unknown, ctx: unknown) => unknown;

const config = {
  enabled: true,
  autoExtract: true,
  nudgeTurns: 12,
  nudgeToolCalls: 20,
  correctionDetect: true,
  preCompactFlush: true
} as unknown as MemoryConfig;

function setup(overrides: Partial<MemoryConfig> = {}) {
  const handlers = new Map<string, Handler[]>();
  const sediments: string[] = [];
  const cfg = { ...config, ...overrides };
  const controller = {
    isEnabled: () => cfg.enabled,
    getConfig: () => cfg,
    getInjection: () => null,
    autoSediment: async (reason: string) => {
      sediments.push(reason);
    },
    freezeSnapshot: () => {},
    clearSnapshot: () => {},
    getProjectId: () => 'p-test'
  };
  const pi = {
    registerTool: () => {},
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
  };
  const factory = memoryExtensionFactory(controller as never).factory;
  factory(pi as never);
  const ctx = { sessionManager: { getSessionId: () => 'session-1' } };
  const emit = async (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const turn = (toolResults = 0) =>
    emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: {},
      toolResults: Array(toolResults)
    });
  const prompt = (text: string, messageType = 'user') =>
    emit('before_agent_start', {
      type: 'before_agent_start',
      systemPrompt: 'base',
      messageType,
      prompt: text
    });
  return { handlers, sediments, cfg, emit, turn, prompt, controller };
}

beforeEach(() => {
  resetAllNudgeCounters();
});

describe('记忆扩展钩子', () => {
  it('注册了四个钩子', () => {
    const { handlers } = setup();
    for (const name of [
      'session_start',
      'before_agent_start',
      'turn_end',
      'session_before_compact',
      'session_shutdown'
    ]) {
      expect(handlers.has(name), name).toBe(true);
    }
  });

  it('满 12 轮触发一次自动沉淀', async () => {
    const { sediments, turn } = setup();
    for (let i = 0; i < 11; i += 1) await turn();
    expect(sediments).toEqual([]);
    await turn();
    expect(sediments).toEqual(['nudge']);
  });

  it('工具调用数达阈值触发（不等到轮次）', async () => {
    const { sediments, turn } = setup();
    await turn(20);
    expect(sediments).toEqual(['nudge']);
  });

  it('自动沉淀开关关闭时不触发', async () => {
    const { sediments, turn } = setup({ autoExtract: false });
    for (let i = 0; i < 20; i += 1) await turn(5);
    expect(sediments).toEqual([]);
  });

  it('用户纠正触发 correction 沉淀（需要先有 3 轮）', async () => {
    const { sediments, turn, prompt } = setup();
    await prompt('不对，应该用 pnpm');
    expect(sediments).toEqual([]);
    for (let i = 0; i < 3; i += 1) await turn();
    await prompt('不对，应该用 pnpm');
    expect(sediments).toEqual(['correction']);
  });

  it('custom run 没有 prompt，不误判为纠正', async () => {
    const { sediments, turn, prompt } = setup();
    for (let i = 0; i < 3; i += 1) await turn();
    await prompt('不对，应该用 pnpm', 'custom');
    expect(sediments).toEqual([]);
  });

  it('压缩前 flush 触发 compact 沉淀', async () => {
    const { sediments, emit } = setup();
    await emit('session_before_compact', { type: 'session_before_compact', reason: 'threshold' });
    expect(sediments).toEqual(['compact']);
  });

  it('压缩前 flush 关闭时不触发', async () => {
    const { sediments, emit } = setup({ preCompactFlush: false });
    await emit('session_before_compact', { type: 'session_before_compact', reason: 'manual' });
    expect(sediments).toEqual([]);
  });

  it('session_start 重置计数器（新会话重新累计 12 轮）', async () => {
    const { sediments, turn, emit } = setup();
    for (let i = 0; i < 10; i += 1) await turn();
    await emit('session_start', { type: 'session_start' });
    for (let i = 0; i < 10; i += 1) await turn();
    expect(sediments).toEqual([]);
  });
});
