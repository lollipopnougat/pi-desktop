/**
 * SubagentExecutor 工具调用流水记录 + controller snapshot 瘦身测试。
 *
 * executor.spawn 依赖 createAgentSessionServices(重依赖),这里只测纯逻辑:
 * - handleChildEvent 的 toolCalls 记录(通过构造事件序列直调私有方法)
 * - slimRun 截断(getSnapshot 经 controller)
 */
import { describe, it, expect, vi } from 'vitest';
import { SubagentController } from '../../electron/subagents/controller';
import { SubagentExecutor } from '../../electron/subagents/executor';
import type { ChildRun, ChildToolCall, ChildTranscriptItem } from '../../electron/subagents/types';

// ─── handleChildEvent 工具调用流水 ───

// 通过 executor 实例直接调 handleChildEvent(绕过 spawn 重依赖)
// executor 构造需要 piBridge/controller,全 mock
function createExecutorHandle() {
  const bridge = {
    win: null,
    cwd: '/p',
    agentDir: '/a',
    modelRuntime: {},
    getSession: () => ({}),
    sessionHost: () => ({
      current: () => ({}),
      cwd: () => '/p',
      sendSessionEvent: () => true
    })
  } as any;
  const controller = new SubagentController(bridge, bridge.sessionHost());
  const executor: any = new SubagentExecutor(bridge, controller, bridge.sessionHost());
  const raw = executor.handleChildEvent.bind(executor);
  // 本文件关注工具流水;对话流参数给默认值,调用点保持精简
  return (
    run: ChildRun,
    event: unknown,
    progress: NonNullable<ChildRun['progress']>,
    startedMs: number,
    opts: unknown,
    toolCalls: ChildToolCall[],
    transcript: ChildTranscriptItem[] = []
  ) => raw(run, event, progress, startedMs, opts, toolCalls, transcript);
}

function makeRun(): ChildRun {
  return {
    id: 'sa-x',
    name: 'x',
    agent: 'scout',
    task: 'x',
    status: 'running',
    async: false,
    depth: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
    progress: { recentTools: [], turns: 0, tokens: 0, durationMs: 0 },
    toolCalls: []
  };
}

describe('executor 工具调用流水记录', () => {
  it('start 入队 pending,end 回填结果/耗时', () => {
    const handle = createExecutorHandle();
    const run = makeRun();
    const progress = run.progress!;
    const toolCalls: ChildToolCall[] = [];
    const opts = { onProgress: vi.fn(), onFinish: vi.fn() };
    const t0 = Date.now();

    handle(
      run,
      {
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'grep',
        args: { pattern: 'ipc' }
      },
      progress,
      t0,
      opts,
      toolCalls
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'tc1', toolName: 'grep', pending: true });

    const result = { content: [{ type: 'text', text: '3 matches' }] };
    handle(
      run,
      { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'grep', result, isError: false },
      progress,
      t0,
      opts,
      toolCalls
    );
    expect(toolCalls[0]).toMatchObject({ pending: false, isError: false, result });
    expect(toolCalls[0].endedAt).toBeGreaterThanOrEqual(toolCalls[0].startedAt);
    // 进度聚合同步
    expect(progress.recentTools).toHaveLength(1);
    expect(opts.onProgress).toHaveBeenCalled();
  });

  it('end 未匹配 start 时兜底补一条完成记录', () => {
    const handle = createExecutorHandle();
    const run = makeRun();
    const toolCalls: ChildToolCall[] = [];
    handle(
      run,
      {
        type: 'tool_execution_end',
        toolCallId: 'orphan',
        toolName: 'read',
        result: 'x',
        isError: true
      },
      run.progress!,
      Date.now(),
      { onProgress: vi.fn() },
      toolCalls
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'orphan', isError: true, pending: false });
  });

  it('assistant 轮次计数', () => {
    const handle = createExecutorHandle();
    const run = makeRun();
    const toolCalls: ChildToolCall[] = [];
    handle(
      run,
      { type: 'message_end', message: { role: 'assistant' } },
      run.progress!,
      Date.now(),
      { onProgress: vi.fn() },
      toolCalls
    );
    handle(
      run,
      { type: 'message_end', message: { role: 'user' } },
      run.progress!,
      Date.now(),
      { onProgress: vi.fn() },
      toolCalls
    );
    expect(run.progress!.turns).toBe(1);
  });

  it('对话流随事件同步采集(与工具流水同一条事件流)', () => {
    const handle = createExecutorHandle();
    const run = makeRun();
    const toolCalls: ChildToolCall[] = [];
    const transcript: ChildTranscriptItem[] = [];
    const opts = { onProgress: vi.fn() };

    handle(
      run,
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      run.progress!,
      Date.now(),
      opts,
      toolCalls,
      transcript
    );
    handle(
      run,
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '先读取文件' },
            { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }
          ]
        }
      },
      run.progress!,
      Date.now(),
      opts,
      toolCalls,
      transcript
    );
    expect(transcript.map((i) => i.kind)).toEqual(['text', 'tool']);
    // 采集到内容 → 触发快照推送
    expect(opts.onProgress).toHaveBeenCalled();
  });
});

// ─── controller snapshot 瘦身 ───

describe('controller 快照瘦身(slimRun)', () => {
  function makeControllerWithRun(runOverrides: Partial<ChildRun>) {
    const bridge = {
      win: null,
      cwd: '/p',
      agentDir: '/a',
      modelRuntime: {},
      getSession: () => ({}),
      sessionHost: () => ({
        current: () => ({}),
        cwd: () => '/p',
        sendSessionEvent: () => true
      })
    } as any;
    const controller = new SubagentController(bridge, bridge.sessionHost());
    (controller as any).definitions = { agents: [], diagnostics: [] };
    (controller as any).loadedForCwd = '/p';
    (controller as any).runs.push({ ...makeRun(), ...runOverrides });
    return controller;
  }

  it('超大 args/result 被截断并标记', () => {
    const big = 'x'.repeat(5000);
    const controller = makeControllerWithRun({
      toolCalls: [
        {
          toolCallId: 'tc1',
          toolName: 'read',
          args: { path: big },
          result: { content: big },
          startedAt: Date.now(),
          endedAt: Date.now()
        }
      ]
    });
    const snap = controller.getSnapshot();
    const tc = snap.runs[0].toolCalls![0];
    expect(String(tc.args)).toContain('已截断');
    expect(String(tc.result)).toContain('已截断');
    // 原始 run 不被修改(瘦身只作用于快照副本)
    expect((controller.getRun('sa-x')!.toolCalls![0].args as any).path).toHaveLength(5000);
  });

  it('小值原样保留(不截断)', () => {
    const controller = makeControllerWithRun({
      toolCalls: [
        {
          toolCallId: 'tc1',
          toolName: 'grep',
          args: { pattern: 'ipc' },
          result: 'ok',
          startedAt: Date.now(),
          endedAt: Date.now()
        }
      ]
    });
    const snap = controller.getSnapshot();
    expect(snap.runs[0].toolCalls![0].args).toEqual({ pattern: 'ipc' });
    expect(snap.runs[0].toolCalls![0].result).toBe('ok');
  });

  it('对话流超长文本在快照中截断,原始 run 不受影响', () => {
    const big = 'y'.repeat(5000);
    const controller = makeControllerWithRun({
      transcript: [
        { kind: 'text', at: 1, text: big },
        { kind: 'thinking', at: 2, text: '短思考' },
        { kind: 'tool', at: 3, toolCallId: 'tc1' },
        { kind: 'stream', at: 4, text: big, thinking: big, toolCallIds: ['tc1'] }
      ]
    });
    const snap = controller.getSnapshot();
    const items = snap.runs[0].transcript!;
    expect(items[0].kind === 'text' && items[0].text).toContain('已截断');
    expect(items[1]).toMatchObject({ kind: 'thinking', text: '短思考' });
    expect(items[2]).toMatchObject({ kind: 'tool', toolCallId: 'tc1' });
    expect(items[3].kind === 'stream' && items[3].text).toContain('已截断');
    expect(items[3].kind === 'stream' && items[3].thinking).toContain('已截断');
    // 原始 run 保持完整(瘦身只作用于快照副本)
    const original = controller.getRun('sa-x')!.transcript![0];
    expect(original.kind === 'text' && original.text).toHaveLength(5000);
  });
});
