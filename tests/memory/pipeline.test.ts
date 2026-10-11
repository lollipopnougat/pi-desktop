import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pipeline-test-'));
  process.env.PI_MEMORY_DIR = tmpDir;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_MEMORY_DIR;
});

import {
  readState,
  writeState,
  runExtraction,
  runConsolidation,
  listExtractionFiles,
  needsProcessing,
  listFailedSessions,
  formatExtractionMarkdown
} from '../../electron/memory/pipeline';
import {
  parseExtractionOutput,
  parseConsolidationOutput,
  buildConsolidationUserPrompt
} from '../../electron/memory/prompts';
import { watermarkKey } from '../../electron/memory/session-reader';
import { reviewCandidate } from '../../electron/memory/review';
import { readMemoryFile, writeMemoryFile } from '../../electron/memory/store';

// ─── state ───

describe('state.json', () => {
  it('roundtrips', () => {
    writeState({
      processed: { 'a.jsonl': { mtimeMs: 1, size: 2, at: 'x' } },
      pendingExtractions: ['e1.md'],
      stats: { extractions: 1, consolidations: 0 }
    });
    const s = readState();
    expect(s.processed['a.jsonl'].mtimeMs).toBe(1);
    expect(s.pendingExtractions).toEqual(['e1.md']);
    expect(s.stats?.extractions).toBe(1);
  });

  it('returns empty state for missing file', () => {
    expect(readState().processed).toEqual({});
  });
});

// ─── prompts 解析 ───

describe('parseExtractionOutput', () => {
  it('parses plain JSON', () => {
    const out = parseExtractionOutput(
      '{"userPreferences":["用 pnpm"],"lessons":[],"globalFacts":[],"projectKnowledge":[],"summary":"装依赖","noOp":false}'
    );
    expect(out?.userPreferences).toEqual(['用 pnpm']);
    expect(out?.noOp).toBe(false);
  });

  it('parses fenced JSON with prefix text', () => {
    const out = parseExtractionOutput('好的，结果：\n```json\n{"noOp":true}\n```');
    expect(out?.noOp).toBe(true);
  });

  it('returns null for garbage', () => {
    expect(parseExtractionOutput('not json at all')).toBeNull();
    expect(parseExtractionOutput('{}')).toBeNull();
    expect(parseExtractionOutput('{"summary":"没有实际结构"}')).toBeNull();
  });

  it('filters non-string array items', () => {
    const out = parseExtractionOutput(
      '{"userPreferences":[1,"ok",null],"lessons":[],"globalFacts":[],"projectKnowledge":[],"summary":"","noOp":false}'
    );
    expect(out?.userPreferences).toEqual(['ok']);
  });
});

describe('parseConsolidationOutput', () => {
  it('parses four file blocks', () => {
    const raw = `<file name="USER.md">
- 用户喜欢 pnpm
</file>
<file name="MEMORY.md">
</file>
<file name="LESSONS.md">
- [correction] 别用 npm
</file>
<file name="PROJECT.md">
- vite 构建
</file>`;
    const out = parseConsolidationOutput(raw);
    expect(out?.userMd).toContain('pnpm');
    expect(out?.memoryMd).toBe('');
    expect(out?.lessonsMd).toContain('correction');
    expect(out?.projectMd).toContain('vite');
  });

  it('returns null when a block is missing', () => {
    expect(parseConsolidationOutput('<file name="USER.md">x</file>')).toBeNull();
    const valid =
      '<file name="USER.md"></file><file name="MEMORY.md"></file><file name="LESSONS.md"></file><file name="PROJECT.md"></file>';
    expect(parseConsolidationOutput(valid + '<file name="USER.md">重复</file>')).toBeNull();
    expect(parseConsolidationOutput(valid.replace('USER.md', 'USERXmd'))).toBeNull();
  });
});

// ─── Phase 1 ───

/** mock LLM：根据 system prompt 类型返回预制输出 */
function makeMockComplete(opts?: { extraction?: string; consolidation?: string }) {
  const calls: Array<{ system: string; user: string }> = [];
  const fn = async (system: string, user: string) => {
    calls.push({ system: system, user });
    if (system.includes('记忆提取引擎')) {
      return (
        opts?.extraction ??
        '{"userPreferences":["偏好 pnpm"],"lessons":["[correction] 不要用 npm"],"globalFacts":["macOS 环境"],"projectKnowledge":["构建用 vite"],"summary":"配置项目","noOp":false}'
      );
    }
    if (system.includes('记忆合并引擎')) {
      return (
        opts?.consolidation ??
        `<file name="USER.md">\n- 偏好 pnpm <!-- created=2026-01-01 -->\n</file>\n<file name="MEMORY.md">\n- macOS 环境 <!-- created=2026-01-01 -->\n</file>\n<file name="LESSONS.md">\n- [correction] 不要用 npm <!-- created=2026-01-01 -->\n</file>\n<file name="PROJECT.md">\n- 构建用 vite <!-- created=2026-01-01 -->\n</file>`
      );
    }
    return '';
  };
  return { fn, calls };
}

describe('runExtraction（无会话目录的项目）', () => {
  it('scans zero files gracefully', async () => {
    const { fn } = makeMockComplete();
    const r = await runExtraction('/nonexistent/project/xyz', 'xyz', fn);
    expect(r.scanned).toBe(0);
    expect(r.extracted).toBe(0);
  });
});

describe('needsProcessing', () => {
  it('flags unprocessed and changed files', () => {
    const meta = { path: '/x/a.jsonl', name: 'a.jsonl', mtimeMs: 100, size: 10 };
    expect(needsProcessing(meta, { processed: {}, pendingExtractions: [] })).toBe(true);
    expect(
      needsProcessing(meta, {
        processed: { [watermarkKey(meta)]: { mtimeMs: 100, size: 10, at: 't' } },
        pendingExtractions: []
      })
    ).toBe(false);
    expect(
      needsProcessing(meta, {
        processed: { [watermarkKey(meta)]: { mtimeMs: 200, size: 10, at: 't' } },
        pendingExtractions: []
      })
    ).toBe(true);
  });

  it('上次失败的会话重试（文件没变也不卡死在水位线）', () => {
    const meta = { path: '/x/a.jsonl', name: 'a.jsonl', mtimeMs: 100, size: 10 };
    const processed = {
      [watermarkKey(meta)]: { mtimeMs: 100, size: 10, at: 't', error: 'LLM 调用失败: 400' }
    };
    expect(needsProcessing(meta, { processed, pendingExtractions: [] })).toBe(true);
    // noop 不算待处理（避免反复白跑 LLM）
    const noop = { [watermarkKey(meta)]: { mtimeMs: 100, size: 10, at: 't', noop: true } };
    expect(needsProcessing(meta, { processed: noop, pendingExtractions: [] })).toBe(false);
  });
});

describe('listFailedSessions', () => {
  it('只列带 error 的条目，按失败时间倒序', () => {
    const state = {
      processed: {
        'old.jsonl': { mtimeMs: 1, size: 1, at: '2026-01-01T00:00:00.000Z', error: 'boom' },
        'new.jsonl': { mtimeMs: 1, size: 1, at: '2026-02-01T00:00:00.000Z', error: 'boom2' },
        'ok.jsonl': { mtimeMs: 1, size: 1, at: '2026-03-01T00:00:00.000Z' },
        'noop.jsonl': { mtimeMs: 1, size: 1, at: '2026-04-01T00:00:00.000Z', noop: true }
      },
      pendingExtractions: [] as string[]
    };
    const failed = listFailedSessions(state);
    expect(failed.map((f) => f.name)).toEqual(['new.jsonl', 'old.jsonl']);
    expect(failed[0].error).toBe('boom2');
    expect(listFailedSessions({ processed: {}, pendingExtractions: [] })).toEqual([]);
  });
});

describe('formatExtractionMarkdown', () => {
  it('renders sections', () => {
    const md = formatExtractionMarkdown(
      {
        userPreferences: ['p'],
        lessons: ['[failure] x'],
        globalFacts: [],
        projectKnowledge: ['k'],
        summary: 's',
        noOp: false
      },
      'proj',
      'sess.jsonl'
    );
    expect(md).toContain('### 用户偏好');
    expect(md).toContain('[failure] x');
    expect(md).toContain('project: proj');
  });
});

// ─── Phase 2 ───

describe('runConsolidation', () => {
  it('merges pending extractions into files and clears pending', async () => {
    // 准备 pending extraction
    const extDir = path.join(tmpDir, 'extractions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, '2026-01-01-test.md'),
      '### 测试提取\n- 偏好 pnpm\n',
      'utf-8'
    );
    writeState({
      processed: {},
      pendingExtractions: ['2026-01-01-test.md'],
      extractions: {
        '2026-01-01-test.md': { projectId: 'proj', sourceKey: 'test', at: 't', status: 'pending' }
      },
      stats: { extractions: 0, consolidations: 0 }
    });

    const { fn } = makeMockComplete();
    const r = await runConsolidation('proj', fn);
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(1);
    expect(readMemoryFile('USER.md')).toBe('');
    reviewCandidate(r.candidateId!, 'proj', true);
    expect(readMemoryFile('USER.md')).toContain('pnpm');
    expect(readMemoryFile('project', 'proj')).toContain('vite');
    // pending 清空
    const s = readState();
    expect(s.pendingExtractions).toEqual([]);
    expect(s.lastConsolidation).toBeTruthy();
  });

  it('no-op when nothing pending', async () => {
    const { fn } = makeMockComplete();
    const r = await runConsolidation('proj', fn);
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(0);
  });

  it('reports error when LLM fails', async () => {
    const extDir = path.join(tmpDir, 'extractions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'e.md'), 'x', 'utf-8');
    writeState({
      processed: {},
      pendingExtractions: ['e.md'],
      extractions: { 'e.md': { projectId: 'proj', sourceKey: 'test', at: 't', status: 'pending' } }
    });
    const r = await runConsolidation('proj', async () => {
      throw new Error('api down');
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('api down');
    // pending 保留，可重试
    expect(readState().pendingExtractions).toEqual(['e.md']);
  });

  it('reports error when output unparseable', async () => {
    const extDir = path.join(tmpDir, 'extractions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'e.md'), 'x', 'utf-8');
    writeState({
      processed: {},
      pendingExtractions: ['e.md'],
      extractions: { 'e.md': { projectId: 'proj', sourceKey: 'test', at: 't', status: 'pending' } }
    });
    const r = await runConsolidation('proj', async () => 'garbage output');
    expect(r.ok).toBe(false);
  });
});

describe('listExtractionFiles', () => {
  it('lists sorted md files', () => {
    const extDir = path.join(tmpDir, 'extractions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'b.md'), 'x');
    fs.writeFileSync(path.join(extDir, 'a.md'), 'x');
    fs.writeFileSync(path.join(extDir, 'c.txt'), 'x');
    expect(listExtractionFiles()).toEqual(['a.md', 'b.md']);
  });
});

describe('buildConsolidationUserPrompt', () => {
  it('includes current files and extractions', () => {
    writeMemoryFile('USER.md', '- 旧条目\n');
    const p = buildConsolidationUserPrompt({
      userMd: '- 旧条目\n',
      memoryMd: '',
      lessonsMd: '',
      projectMd: '',
      extractions: [{ file: 'e.md', content: '- 新条目' }],
      projectName: 'demo'
    });
    expect(p).toContain('旧条目');
    expect(p).toContain('新条目');
    expect(p).toContain('demo');
  });
});
