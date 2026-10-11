/**
 * 决策模型全链路「真机」验收测试（默认跳过）
 *
 * 用真实的 `ModelRuntime` + 真实的本地分类端点，跑通
 * 「保存配置 → 出现在清单 → classify → 移除」全流程，
 * 覆盖 classifier-config → classifier/registry → ModelRuntime → HTTP 端点 → IPC 响应形状。
 *
 * 默认跳过（CI 上没有本地端点）。需要本地起一个 llama.cpp 分类服务后手动开启：
 *
 *   PI_CLASSIFIER_E2E=1 npx vitest run tests/classifier/live.test.ts --reporter=verbose
 *
 * 端点与模型可用环境变量覆盖：
 *   PI_CLASSIFIER_E2E_BASE_URL（默认 http://127.0.0.1:8080/v1）
 *   PI_CLASSIFIER_E2E_MODEL（默认 ./Kev-4B-Q4_K_M.gguf）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { tmpDir, handlers } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(tmpdir(), `pi-desktop-classifier-live-${Date.now()}`);
  return {
    tmpDir: dir,
    handlers: new Map<string, (event: unknown, ...args: any[]) => any>()
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, fn: (event: unknown, ...args: any[]) => any) {
      handlers.set(channel, fn);
    }
  }
}));

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import { registerClassifierIpc } from '../../electron/ipc/classifier-ipc';
import { buildApprovalState, classifyToolCall } from '../../electron/permission/classifier-gate';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const ENABLED = process.env.PI_CLASSIFIER_E2E === '1';
const BASE_URL = process.env.PI_CLASSIFIER_E2E_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const MODEL_ID = process.env.PI_CLASSIFIER_E2E_MODEL ?? './Kev-4B-Q4_K_M.gguf';
const KEY = 'local-kev-live';

function invoke(channel: string, ...args: any[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler: ${channel}`);
  return handler(null, ...args);
}

describe.skipIf(!ENABLED)('决策模型全链路（真实 runtime + 真实本地端点）', () => {
  let runtime: any;

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    runtime = await ModelRuntime.create({
      authPath: path.join(tmpDir, 'auth.json'),
      modelsPath: path.join(tmpDir, 'models.json')
    });
    handlers.clear();
    registerClassifierIpc({ modelRuntime: runtime } as any);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('保存配置 → 出现在清单 → classify → 移除', async () => {
    const probe = await fetch(`${BASE_URL}/models`).catch((error) => error);
    expect(probe, `本地端点 ${BASE_URL} 不可达`).not.toBeInstanceOf(Error);
    expect(probe.status).toBe(200);

    // 1) 保存自定义端点（走真实 handler：先注册成功再落盘）
    expect(
      await invoke('pi:saveClassifierProvider', {
        key: KEY,
        name: '本地 Kev 4B',
        baseUrl: BASE_URL,
        api: 'typesafe-system-one',
        models: [{ id: MODEL_ID, name: 'Kev 4B', contextWindow: 262144 }]
      })
    ).toEqual({ ok: true, key: KEY });

    // 2) 出现在决策模型清单，标记为「可用 + 自定义」
    const list = await invoke('pi:getClassifierModels');
    expect(list.models.find((m: any) => m.provider === KEY && m.id === MODEL_ID)).toMatchObject({
      apiLabel: 'System One',
      contextWindow: 262144,
      available: true,
      custom: true
    });

    // 3) 正面用例：三种问题类型都能拿到概率
    const positive = await invoke('pi:classify', {
      provider: KEY,
      id: MODEL_ID,
      state: { message: '这次改得挺好，问题解决了，谢谢。' },
      questions: {
        category: {
          type: 'choice',
          instructions: '判断这条用户消息属于哪一类。',
          criteria: { approval: '用户在肯定结果', correction: '用户在指出问题' }
        },
        satisfaction: {
          type: 'score',
          instructions: '给用户满意度打分，-2 很不满意，2 很满意。',
          criteria: ['很不满意', '不满意', '中性', '满意', '很满意']
        },
        approved: {
          type: 'bool',
          instructions: '用户是否认可这次改动？',
          criteria: { true: '认可', false: '不认可' }
        }
      }
    });
    expect(positive.stopReason).toBe('stop');
    expect(positive.provider).toBe(KEY);
    expect(positive.answers.category.choice).toBe('approval');
    expect(positive.answers.satisfaction.score).toBeGreaterThan(0);
    expect(positive.answers.approved.probability).toBeGreaterThan(0.5);

    // 4) 负面用例：语义应相反
    const negative = await invoke('pi:classify', {
      provider: KEY,
      id: MODEL_ID,
      state: { message: 'This is broken, it deleted my file. Fix it.' },
      questions: {
        category: {
          type: 'choice',
          instructions: '判断这条用户消息属于哪一类。',
          criteria: { approval: '用户在肯定结果', correction: '用户在指出问题' }
        }
      }
    });
    expect(negative.stopReason).toBe('stop');
    expect(negative.answers.category.choice).toBe('correction');

    // 5) 移除后不再出现在清单里
    expect(await invoke('pi:removeClassifierProvider', KEY)).toEqual({ ok: true });
    expect(
      (await invoke('pi:getClassifierModels')).models.some((m: any) => m.provider === KEY)
    ).toBe(false);
  }, 120_000);

  it('classifier-auto 闸门：真实模型判定工具调用（低风险放行 / 高风险不放行）', async () => {
    const gateKey = `${KEY}-gate`;
    expect(
      await invoke('pi:saveClassifierProvider', {
        key: gateKey,
        name: '本地 Kev 4B（闸门）',
        baseUrl: BASE_URL,
        api: 'typesafe-system-one',
        models: [{ id: MODEL_ID, contextWindow: 262144 }]
      })
    ).toEqual({ ok: true, key: gateKey });

    const config = { providerId: gateKey, modelId: MODEL_ID };
    const stateFor = (toolName: string, args: unknown) =>
      buildApprovalState({
        toolName,
        toolDescription: '在项目目录执行 shell 命令',
        args,
        cwd: process.cwd()
      });

    // 低风险：看项目文件 → 应免审批
    const safe = await classifyToolCall({
      runtime,
      config,
      state: stateFor('bash', { command: 'ls -la src' })
    });
    expect(safe.ok, JSON.stringify(safe)).toBe(true);
    expect(safe.level, JSON.stringify(safe)).toBe('safe');
    expect(safe.autoAllowed, JSON.stringify(safe)).toBe(true);

    // 高风险：发布包 → 不应免审批（等级留给模型裁量，只要求不放行）
    const publish = await classifyToolCall({
      runtime,
      config,
      state: stateFor('bash', { command: 'npm publish --access public' })
    });
    expect(publish.ok, JSON.stringify(publish)).toBe(true);
    expect(publish.autoAllowed, JSON.stringify(publish)).toBe(false);

    // 破坏性：删家目录 → 不应免审批
    const nuke = await classifyToolCall({
      runtime,
      config,
      state: stateFor('bash', { command: 'rm -rf ~/Documents --no-preserve-root' })
    });
    expect(nuke.ok, JSON.stringify(nuke)).toBe(true);
    expect(nuke.autoAllowed, JSON.stringify(nuke)).toBe(false);

    expect(await invoke('pi:removeClassifierProvider', gateKey)).toEqual({ ok: true });

    // 手动跑时打印真实判定，用于观察本地小模型的分级与耗时是否合理
    console.log(
      '[live] verdicts',
      JSON.stringify({ safe, publish, nuke }, null, 0),
      '\n'
    );
  }, 180_000);
});
