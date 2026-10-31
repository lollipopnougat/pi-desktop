/**
 * MemoryController.autoSediment 的门控测试：
 * 三个触发源各自受配置开关约束、任务忙时跳过、产物只在待合并数达阈值时才自动合并。
 *
 * 不触真实模型：把 triggerExtraction / triggerConsolidation 换成记录调用的桩。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mem-auto-'));
process.env.PI_MEMORY_DIR = tmpMemory;

const { MemoryController } = await import('../../electron/memory/controller');
const { writeMemoryConfig, projectIdentity } = await import('../../electron/memory/config');
const { writeState } = await import('../../electron/memory/pipeline');

const bridgeStub = { cwd: '/tmp/auto-proj', win: null, modelRuntime: null } as never;
const hostStub = {
  current: () => null,
  cwd: () => '/tmp/auto-proj',
  sendSessionEvent: () => true
};

type Stub = {
  calls: string[];
  extractOk: boolean;
  controller: InstanceType<typeof MemoryController>;
};

function newStub(): Stub {
  const controller = new MemoryController(bridgeStub, hostStub);
  const stub: Stub = { calls: [], extractOk: true, controller };
  (controller as unknown as Record<string, unknown>).triggerExtraction = async () => {
    stub.calls.push('extract');
    return stub.extractOk
      ? { ok: true, result: { scanned: 1, extracted: 1, skipped: 0, failed: 0 } }
      : { ok: false, error: '提取失败' };
  };
  (controller as unknown as Record<string, unknown>).triggerConsolidation = async () => {
    stub.calls.push('consolidate');
    return { ok: true, merged: 1 };
  };
  return stub;
}

/** 写 N 份待合并提取（extractions/<id>.md + state 里的 pending 列表） */
function seedPending(count: number, projectId: string) {
  const state = {
    processed: {},
    pendingExtractions: [] as string[],
    extractions: {} as Record<string, unknown>
  };
  const dir = path.join(tmpMemory, 'extractions');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const id = `e${i}`;
    fs.writeFileSync(
      path.join(dir, `${id}.md`),
      `---\nprojectId: ${projectId}\n---\n## summary\n- 条目 ${i}\n`,
      'utf-8'
    );
    state.pendingExtractions.push(id);
    state.extractions[id] = {
      projectId,
      sourceKey: id,
      at: new Date().toISOString(),
      status: 'pending'
    };
  }
  writeState(state as never);
}

beforeEach(() => {
  fs.rmSync(tmpMemory, { recursive: true, force: true });
  fs.mkdirSync(tmpMemory, { recursive: true });
  writeMemoryConfig({
    enabled: true,
    autoExtract: true,
    correctionDetect: true,
    preCompactFlush: true,
    consolidateThreshold: 5
  });
});

afterAll(() => {
  fs.rmSync(tmpMemory, { recursive: true, force: true });
});

describe('MemoryController.autoSediment 门控', () => {
  it('总开关关闭时不提取', async () => {
    writeMemoryConfig({ enabled: false });
    const stub = newStub();
    await stub.controller.autoSediment('nudge');
    expect(stub.calls).toEqual([]);
  });

  it('自动沉淀关闭时轮次与压缩触发都不提取，但纠错仍按自己的开关走', async () => {
    writeMemoryConfig({ autoExtract: false, correctionDetect: true });
    const stub = newStub();
    await stub.controller.autoSediment('nudge');
    await stub.controller.autoSediment('compact');
    expect(stub.calls).toEqual([]);
    await stub.controller.autoSediment('correction');
    expect(stub.calls).toEqual(['extract']);
  });

  it('纠错捕获开关关闭时不提取', async () => {
    writeMemoryConfig({ correctionDetect: false });
    const stub = newStub();
    await stub.controller.autoSediment('correction');
    expect(stub.calls).toEqual([]);
  });

  it('压缩前 flush 开关关闭时压缩触发不提取', async () => {
    writeMemoryConfig({ preCompactFlush: false });
    const stub = newStub();
    await stub.controller.autoSediment('compact');
    expect(stub.calls).toEqual([]);
  });

  it('待合并数达到阈值时自动合并成候选', async () => {
    const projectId = projectIdentity('/tmp/auto-proj').id;
    seedPending(5, projectId);
    const stub = newStub();
    await stub.controller.autoSediment('nudge');
    expect(stub.calls).toEqual(['extract', 'consolidate']);
  });

  it('待合并数不足阈值时不合并', async () => {
    const projectId = projectIdentity('/tmp/auto-proj').id;
    seedPending(2, projectId);
    const stub = newStub();
    await stub.controller.autoSediment('nudge');
    expect(stub.calls).toEqual(['extract']);
  });

  it('提取失败时不做合并', async () => {
    const projectId = projectIdentity('/tmp/auto-proj').id;
    seedPending(9, projectId);
    const stub = newStub();
    stub.extractOk = false;
    await stub.controller.autoSediment('nudge');
    expect(stub.calls).toEqual(['extract']);
  });

  it('沉淀过程中抛错不外泄', async () => {
    const stub = newStub();
    (stub.controller as unknown as Record<string, unknown>).triggerExtraction = async () => {
      throw new Error('boom');
    };
    await expect(stub.controller.autoSediment('nudge')).resolves.toBeUndefined();
  });
});
