import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-nudge-'));
  process.env.PI_MEMORY_DIR = tmpDir;
  resetAllNudgeCounters();
});
afterEach(() => {
  resetAllNudgeCounters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_MEMORY_DIR;
});

import {
  CORRECTION_MIN_TURNS,
  MIN_SEDIMENT_GAP_MS,
  detectCorrection,
  emptyCounters,
  getNudgeCounters,
  markSedimented,
  recordTurn,
  resetAllNudgeCounters,
  resetNudgeCounters,
  shouldSediment,
  shouldSedimentOnCorrection,
  type NudgeCounters
} from '../../electron/memory/nudge';
import {
  DEFAULT_MEMORY_CONFIG,
  readMemoryConfig,
  writeMemoryConfig
} from '../../electron/memory/config';

describe('detectCorrection', () => {
  it('识别中文强纠正信号', () => {
    for (const text of [
      '不对，应该用 pnpm 装依赖',
      '你理解错了，我说的是主进程',
      '不要这样改，会破坏缓存',
      '记住以后都用中文注释'
    ]) {
      const hit = detectCorrection(text);
      expect(hit, text).not.toBeNull();
      expect(hit!.strength).toBe('strong');
    }
  });

  it('识别英文强纠正信号', () => {
    expect(detectCorrection("that's wrong, use the other API")!.strength).toBe('strong');
    expect(detectCorrection('no, use pnpm instead')!.strength).toBe('strong');
  });

  it('弱信号只标 weak', () => {
    const hit = detectCorrection('其实这个文件还有第二份拷贝');
    expect(hit!.strength).toBe('weak');
    expect(detectCorrection('Actually the cache is shared')!.strength).toBe('weak');
  });

  it('普通消息不误报', () => {
    for (const text of [
      '帮我看下这个函数为什么报错',
      '继续',
      '把这个面板的间距调大一点',
      'Please add a test for the parser'
    ]) {
      expect(detectCorrection(text), text).toBeNull();
    }
  });

  it('过短文本直接跳过', () => {
    expect(detectCorrection('')).toBeNull();
    expect(detectCorrection('不对')).toBeNull();
  });

  it('命中片段截断且带省略号', () => {
    const text = `${'很长的前文'.repeat(10)}不对，应该用 pnpm${'很长的后文'.repeat(10)}`;
    const hit = detectCorrection(text)!;
    expect(hit.excerpt.length).toBeLessThanOrEqual(61);
    expect(hit.excerpt).toContain('不对');
  });
});

describe('shouldSediment', () => {
  const thresholds = { nudgeTurns: 12, nudgeToolCalls: 20 };
  const base = (patch: Partial<NudgeCounters> = {}): NudgeCounters => ({
    ...emptyCounters(),
    ...patch
  });

  it('轮次达到阈值触发', () => {
    expect(shouldSediment(base({ turns: 11 }), thresholds, 1e12)).toBe(false);
    expect(shouldSediment(base({ turns: 12 }), thresholds, 1e12)).toBe(true);
  });

  it('工具调用达到阈值触发（轮次不够也行）', () => {
    expect(shouldSediment(base({ turns: 2, toolCalls: 20 }), thresholds, 1e12)).toBe(true);
  });

  it('沉淀后基线重置，需要重新累计', () => {
    const counters = base({ turns: 12, lastTurns: 12, lastAt: 1 });
    expect(shouldSediment(counters, thresholds, 1e12)).toBe(false);
    counters.turns = 24;
    expect(shouldSediment(counters, thresholds, 1e12)).toBe(true);
  });

  it('两次沉淀之间有最小间隔', () => {
    const now = 1_000_000_000_000;
    const counters = base({ turns: 30, lastAt: now - 1000 });
    expect(shouldSediment(counters, thresholds, now)).toBe(false);
    expect(shouldSediment(counters, thresholds, now + MIN_SEDIMENT_GAP_MS)).toBe(true);
  });

  it('阈值被夹到至少 1', () => {
    expect(shouldSediment(base({ turns: 1 }), { nudgeTurns: 0, nudgeToolCalls: 0 }, 1e12)).toBe(
      true
    );
  });
});

describe('shouldSedimentOnCorrection', () => {
  const strong = { strength: 'strong' as const, excerpt: 'x', label: 'cn-not-that' };
  const weak = { strength: 'weak' as const, excerpt: 'x', label: 'cn-actually' };

  it('开局轮次太少不触发', () => {
    expect(shouldSedimentOnCorrection(strong, { ...emptyCounters(), turns: 1 }, 1e12)).toBe(false);
    expect(
      shouldSedimentOnCorrection(strong, { ...emptyCounters(), turns: CORRECTION_MIN_TURNS }, 1e12)
    ).toBe(true);
  });

  it('弱信号不触发', () => {
    expect(shouldSedimentOnCorrection(weak, { ...emptyCounters(), turns: 10 }, 1e12)).toBe(false);
  });

  it('没有纠正信号不触发', () => {
    expect(shouldSedimentOnCorrection(null, { ...emptyCounters(), turns: 10 }, 1e12)).toBe(false);
  });

  it('刚沉淀过则跳过', () => {
    const now = 1_000_000_000_000;
    expect(
      shouldSedimentOnCorrection(strong, { ...emptyCounters(), turns: 10, lastAt: now - 1000 }, now)
    ).toBe(false);
  });
});

describe('每会话计数器', () => {
  it('不同会话互不影响', () => {
    recordTurn('s1', 3);
    recordTurn('s1', 2);
    recordTurn('s2', 1);
    expect(getNudgeCounters('s1')).toMatchObject({ turns: 2, toolCalls: 5 });
    expect(getNudgeCounters('s2')).toMatchObject({ turns: 1, toolCalls: 1 });
  });

  it('markSedimented 记录基线', () => {
    recordTurn('s1', 4);
    const now = 1_000_000_000_000;
    markSedimented('s1', now);
    expect(getNudgeCounters('s1')).toMatchObject({
      turns: 1,
      toolCalls: 4,
      lastTurns: 1,
      lastToolCalls: 4,
      lastAt: now
    });
  });

  it('session_start 重置清零', () => {
    recordTurn('s1', 9);
    resetNudgeCounters('s1');
    expect(getNudgeCounters('s1')).toEqual(emptyCounters());
  });

  it('负数工具调用不累加', () => {
    recordTurn('s1', -5);
    expect(getNudgeCounters('s1').toolCalls).toBe(0);
  });
});

describe('自动沉淀配置', () => {
  it('默认值与文档一致', () => {
    const config = readMemoryConfig();
    expect(config).toMatchObject({
      autoExtract: true,
      nudgeTurns: 12,
      nudgeToolCalls: 20,
      correctionDetect: true,
      preCompactFlush: true
    });
    expect(Object.keys(DEFAULT_MEMORY_CONFIG)).toContain('autoExtract');
  });

  it('写读往返 + 越界夹取', () => {
    writeMemoryConfig({ autoExtract: false, nudgeTurns: 2, nudgeToolCalls: 9999 });
    const config = readMemoryConfig();
    expect(config.autoExtract).toBe(false);
    expect(config.nudgeTurns).toBe(3); // 下限 3
    expect(config.nudgeToolCalls).toBe(500); // 上限 500
  });

  it('坏值回退默认', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ autoExtract: 'yes', nudgeTurns: 'x', preCompactFlush: 1 }),
      'utf-8'
    );
    const config = readMemoryConfig();
    expect(config.autoExtract).toBe(true);
    expect(config.nudgeTurns).toBe(12);
    expect(config.preCompactFlush).toBe(true);
  });
});
