/**
 * 决策模型自动审批（classifier-auto 策略）单测。
 *
 * 分两层：
 * - 纯函数层：配置归一化 / state 打包 / 答案解析（阈值裁决、失败回退）
 * - 控制器层：模型前置判定、不被静态规则或会话授权短路、模型失败回退人工审批
 *
 * 用最小 fake PiBridge + fake ModelRuntime 驱动，不触碰真实网络与 SDK。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

// 决策模型调用会写日志（~/.pi-desktop/logs）：测试里重定向到临时目录，别污染用户真实日志
const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  return {
    tmpDir: join(
      tmpdir(),
      `pi-desktop-classifier-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
  };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import {
  APPROVAL_QUESTION_ID,
  MAX_ARGS_CHARS,
  buildApprovalState,
  classifyToolCall,
  readVerdict,
  stringifyToolArgs,
  truncate
} from '../../electron/permission/classifier-gate';
import {
  CLASSIFIER_TIMEOUT_MAX_MS,
  CLASSIFIER_TIMEOUT_MIN_MS,
  DEFAULT_CLASSIFIER_MIN_CONFIDENCE,
  normalizeClassifierApprovalConfig
} from '../../electron/permission/policy';
import { PermissionController } from '../../electron/permission/controller';
import { DEFAULT_LOG_CONFIG, resetLogStateForTest, setLogConfig } from '../../electron/logs/logger';

/**
 * 日志默认**不启用**（DEFAULT_LOG_CONFIG.enabled === false）。
 * 下面的用例要断言「决策模型调用的重试 / 请求 / 响应写进了日志」，所以每次先手动打开。
 */
beforeEach(() => {
  resetLogStateForTest();
  setLogConfig({
    ...DEFAULT_LOG_CONFIG,
    enabled: true,
    channels: { ...DEFAULT_LOG_CONFIG.channels }
  });
});

// ===================== 纯函数层 =====================

describe('normalizeClassifierApprovalConfig', () => {
  it('非对象输入返回空配置', () => {
    expect(normalizeClassifierApprovalConfig(null)).toEqual({});
    expect(normalizeClassifierApprovalConfig(undefined)).toEqual({});
    expect(normalizeClassifierApprovalConfig('x')).toEqual({});
    expect(normalizeClassifierApprovalConfig([])).toEqual({});
  });

  it('providerId / modelId 必须成对，且 trim 后非空', () => {
    expect(normalizeClassifierApprovalConfig({ providerId: ' p ', modelId: ' m ' })).toEqual({
      providerId: 'p',
      modelId: 'm'
    });
    // 只有一半 → 整对丢弃（半配置只会让闸门白等一次超时）
    expect(normalizeClassifierApprovalConfig({ providerId: 'p' })).toEqual({});
    expect(normalizeClassifierApprovalConfig({ modelId: 'm' })).toEqual({});
    expect(normalizeClassifierApprovalConfig({ providerId: '  ', modelId: 'm' })).toEqual({});
    expect(normalizeClassifierApprovalConfig({ providerId: 1, modelId: 2 })).toEqual({});
  });

  it('timeoutMs 被 clamp 到合法区间并取整', () => {
    expect(normalizeClassifierApprovalConfig({ timeoutMs: 10 }).timeoutMs).toBe(
      CLASSIFIER_TIMEOUT_MIN_MS
    );
    expect(normalizeClassifierApprovalConfig({ timeoutMs: 999999 }).timeoutMs).toBe(
      CLASSIFIER_TIMEOUT_MAX_MS
    );
    expect(normalizeClassifierApprovalConfig({ timeoutMs: 1234.7 }).timeoutMs).toBe(1235);
    expect(normalizeClassifierApprovalConfig({ timeoutMs: '3000' }).timeoutMs).toBeUndefined();
    expect(normalizeClassifierApprovalConfig({ timeoutMs: NaN }).timeoutMs).toBeUndefined();
  });

  it('minConfidence 被 clamp 到 0~1', () => {
    expect(normalizeClassifierApprovalConfig({ minConfidence: -1 }).minConfidence).toBe(0);
    expect(normalizeClassifierApprovalConfig({ minConfidence: 2 }).minConfidence).toBe(1);
    expect(normalizeClassifierApprovalConfig({ minConfidence: 0.85 }).minConfidence).toBe(0.85);
    expect(
      normalizeClassifierApprovalConfig({ minConfidence: '0.9' }).minConfidence
    ).toBeUndefined();
  });

  it('未提供可选项时保持缺省（由调用方填默认值）', () => {
    expect(normalizeClassifierApprovalConfig({ providerId: 'p', modelId: 'm' })).toEqual({
      providerId: 'p',
      modelId: 'm'
    });
  });

  it('allowWriteInCwd 只接受布尔值（缺省 = 关闭）', () => {
    expect(normalizeClassifierApprovalConfig({ allowWriteInCwd: true })).toEqual({
      allowWriteInCwd: true
    });
    expect(normalizeClassifierApprovalConfig({ allowWriteInCwd: false })).toEqual({
      allowWriteInCwd: false
    });
    expect(normalizeClassifierApprovalConfig({ allowWriteInCwd: 'true' })).toEqual({});
    expect(normalizeClassifierApprovalConfig({ allowWriteInCwd: 1 })).toEqual({});
  });
});

describe('buildApprovalState', () => {
  it('包含工具名、工具描述、参数与防注入声明', () => {
    const state = buildApprovalState({
      toolName: 'bash',
      toolDescription: '运行 shell 命令',
      args: { command: 'npm test' },
      cwd: '/tmp/proj'
    });
    expect(state.tool).toBe('bash');
    expect(state.tool_description).toBe('运行 shell 命令');
    expect(state.working_directory).toBe('/tmp/proj');
    expect(String(state.note)).toContain('待判断数据');
    // bash 类工具额外单列 command
    expect(state.command).toBe('npm test');
  });

  it('缺少工具描述时写入占位文本（不省略字段，模型需要知道"没有描述"）', () => {
    const state = buildApprovalState({ toolName: 'mcp', args: {} });
    expect(state.tool_description).toBe('（SDK 未提供该工具的描述）');
    expect(state.arguments).toBe('{}');
    expect(state.working_directory).toBeUndefined();
    expect(state.command).toBeUndefined();
  });

  it('参数为非对象/无法序列化时退回字符串且不抛错', () => {
    expect(buildApprovalState({ toolName: 'x', args: 'ls -la' }).arguments).toBe('ls -la');
    expect(buildApprovalState({ toolName: 'x', args: undefined }).arguments).toBe('（无参数）');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyToolArgs(cyclic)).not.toThrow();
    expect(buildApprovalState({ toolName: 'x', args: cyclic }).arguments).toBe(String(cyclic));
  });

  it('超长参数与描述按上限截断', () => {
    const long = 'a'.repeat(MAX_ARGS_CHARS + 500);
    const state = buildApprovalState({
      toolName: 'bash',
      toolDescription: long,
      args: { command: long }
    });
    expect(String(state.arguments).length).toBeLessThan(MAX_ARGS_CHARS + 100);
    expect(String(state.command).length).toBeLessThan(MAX_ARGS_CHARS + 100);
    expect(String(state.arguments)).toContain('已截断');
    expect(state.arguments_truncated).toBe(true);
    expect(truncate('short', 10)).toBe('short');
  });
});

describe('readVerdict', () => {
  const MIN = DEFAULT_CLASSIFIER_MIN_CONFIDENCE;
  const stop = (choice: string, confidence: number, probabilities?: Record<string, unknown>) => ({
    stopReason: 'stop',
    answers: {
      [APPROVAL_QUESTION_ID]: { type: 'choice', choice, confidence, probabilities }
    }
  });

  it('safe 且置信度达标 → 自动放行', () => {
    const v = readVerdict(stop('safe', 0.91), MIN);
    expect(v.ok).toBe(true);
    expect(v.level).toBe('safe');
    expect(v.confidence).toBe(0.91);
    expect(v.autoAllowed).toBe(true);
    expect(v.note).toBeUndefined();
  });

  it('safe 但置信度低于阈值 → 不自动放行并说明原因', () => {
    const v = readVerdict(stop('safe', 0.4), MIN);
    expect(v.ok).toBe(true);
    expect(v.autoAllowed).toBe(false);
    expect(v.note).toContain('0.40');
    expect(v.note).toContain(String(MIN));
  });

  it('risky / dangerous → 不自动放行（不编造 note，等级本身由 UI 展示）', () => {
    for (const level of ['risky', 'dangerous']) {
      const v = readVerdict(stop(level, 0.99), MIN);
      expect(v.ok).toBe(true);
      expect(v.level).toBe(level);
      expect(v.autoAllowed).toBe(false);
      expect(v.note).toBeUndefined();
    }
  });

  it.each([undefined, null, '0.95', NaN, Infinity, -0.1, 1.1])(
    '无效置信度 %s 即使阈值为 0 也不能自动放行',
    (confidence) => {
      const v = readVerdict(
        {
          stopReason: 'stop',
          answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence } }
        },
        0
      );
      expect(v.ok).toBe(false);
      expect(v.autoAllowed).toBe(false);
      expect(v.note).toContain('置信度');
    }
  );

  it('stopReason 非 stop → ok=false 并带上原始错误', () => {
    const v = readVerdict({ stopReason: 'error', errorMessage: 'boom', answers: {} }, MIN);
    expect(v.ok).toBe(false);
    expect(v.note).toBe('boom');
    const aborted = readVerdict({ stopReason: 'aborted', answers: {} }, MIN);
    expect(aborted.ok).toBe(false);
    expect(aborted.note).toContain('aborted');
  });

  it('答案缺失 / 非 choice / 未知等级 → ok=false（绝不猜等级）', () => {
    expect(readVerdict({ stopReason: 'stop', answers: {} }, MIN).ok).toBe(false);
    expect(
      readVerdict(
        { stopReason: 'stop', answers: { [APPROVAL_QUESTION_ID]: { type: 'score', score: 3 } } },
        MIN
      ).ok
    ).toBe(false);
    const unknown = readVerdict(stop('maybe', 0.9), MIN);
    expect(unknown.ok).toBe(false);
    expect(unknown.level).toBeUndefined();
    expect(unknown.note).toContain('maybe');
    expect(readVerdict(null, MIN).ok).toBe(false);
  });

  it('probabilities 只保留数值项', () => {
    const v = readVerdict(stop('safe', 0.9, { safe: 0.9, risky: 0.1, junk: 'x' }), MIN);
    expect(v.probabilities).toEqual({ safe: 0.9, risky: 0.1 });
  });

  it('等级大小写与空白被归一化', () => {
    const v = readVerdict(stop('  SAFE ', 0.99), MIN);
    expect(v.ok).toBe(true);
    expect(v.level).toBe('safe');
    expect(v.autoAllowed).toBe(true);
  });
});

describe('classifyToolCall', () => {
  const config = { providerId: 'local-kev', modelId: 'm' };

  it('未配置模型 → 失败（不回退到猜）', async () => {
    const v = await classifyToolCall({ runtime: {}, config: {}, state: {} });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('未选择决策模型');
  });

  it('runtime 缺少 classify / getModelOfType → 失败', async () => {
    const v = await classifyToolCall({ runtime: {}, config, state: {} });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('运行时不可用');
  });

  it('模型不存在 → 失败并提示可能未配置凭据', async () => {
    const runtime = { getModelOfType: () => undefined, classify: vi.fn() };
    const v = await classifyToolCall({ runtime, config, state: {} });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('未找到决策模型');
    expect(runtime.classify).not.toHaveBeenCalled();
  });

  it('getModelOfType 抛错 → 失败（不冒泡）', async () => {
    const runtime = {
      getModelOfType: () => {
        throw new Error('provider not registered');
      },
      classify: vi.fn()
    };
    const v = await classifyToolCall({ runtime, config, state: {} });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('provider not registered');
  });

  it('成功路径：把 danger 问题与 state 传给模型，并把答案翻译成判定', async () => {
    const runtime = {
      getModelOfType: (_t: string, p: string, m: string) => ({ provider: p, id: m }),
      classify: async (_model: unknown, context: any, options: any) => {
        expect(context.questions[APPROVAL_QUESTION_ID].type).toBe('choice');
        expect(Object.keys(context.questions[APPROVAL_QUESTION_ID].criteria)).toEqual([
          'safe',
          'risky',
          'dangerous'
        ]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return {
          stopReason: 'stop',
          answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.95 } }
        };
      }
    };
    const v = await classifyToolCall({ runtime, config, state: { tool: 'bash' } });
    expect(v.ok).toBe(true);
    expect(v.autoAllowed).toBe(true);
  });

  it('classify 抛错 → 失败并带上错误信息', async () => {
    const runtime = {
      getModelOfType: () => ({}),
      classify: async () => {
        throw new Error('Provider x does not support classification');
      }
    };
    const v = await classifyToolCall({ runtime, config, state: {} });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('does not support classification');
  });

  it('超时 → 失败并标记超时（不等待到天荒地老）', async () => {
    const runtime = {
      getModelOfType: () => ({}),
      classify: (_m: unknown, _c: unknown, options: any) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () =>
            resolve({ stopReason: 'aborted', answers: {} })
          );
        })
    };
    const v = await classifyToolCall({
      runtime,
      config: { ...config, timeoutMs: CLASSIFIER_TIMEOUT_MIN_MS },
      state: {}
    });
    expect(v.ok).toBe(false);
    expect(v.note).toContain('超时');
  }, 10000);

  it('首次超时 → 自动重试一次；第二次成功则照常判定（本地端点冷启动场景）', async () => {
    let calls = 0;
    const runtime = {
      getModelOfType: () => ({}),
      classify: (_m: unknown, _c: unknown, options: any) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            options.signal.addEventListener('abort', () =>
              resolve({ stopReason: 'aborted', answers: {} })
            );
          });
        }
        return Promise.resolve({
          stopReason: 'stop',
          answers: {
            [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.95 }
          }
        });
      }
    };
    const v = await classifyToolCall({
      runtime,
      config: { ...config, timeoutMs: CLASSIFIER_TIMEOUT_MIN_MS },
      state: { tool: 'bash' }
    });

    expect(calls).toBe(2);
    expect(v.ok).toBe(true);
    expect(v.autoAllowed).toBe(true);

    // 日志里要看得到「重试了一次」，否则事后查不出为什么慢
    const logDir = path.join(tmpDir, 'logs');
    const logFile = fs.readdirSync(logDir).find((n) => n.startsWith('classifier-'))!;
    const lines = fs
      .readFileSync(path.join(logDir, logFile), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const tail = lines.slice(-3);
    expect(tail[0].phase).toBe('request');
    expect(tail[1]).toMatchObject({ phase: 'error', attempt: 1, retrying: expect.any(String) });
    expect(tail[2]).toMatchObject({ phase: 'response', attempt: 2 });
  }, 10000);

  it.each(['aborted', 'stop'])(
    '两次都超时 → 即使返回 %s 也必须回退人工',
    async (stopReason) => {
      let calls = 0;
      const runtime = {
        getModelOfType: () => ({}),
        classify: (_m: unknown, _c: unknown, options: any) => {
          calls += 1;
          return new Promise((resolve) => {
            options.signal.addEventListener('abort', () =>
              resolve({
                stopReason,
                answers: {
                  [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.99 }
                }
              })
            );
          });
        }
      };
      const v = await classifyToolCall({
        runtime,
        config: { ...config, timeoutMs: CLASSIFIER_TIMEOUT_MIN_MS },
        state: {}
      });
      expect(calls).toBe(2);
      expect(v.ok).toBe(false);
      expect(v.note).toContain('超时');
    },
    10000
  );

  it('外部取消（会话中止）→ 不重试，只打一次请求', async () => {
    const controller = new AbortController();
    let calls = 0;
    const runtime = {
      getModelOfType: () => ({}),
      classify: (_m: unknown, _c: unknown, options: any) => {
        calls += 1;
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () =>
            resolve({ stopReason: 'aborted', answers: {} })
          );
          setTimeout(() => controller.abort(), 10);
        });
      }
    };
    const v = await classifyToolCall({
      runtime,
      config: { ...config, timeoutMs: 5000 },
      state: {},
      signal: controller.signal
    });
    expect(calls).toBe(1);
    expect(v.note).toContain('被取消');
  }, 10000);
});

// ===================== 控制器层 =====================

interface PushedRequest {
  id: string;
  toolName: string;
  classifier?: {
    ok: boolean;
    level?: string;
    confidence?: number;
    autoAllowed: boolean;
    note?: string;
  };
  danger?: { category: string };
}

/** 最小 fake PiBridge：捕获审批推送、提供工具描述与 cwd */
function makeFakeBridge(toolDescription?: string) {
  const requests: PushedRequest[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, request: PushedRequest) => {
        requests.push(request);
      }
    }
  };
  const bridge = {
    cwd: '/tmp/proj',
    win,
    session: {
      getToolDefinition: (name: string) =>
        toolDescription ? { name, description: toolDescription } : undefined
    },
    sendSessionEvent: (channel: string, request: unknown) => {
      win.webContents.send(channel, request as PushedRequest);
      return true;
    }
  } as any;
  const host = {
    current: () => bridge.session,
    cwd: () => bridge.cwd,
    sendSessionEvent: (channel: string, request: unknown) => bridge.sendSessionEvent(channel, request)
  };
  return { bridge, host, requests };
}

/** fake ModelRuntime：记录调用参数，默认返回 safe 判定 */
function makeFakeRuntime(
  answer: Record<string, unknown> | Error = {
    stopReason: 'stop',
    answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.95 } }
  }
) {
  const calls: { state: Record<string, unknown> }[] = [];
  const classify = vi.fn(async (_model: unknown, context: any) => {
    calls.push({ state: context.state });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const runtime = {
    getModelOfType: (_type: string, providerId: string, modelId: string) => ({
      provider: providerId,
      id: modelId
    }),
    classify
  };
  return { runtime, calls, classify };
}

/** 驱动闸门：返回是否弹了审批、是否被阻断、以及推送的请求 */
async function runGate(
  ctrl: PermissionController,
  fake: ReturnType<typeof makeFakeBridge>,
  toolName: string,
  input: unknown,
  decision: 'allow' | 'deny' | 'allow-session' = 'deny'
) {
  fake.requests.length = 0;
  const promise = ctrl.gateForTest(toolName, input);
  // 让分类调用（若干微任务 + 一次宏任务）跑完
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  const pushed = fake.requests.length > 0;
  if (pushed) ctrl.resolvePermission(fake.requests[0].id, decision);
  const result = await promise;
  return {
    pushed,
    blocked: !!result?.block,
    request: fake.requests[0] as PushedRequest | undefined
  };
}

function makeController(runtime: unknown, toolDescription?: string, config?: unknown) {
  const fake = makeFakeBridge(toolDescription);
  const ctrl = new PermissionController(fake.bridge, fake.host);
  fake.bridge.modelRuntime = runtime;
  ctrl.setPolicy('classifier-auto');
  ctrl.setClassifierConfig(config ?? { providerId: 'local-kev', modelId: 'm' });
  return { ctrl, fake };
}

describe('PermissionController classifier-auto', () => {
  const staticSafeCalls: [string, unknown][] = [
    ['read', { path: 'a.ts' }],
    ['goal_complete', {}],
    ['goal_blocked', {}],
    ['propose_plan', {}],
    ['bash', { command: 'pwd' }],
    ['write', { path: 'a.ts', content: 'export {};' }],
    ['edit', { path: 'a.ts', oldText: 'a', newText: 'b' }]
  ];

  it.each(staticSafeCalls)('静态安全调用 %s 也必须先由模型判断', async (tool, input) => {
    const { runtime, classify } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime);
    // 使用存在的项目目录，确保 write/edit 在旧白名单路径上确实可以自动放行。
    fake.bridge.cwd = path.resolve(__dirname, '../..');
    const res = await runGate(ctrl, fake, tool, input);
    expect(res.pushed).toBe(false);
    expect(res.blocked).toBe(false);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it.each(staticSafeCalls)('静态安全调用 %s 不能跳过模型的风险判定', async (tool, input) => {
    const { runtime, classify } = makeFakeRuntime({
      stopReason: 'stop',
      answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'risky', confidence: 0.95 } }
    });
    const { ctrl, fake } = makeController(runtime);
    fake.bridge.cwd = path.resolve(__dirname, '../..');
    const res = await runGate(ctrl, fake, tool, input);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
    expect(res.blocked).toBe(true);
    expect(res.request?.classifier?.level).toBe('risky');
  });

  it('模型判定 safe 且置信度达标 → 免审批放行', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime, '运行 shell 命令');
    const res = await runGate(ctrl, fake, 'bash', { command: 'npm test' });
    expect(res.pushed).toBe(false);
    expect(res.blocked).toBe(false);
    // 工具描述与命令进入 state
    expect(calls[0].state.tool_description).toBe('运行 shell 命令');
    expect(calls[0].state.command).toBe('npm test');
    expect(calls[0].state.working_directory).toBe('/tmp/proj');
  });

  it('模型判定 risky → 弹审批且请求带模型判定', async () => {
    const { runtime } = makeFakeRuntime({
      stopReason: 'stop',
      answers: {
        [APPROVAL_QUESTION_ID]: {
          type: 'choice',
          choice: 'risky',
          confidence: 0.88,
          probabilities: { safe: 0.12, risky: 0.88 }
        }
      }
    });
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'bash', { command: 'npm publish --tag latest' });
    expect(res.pushed).toBe(true);
    expect(res.request?.classifier).toMatchObject({
      ok: true,
      level: 'risky',
      confidence: 0.88,
      autoAllowed: false
    });
  });

  it('fail-safe：模型运行时不可用 → 弹审批并说明已回退', async () => {
    const { ctrl, fake } = makeController(null);
    const res = await runGate(ctrl, fake, 'read', { path: 'a.ts' });
    expect(res.pushed).toBe(true);
    expect(res.request?.classifier?.ok).toBe(false);
    expect(res.request?.classifier?.autoAllowed).toBe(false);
  });

  it('fail-safe：classify 抛错 → 弹审批（不放行）', async () => {
    const { runtime } = makeFakeRuntime(new Error('connection refused'));
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'read', { path: 'a.ts' });
    expect(res.pushed).toBe(true);
    expect(res.request?.classifier?.ok).toBe(false);
    expect(res.request?.classifier?.note).toContain('connection refused');
  });

  it('未配置模型时，白名单工具也必须人工审批', async () => {
    const { runtime, classify } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime, undefined, {});
    const res = await runGate(ctrl, fake, 'read', { path: 'a.ts' });
    expect(res.pushed).toBe(true);
    expect(res.blocked).toBe(true);
    expect(res.request?.classifier?.note).toContain('未选择决策模型');
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    { stopReason: 'stop', answers: {} },
    { stopReason: 'error', errorMessage: 'unavailable', answers: {} },
    {
      stopReason: 'stop',
      answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'maybe', confidence: 0.99 } }
    },
    { stopReason: 'stop', answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe' } } }
  ])('模型返回无效结果时白名单工具仍转人工：%j', async (answer) => {
    const { runtime } = makeFakeRuntime(answer);
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'read', { path: 'a.ts' });
    expect(res.pushed).toBe(true);
    expect(res.blocked).toBe(true);
    expect(res.request?.classifier?.ok).toBe(false);
  });

  it('置信度低于阈值 → 弹审批并给出原因', async () => {
    const { runtime } = makeFakeRuntime({
      stopReason: 'stop',
      answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.5 } }
    });
    const { ctrl, fake } = makeController(runtime, undefined, {
      providerId: 'local-kev',
      modelId: 'm',
      minConfidence: 0.9
    });
    const res = await runGate(ctrl, fake, 'read', { path: 'a.ts' });
    expect(res.pushed).toBe(true);
    expect(String(res.request?.classifier?.note)).toContain('低于阈值');
    expect(String(res.request?.classifier?.note)).toContain('0.50');
  });

  it('危险规则命中的调用也先由模型判断，安全且置信度达标时放行', async () => {
    const { runtime, classify } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'bash', { command: 'rm -rf build' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(false);
    expect(res.blocked).toBe(false);
  });

  it.each([{ safeTools: ['bash'] }, { safeBashCommands: ['rm'] }])(
    '自定义白名单 %j 不能绕过模型的危险判定，人工审批保留危险提示',
    async (config) => {
      const { runtime, classify } = makeFakeRuntime({
        stopReason: 'stop',
        answers: {
          [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'dangerous', confidence: 0.99 }
        }
      });
      const { ctrl, fake } = makeController(runtime);
      ctrl.setAutoSafeConfig(config);
      const res = await runGate(ctrl, fake, 'bash', { command: 'rm -rf build' });
      expect(res.pushed).toBe(true);
      expect(res.blocked).toBe(true);
      expect(res.request?.danger?.category).toBe('destructive-remove');
      expect(res.request?.classifier?.level).toBe('dangerous');
      expect(classify).toHaveBeenCalledTimes(1);
    }
  );

  it('用户允许后放行；拒绝则阻断', async () => {
    const { runtime, classify } = makeFakeRuntime({
      stopReason: 'stop',
      answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'dangerous', confidence: 0.99 } }
    });
    const { ctrl, fake } = makeController(runtime);
    const allowed = await runGate(ctrl, fake, 'bash', { command: 'killall node' }, 'allow');
    expect(allowed.pushed).toBe(true);
    expect(allowed.blocked).toBe(false);
    const denied = await runGate(ctrl, fake, 'bash', { command: 'killall node' }, 'deny');
    expect(denied.pushed).toBe(true);
    expect(denied.blocked).toBe(true);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(ctrl.getSessionAllowedTools()).toEqual([]);
  });

  it.each(['safe', 'risky'])('已有会话授权仍重新判断，使用本次模型结果 %s', async (level) => {
    const { runtime, classify } = makeFakeRuntime({
      stopReason: 'stop',
      answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: level, confidence: 0.99 } }
    });
    const { ctrl, fake } = makeController(runtime);
    ctrl.setPolicy('ask-all');
    await runGate(ctrl, fake, 'bash', { command: 'npm test' }, 'allow-session');
    expect(ctrl.getSessionAllowedTools()).toEqual(['bash']);
    ctrl.setPolicy('classifier-auto');
    const res = await runGate(ctrl, fake, 'bash', { command: 'npm test' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(level !== 'safe');
    expect(res.blocked).toBe(level !== 'safe');
  });

  it.each([false, true])(
    '模型审批收到 allow-session 也只允许本次（响应前切换策略：%s）',
    async (switchPolicy) => {
      const { runtime, classify } = makeFakeRuntime({
        stopReason: 'stop',
        answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'risky', confidence: 0.99 } }
      });
      const { ctrl, fake } = makeController(runtime);
      const pending = ctrl.gateForTest('bash', { command: 'npm test' });
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      if (switchPolicy) ctrl.setPolicy('ask-all');
      ctrl.resolvePermission(fake.requests[0].id, 'allow-session');
      expect(await pending).toBeUndefined();
      expect(ctrl.getSessionAllowedTools()).toEqual([]);
      ctrl.setPolicy('classifier-auto');
      const again = await runGate(ctrl, fake, 'bash', { command: 'npm test' });
      expect(again.pushed).toBe(true);
      expect(again.blocked).toBe(true);
      expect(classify).toHaveBeenCalledTimes(2);
    }
  );

  it('参数被截断时，即使模型返回安全也请求人工审批', async () => {
    const { runtime, calls } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'bash', {
      command: `echo ${'a'.repeat(MAX_ARGS_CHARS)}; rm -rf /`
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].state.arguments_truncated).toBe(true);
    expect(String(calls[0].state.command)).not.toContain('rm -rf /');
    expect(res.pushed).toBe(true);
    expect(res.blocked).toBe(true);
    expect(res.request?.classifier?.autoAllowed).toBe(false);
    expect(res.request?.classifier?.note).toContain('参数已截断');
  });

  it('已取消的调用不发起模型判定或人工审批', async () => {
    const { runtime, classify } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime);
    const abort = new AbortController();
    abort.abort();
    const res = await ctrl.gateForTest('read', { path: 'a.ts' }, abort.signal);
    expect(res?.block).toBe(true);
    expect(classify).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it.each(['stop', 'aborted'])(
    '判定期间取消后，不执行或留下挂起审批（模型返回 %s）',
    async (stopReason) => {
      const { runtime, classify } = makeFakeRuntime();
      const abort = new AbortController();
      classify.mockImplementationOnce(async () => {
        abort.abort();
        return {
          stopReason,
          answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'safe', confidence: 0.99 } }
        };
      });
      const { ctrl, fake } = makeController(runtime);
      const res = await ctrl.gateForTest('read', { path: 'a.ts' }, abort.signal);
      expect(res?.block).toBe(true);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(fake.requests).toHaveLength(0);
    }
  );

  it.each(['ask-all', 'auto-safe', 'allow-all'])('非模型策略 %s 不调用模型', async (policy) => {
    const { runtime, classify } = makeFakeRuntime();
    const { ctrl, fake } = makeController(runtime);
    ctrl.setPolicy(policy);
    const res = await runGate(ctrl, fake, 'bash', { command: 'npm test' });
    expect(classify).not.toHaveBeenCalled();
    expect(res.pushed).toBe(policy !== 'allow-all');
    expect(res.request?.classifier).toBeUndefined();
  });
});

/**
 * 「默认放行工作目录写入」（allowWriteInCwd）：
 * 决策模型判定所需的 arguments 会被按长度截断（MAX_ARGS_CHARS），大型文件写入因此常被判为
 * risky / 无法确认；用户显式开启该开关后，工作目录内的 write / edit 直接放行且不调模型，
 * 关闭时行为完全不变。范围与 auto-safe 的 isSafeWriteInCwd 一致。
 */
describe('PermissionController classifier-auto × 默认放行工作目录写入', () => {
  /** 一律返回 risky：只要模型被调用，就一定弹审批，便于区分「放行」与「交模型」 */
  const RISKY = {
    stopReason: 'stop',
    answers: { [APPROVAL_QUESTION_ID]: { type: 'choice', choice: 'risky', confidence: 0.95 } }
  };
  const allowWrite = { providerId: 'local-kev', modelId: 'm', allowWriteInCwd: true };

  it('开关关闭（默认）时，工作目录内的 write 仍交模型判定', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime);
    const res = await runGate(ctrl, fake, 'write', { path: 'src/a.ts', content: 'x' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });

  it('开关开启时，工作目录内的 write / edit 不调模型直接放行', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime, undefined, allowWrite);
    const write = await runGate(ctrl, fake, 'write', { path: 'src/a.ts', content: 'x' });
    const edit = await runGate(ctrl, fake, 'edit', {
      path: 'src/a.ts',
      oldText: 'a',
      newText: 'b'
    });
    expect(classify).not.toHaveBeenCalled();
    expect([write.pushed, write.blocked]).toEqual([false, false]);
    expect([edit.pushed, edit.blocked]).toEqual([false, false]);
  });

  it('开关开启时，工作目录之外的写入仍交模型判定', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime, undefined, allowWrite);
    const res = await runGate(ctrl, fake, 'write', { path: '../outside/a.ts', content: 'x' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });

  it('开关开启时，工作目录内但属敏感目录（.git）的写入仍交模型判定', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime, undefined, allowWrite);
    const res = await runGate(ctrl, fake, 'write', {
      path: '.git/hooks/pre-commit',
      content: 'x'
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });

  it('开关开启时，工作目录为家目录时不放行（家目录不是项目目录）', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime, undefined, allowWrite);
    fake.bridge.cwd = homedir();
    const res = await runGate(ctrl, fake, 'write', { path: 'notes.md', content: 'x' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });

  it('开关只作用于 write / edit：工作目录内的 bash 仍交模型判定', async () => {
    const { runtime, classify } = makeFakeRuntime(RISKY);
    const { ctrl, fake } = makeController(runtime, undefined, allowWrite);
    const res = await runGate(ctrl, fake, 'bash', { command: 'npm test' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(res.pushed).toBe(true);
  });
});
