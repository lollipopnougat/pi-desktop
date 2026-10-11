/**
 * Subagent 持久化单测:序列化/反序列化 / entries 恢复聚合 / 同 id 演进。
 */
import { describe, it, expect } from 'vitest';
import {
  serializeChildRun,
  deserializeChildRun,
  loadRunsFromEntries,
  isTerminalRunStatus,
  SUBAGENT_STATE_ENTRY_TYPE
} from '../../electron/subagents/persistence';
import type { ChildRun } from '../../electron/subagents/types';

function makeRun(overrides: Partial<ChildRun> = {}): ChildRun {
  return {
    id: 'sa-1',
    name: '查X',
    agent: 'scout',
    task: '查 X 的实现',
    status: 'complete',
    output: 'X 在 a.ts',
    outputSource: 'submit',
    async: false,
    depth: 0,
    createdAt: 1700000000000,
    startedAt: 1700000000000,
    endedAt: 1700000001000,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    progress: { recentTools: [], turns: 2, tokens: 150, durationMs: 1000 },
    sessionFile: '/tmp/subagent-sessions/x.jsonl',
    toolCalls: [
      {
        toolCallId: 'tc1',
        toolName: 'grep',
        args: { pattern: 'X' },
        result: 'ok',
        startedAt: 1,
        endedAt: 2
      }
    ],
    ...overrides
  };
}

describe('serializeChildRun / deserializeChildRun', () => {
  it('序列化剔除 progress/toolCalls(运行时字段不落盘)', () => {
    const s = serializeChildRun(makeRun());
    expect(s).not.toHaveProperty('progress');
    expect(s).not.toHaveProperty('toolCalls');
    expect(s).toMatchObject({
      id: 'sa-1',
      agent: 'scout',
      status: 'complete',
      output: 'X 在 a.ts'
    });
  });

  it('反序列化 roundtrip 保核心字段,补空 progress', () => {
    const restored = deserializeChildRun(serializeChildRun(makeRun()));
    expect(restored).toMatchObject({
      id: 'sa-1',
      name: '查X',
      agent: 'scout',
      status: 'complete',
      output: 'X 在 a.ts',
      outputSource: 'submit',
      usage: { input: 100, output: 50 }
    });
    expect(restored?.progress).toEqual({ recentTools: [], turns: 0, tokens: 0, durationMs: 0 });
    expect(restored?.toolCalls).toBeUndefined();
  });

  it('会话文件路径随记录落盘(重启后仍能回放对话)', () => {
    const s = serializeChildRun(makeRun());
    expect(s.sessionFile).toBe('/tmp/subagent-sessions/x.jsonl');
    const restored = deserializeChildRun(s);
    expect(restored?.sessionFile).toBe('/tmp/subagent-sessions/x.jsonl');
    // 缺失时不影响反序列化
    const withoutFile = { ...s };
    delete withoutFile.sessionFile;
    expect(deserializeChildRun(withoutFile)?.sessionFile).toBeUndefined();
  });

  it('非法数据返回 null', () => {
    expect(deserializeChildRun(null)).toBeNull();
    expect(deserializeChildRun('x')).toBeNull();
    expect(
      deserializeChildRun({ id: 1, name: 'a', agent: 'b', task: 'c', status: 'complete' })
    ).toBeNull();
    expect(
      deserializeChildRun({ id: 'a', name: 'n', agent: 'g', task: 't', status: 'weird' })
    ).toBeNull();
  });
});

describe('loadRunsFromEntries', () => {
  const entry = (run: unknown) => ({
    type: 'custom',
    customType: SUBAGENT_STATE_ENTRY_TYPE,
    data: { run }
  });

  it('收集全部 subagent-state 并按 createdAt 排序', () => {
    const runs = loadRunsFromEntries([
      { type: 'message', role: 'user' },
      entry(serializeChildRun(makeRun({ id: 'sa-2', createdAt: 2000, name: '后' }))),
      entry(serializeChildRun(makeRun({ id: 'sa-1', createdAt: 1000, name: '先' }))),
      { type: 'custom', customType: 'goal-state', data: {} }
    ]);
    expect(runs.map((r) => r.id)).toEqual(['sa-1', 'sa-2']);
  });

  it('同 id 多条取最后一条(状态演进)', () => {
    const runs = loadRunsFromEntries([
      entry(serializeChildRun(makeRun({ id: 'sa-1', status: 'running' }))),
      entry(serializeChildRun(makeRun({ id: 'sa-1', status: 'complete', output: 'done' })))
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('complete');
    expect(runs[0].output).toBe('done');
  });

  it('超过 50 条丢最旧', () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      entry(serializeChildRun(makeRun({ id: `sa-${i}`, createdAt: i })))
    );
    const runs = loadRunsFromEntries(entries);
    expect(runs).toHaveLength(50);
    expect(runs[0].id).toBe('sa-10'); // 最旧的 sa-0..sa-9 被丢
  });

  it('非法 entry 跳过不炸', () => {
    const runs = loadRunsFromEntries([
      entry(null),
      entry('garbage'),
      entry(serializeChildRun(makeRun()))
    ]);
    expect(runs).toHaveLength(1);
  });

  it('兼容无 run 包裹的裸数据(向后容错)', () => {
    const runs = loadRunsFromEntries([
      { type: 'custom', customType: SUBAGENT_STATE_ENTRY_TYPE, data: serializeChildRun(makeRun()) }
    ]);
    expect(runs).toHaveLength(1);
  });
});

describe('isTerminalRunStatus', () => {
  it('仅 complete/failed/stopped 为终态', () => {
    expect(isTerminalRunStatus('complete')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('stopped')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('queued')).toBe(false);
  });
});
