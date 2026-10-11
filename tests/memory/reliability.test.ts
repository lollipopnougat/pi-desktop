import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectIdentity, writeMemoryConfig } from '../../electron/memory/config';
import {
  readState,
  writeState,
  runExtraction,
  runConsolidation,
  pendingForProject
} from '../../electron/memory/pipeline';
import {
  appendEntry,
  removeEntry,
  replaceEntry,
  readMemoryFile,
  readMemorySnapshot,
  writeMemoryFile,
  searchMemory,
  readMemoryEntry,
  memoryTopicIndex
} from '../../electron/memory/store';
import {
  commitMemoryChanges,
  readPersisted,
  listMemoryHistory
} from '../../electron/memory/persistence';
import {
  createCandidate,
  reviewCandidate,
  listCandidates,
  proposeRollback,
  proposeLegacyMigration
} from '../../electron/memory/review';
import { parseSessionTranscript } from '../../electron/memory/session-reader';
import { MemoryController } from '../../electron/memory/controller';

let root: string;
let originalMemoryDir: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-reliability-'));
  originalMemoryDir = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = path.join(root, 'memory');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  if (originalMemoryDir === undefined) delete process.env.PI_MEMORY_DIR;
  else process.env.PI_MEMORY_DIR = originalMemoryDir;
});

const extraction = JSON.stringify({
  userPreferences: [],
  lessons: [],
  globalFacts: [],
  projectKnowledge: ['使用 pnpm'],
  summary: '同一个摘要',
  noOp: false
});
const filesOutput = (project = '- 使用 pnpm', user = '') =>
  `<file name="USER.md">${user}</file><file name="MEMORY.md"></file><file name="LESSONS.md"></file><file name="PROJECT.md">${project}</file>`;
function session(dir: string, name: string, texts: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const rows = texts.map((text, i) => ({
    type: 'message',
    id: `e${i}`,
    parentId: i ? `e${i - 1}` : null,
    timestamp: `2026-10-0${(i % 3) + 1}T00:00:00Z`,
    message: { role: 'user', content: text }
  }));
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}
function seed(projectId: string, id = 'seed.md') {
  const state = readState();
  state.pendingExtractions.push(id);
  state.extractions ||= {};
  state.extractions[id] = { projectId, sourceKey: 'source', at: '2026-10-04', status: 'pending' };
  writeState(state);
  fs.mkdirSync(path.join(process.env.PI_MEMORY_DIR!, 'extractions'), { recursive: true });
  fs.writeFileSync(path.join(process.env.PI_MEMORY_DIR!, 'extractions', id), '- 已提取偏好');
}

describe('项目隔离和旧数据', () => {
  it('同名、中文、不同 worktree 不碰撞，符号链接统一身份', () => {
    const first = path.join(root, '甲', 'app');
    const second = path.join(root, '乙', 'app');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.symlinkSync(first, path.join(root, 'alias'), 'dir');
    expect(projectIdentity(first).id).not.toBe(projectIdentity(second).id);
    expect(projectIdentity(path.join(root, '甲')).id).not.toBe(
      projectIdentity(path.join(root, '乙')).id
    );
    expect(projectIdentity(first).id).toBe(projectIdentity(path.join(root, 'alias')).id);
    expect(projectIdentity(path.join(root, 'worktree-a')).id).not.toBe(
      projectIdentity(path.join(root, 'worktree-b')).id
    );
    writeMemoryFile('project', '- A 的知识', { projectName: projectIdentity(first).id });
    expect(readMemoryFile('project', projectIdentity(second).id)).toBe('');
  });

  it('旧目录不被自动认领，迁移先预览并保留原文件', () => {
    writeMemoryFile('project', '- 旧知识', { projectName: 'app' });
    const project = projectIdentity(path.join(root, 'app'));
    expect(readMemoryFile('project', project.id)).toBe('');
    const candidate = proposeLegacyMigration('app', project);
    expect(readMemoryFile('project', project.id)).toBe('');
    reviewCandidate(candidate.id, project.id, true);
    expect(readMemoryFile('project', project.id)).toContain('旧知识');
    expect(readMemoryFile('project', 'app')).toContain('旧知识');
  });

  it('没有可靠项目标识的旧提取保留待定，不被当前项目消费', async () => {
    writeState({ processed: {}, pendingExtractions: ['legacy.md'] });
    const complete = vi.fn();
    expect((await runConsolidation('current', complete)).merged).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(readState().pendingExtractions).toEqual(['legacy.md']);
  });

  it('A/B 交错提取只合并各自数据，同名会话有独立水位', async () => {
    const a = path.join(root, 'a', 'app');
    const b = path.join(root, 'b', 'app');
    const aId = projectIdentity(a).id;
    const bId = projectIdentity(b).id;
    const aDir = path.join(root, 'sessions-a');
    const bDir = path.join(root, 'sessions-b');
    session(aDir, 'same.jsonl', ['A 偏好']);
    session(bDir, 'same.jsonl', ['B 偏好']);
    await runExtraction(a, 'app', async () => extraction, undefined, { sessionDir: aDir });
    await runExtraction(b, 'app', async () => extraction, undefined, { sessionDir: bDir });
    expect(Object.keys(readState().processed)).toHaveLength(2);
    const c = await runConsolidation(bId, async (_s, input) => {
      const aSource = pendingForProject(readState(), aId)[0];
      expect(input).not.toContain(aSource);
      return filesOutput('- B 的知识');
    });
    reviewCandidate(c.candidateId!, bId, true);
    expect(pendingForProject(readState(), aId)).toHaveLength(1);
    expect(pendingForProject(readState(), bId)).toHaveLength(0);
    expect(readMemoryFile('project', aId)).toBe('');
    expect(readMemoryFile('project', bId)).toContain('B 的知识');
  });
});

describe('增量、来源与取消', () => {
  it('同秒同摘要的不同会话不会覆盖；已合并提取不重新入队', async () => {
    const cwd = path.join(root, 'app');
    const projectId = projectIdentity(cwd).id;
    const dir = path.join(root, 'sessions');
    session(dir, 'one.jsonl', ['偏好一']);
    session(dir, 'two.jsonl', ['偏好二']);
    await runExtraction(cwd, 'app', async () => extraction, undefined, { sessionDir: dir });
    expect(readState().pendingExtractions).toHaveLength(2);
    const initial = [...readState().pendingExtractions];
    const merge = await runConsolidation(projectId, async () => filesOutput());
    reviewCandidate(merge.candidateId!, projectId, true);
    session(dir, 'three.jsonl', ['新的偏好']);
    await runExtraction(cwd, 'app', async () => extraction, undefined, { sessionDir: dir });
    expect(readState().pendingExtractions).toHaveLength(1);
    expect(readState().pendingExtractions.some((id) => initial.includes(id))).toBe(false);
    expect(fs.readdirSync(path.join(process.env.PI_MEMORY_DIR!, 'extractions'))).toHaveLength(3);
  });

  it('超过旧上限的会话仍覆盖末尾纠正，后续只提取新增内容', async () => {
    const dir = path.join(root, 'sessions');
    const cwd = path.join(root, 'app');
    const texts = Array.from({ length: 12 }, (_, i) => `信息${i}:` + '内容'.repeat(7000));
    texts.push('最终纠正：请使用 yarn');
    session(dir, 'long.jsonl', texts);
    const calls: string[] = [];
    await runExtraction(
      cwd,
      'app',
      async (_s, u) => {
        calls.push(u);
        return extraction;
      },
      undefined,
      { sessionDir: dir }
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.join('\n')).toContain('最终纠正：请使用 yarn');
    expect(calls.every((c) => c.length < 26000)).toBe(true);
    calls.length = 0;
    session(dir, 'long.jsonl', [...texts, '增量：现在换成 pnpm']);
    await runExtraction(
      cwd,
      'app',
      async (_s, u) => {
        calls.push(u);
        return extraction;
      },
      undefined,
      { sessionDir: dir }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('增量');
    expect(calls[0]).not.toContain('信息0:');
  });

  it('失败块不推进水位，重试跳过之前成功的块', async () => {
    const dir = path.join(root, 'sessions');
    const cwd = path.join(root, 'app');
    session(dir, 'long.jsonl', ['前半段' + 'a'.repeat(17000), '后半段' + 'b'.repeat(17000)]);
    let calls = 0;
    const first = await runExtraction(
      cwd,
      'app',
      async () => {
        if (++calls === 2) throw new Error('网络失败');
        return extraction;
      },
      undefined,
      { sessionDir: dir }
    );
    expect(first.failed).toBe(1);
    const seen = Object.values(readState().processed)[0].seen!;
    expect(seen.length).toBeGreaterThan(0);
    const pending = [...readState().pendingExtractions];
    const retry = vi.fn(async (_s: string, input: string) => {
      expect(input).not.toContain('前半段');
      return extraction;
    });
    await runExtraction(cwd, 'app', retry, undefined, { sessionDir: dir });
    expect(retry).toHaveBeenCalledOnce();
    expect(readState().pendingExtractions.slice(0, pending.length)).toEqual(pending);
    expect(Object.values(readState().processed)[0].error).toBeUndefined();
  });

  it('只提取当前分支，并保留工具失败证据', () => {
    const dir = path.join(root, 'sessions');
    session(dir, 'tree.jsonl', []);
    const file = path.join(dir, 'tree.jsonl');
    fs.writeFileSync(
      file,
      [
        { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: '开始' } },
        {
          type: 'message',
          id: 'abandoned',
          parentId: 'u',
          message: { role: 'assistant', content: '被放弃的方案' }
        },
        {
          type: 'message',
          id: 'current',
          parentId: 'u',
          message: { role: 'user', content: '改用这个方案' }
        },
        {
          type: 'message',
          id: 'result',
          parentId: 'current',
          message: { role: 'toolResult', toolName: 'bash', isError: true, content: '命令失败' }
        }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    );
    const parsed = parseSessionTranscript(file, Infinity);
    expect(parsed.lines.map((l) => l.entryId)).toEqual(['u', 'current', 'result']);
    expect(parsed.lines.at(-1)?.text).toContain('失败');
  });

  it('来源包含会话、entry、原始时间，输入与来源都脱敏', async () => {
    const cwd = path.join(root, 'app');
    const projectId = projectIdentity(cwd).id;
    const dir = path.join(root, 'sessions');
    session(dir, 'source.jsonl', ['请记住 pnpm，密钥 sk-abcdefghijklmnopqrst1234']);
    await runExtraction(
      cwd,
      'app',
      async (_s, u) => {
        expect(u).not.toContain('sk-');
        return extraction;
      },
      undefined,
      { sessionDir: dir }
    );
    const c = await runConsolidation(projectId, async () => filesOutput());
    reviewCandidate(c.candidateId!, projectId, true);
    const hit = searchMemory('pnpm', projectId)[0];
    const entry = readMemoryEntry(hit.id, projectId)!;
    expect(entry.sources[0].session).toBe('source.jsonl');
    expect(entry.sources[0].entryIds).toEqual(['e0']);
    expect(entry.sources[0].sourceTime).toBe('2026-10-01T00:00:00Z');
    expect(entry.sources[0].content).not.toContain('sk-');
    expect(entry.status).toBe('unverified');
  });

  it('提取模型等待期间取消后不写入文件或水位', async () => {
    const dir = path.join(root, 'sessions');
    session(dir, 'one.jsonl', ['请记住']);
    const abort = new AbortController();
    let finish!: (value: string) => void;
    const task = runExtraction(
      root,
      'app',
      () =>
        new Promise((r) => {
          finish = r;
        }),
      undefined,
      { sessionDir: dir, signal: abort.signal }
    );
    abort.abort(new Error('取消'));
    finish(extraction);
    await expect(task).rejects.toThrow('取消');
    expect(readState().pendingExtractions).toEqual([]);
    expect(readState().processed).toEqual({});
  });
});

describe('审核、并发与恢复', () => {
  it('模型等待时新增记忆不会被覆盖，过期候选可重新生成', async () => {
    seed('p');
    let finish!: (value: string) => void;
    const task = runConsolidation(
      'p',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    appendEntry('USER.md', '等待期间保存的偏好');
    seed('other', 'new.md');
    finish(filesOutput());
    const result = await task;
    expect(() => reviewCandidate(result.candidateId!, 'p', true)).toThrow('版本冲突');
    expect(readMemoryFile('USER.md')).toContain('等待期间保存');
    const fresh = await runConsolidation('p', async () =>
      filesOutput('- 新知识', readMemoryFile('USER.md'))
    );
    expect(fresh.candidateId).toBeTruthy();
    expect(listCandidates('p')).toHaveLength(1);
    reviewCandidate(fresh.candidateId!, 'p', true);
    expect(readMemoryFile('USER.md')).toContain('等待期间保存');
    expect(readState().pendingExtractions).toEqual(['new.md']);
  });

  it('人工编辑使用 revision，冲突时不丢其他更新', () => {
    writeMemoryFile('USER.md', '- 原偏好');
    const snapshot = readMemorySnapshot('USER.md');
    appendEntry('USER.md', '并发偏好');
    expect(() =>
      writeMemoryFile('USER.md', '- 编辑内容', { baseRevision: snapshot.revision })
    ).toThrow('版本冲突');
    expect(readMemoryFile('USER.md')).toContain('并发偏好');
  });

  it('拒绝候选只消费当前批次，不能从其他项目审核', async () => {
    seed('p');
    seed('other', 'other.md');
    const result = await runConsolidation('p', async () => filesOutput());
    expect(() => reviewCandidate(result.candidateId!, 'other', true)).toThrow('项目');
    reviewCandidate(result.candidateId!, 'p', false);
    expect(readMemoryFile('project', 'p')).toBe('');
    expect(readState().extractions?.['seed.md'].status).toBe('rejected');
    expect(readState().pendingExtractions).toEqual(['other.md']);
  });

  it('双向脱敏，模型异常大幅删除在审核中标记', async () => {
    seed('p');
    writeMemoryFile('USER.md', '- 原偏好');
    // 合成外部编辑的密钥，用于验证合并输入边界。
    fs.appendFileSync(
      path.join(process.env.PI_MEMORY_DIR!, 'USER.md'),
      '\n- sk-abcdefghijklmnopqrst1234'
    );
    const result = await runConsolidation('p', async (_s, u) => {
      expect(u).not.toContain('sk-abcdefghijklmnopqrst1234');
      return filesOutput('- 密钥 sk-abcdefghijklmnopqrst1234');
    });
    expect(listCandidates('p')[0].warnings).toContain('USER.md');
    reviewCandidate(result.candidateId!, 'p', true);
    expect(readMemoryFile('project', 'p')).not.toContain('sk-');
    expect(readMemoryFile('project', 'p')).toContain('[REDACTED]');
    const candidatePath = path.join(
      process.env.PI_MEMORY_DIR!,
      'candidates',
      result.candidateId! + '.json'
    );
    expect(fs.readFileSync(candidatePath, 'utf8')).not.toContain('sk-abcdefghijklmnopqrst1234');
    expect(JSON.stringify(listMemoryHistory('p'))).not.toContain('sk-abcdefghijklmnopqrst1234');
  });

  it('半途提交中断后恢复所有文件，随后保留可回滚历史', () => {
    const original = fs.renameSync;
    let interrupted = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('LESSONS.md') && !interrupted) {
        interrupted = true;
        throw new Error('模拟崩溃');
      }
      original(from, to);
    });
    expect(() =>
      commitMemoryChanges(
        [
          { file: 'USER.md', before: '', after: '- 一' },
          { file: 'LESSONS.md', before: '', after: '- 二' },
          { file: 'state.json', before: '', after: '{"processed":{},"pendingExtractions":[]}' }
        ],
        'test',
        'p'
      )
    ).toThrow('模拟崩溃');
    vi.restoreAllMocks();
    expect(readMemoryFile('LESSONS.md')).toBe('- 二');
    expect(readMemoryFile('USER.md')).toBe('- 一');
    expect(readState().pendingExtractions).toEqual([]);
    expect(fs.readdirSync(path.join(process.env.PI_MEMORY_DIR!, 'transactions'))).toEqual([]);
    expect(listMemoryHistory('p')).toHaveLength(1);
  });

  it('恢复日志遇到外部编辑时停止，不覆盖外部内容', () => {
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('LESSONS.md')) throw new Error('中断');
      original(from, to);
    });
    expect(() =>
      commitMemoryChanges([{ file: 'LESSONS.md', before: '', after: '- 候选' }], 'test')
    ).toThrow('中断');
    vi.restoreAllMocks();
    fs.writeFileSync(path.join(process.env.PI_MEMORY_DIR!, 'LESSONS.md'), '- 外部编辑');
    expect(() => readMemoryFile('LESSONS.md')).toThrow('恢复冲突');
    expect(fs.readFileSync(path.join(process.env.PI_MEMORY_DIR!, 'LESSONS.md'), 'utf8')).toBe(
      '- 外部编辑'
    );
  });

  it('删除留存 tombstone，旧同文提取不能复活，显式回滚可恢复', async () => {
    writeMemoryFile('project', '- 已过时事实', { projectName: 'p' });
    removeEntry('project', '已过时事实', { projectName: 'p' });
    const deletion = listMemoryHistory('p')[0];
    seed('p');
    const c = await runConsolidation('p', async () => filesOutput('- 已过时事实'));
    reviewCandidate(c.candidateId!, 'p', true);
    expect(readMemoryFile('project', 'p')).not.toContain('已过时事实');
    expect(appendEntry('project', '已过时事实', { projectName: 'p' }).ok).toBe(false);
    const rollback = proposeRollback(deletion.id, 'p');
    expect(readMemoryFile('project', 'p')).not.toContain('已过时事实');
    reviewCandidate(rollback.id, 'p', true);
    expect(readMemoryFile('project', 'p')).toContain('已过时事实');
  });

  it('纠正候选后提交用户文本，且 category 去重与非法更新有效', () => {
    const c = createCandidate(
      'p',
      [{ file: 'USER.md', before: '', after: '- 错误偏好' }],
      [],
      'tool'
    );
    reviewCandidate(c.id, 'p', true, { 'USER.md': '- 正确偏好' });
    expect(readMemoryFile('USER.md')).toContain('正确偏好');
    expect(readMemoryFile('USER.md')).not.toContain('错误偏好');
    expect(appendEntry('LESSONS.md', '相同教训', { category: 'failure' }).ok).toBe(true);
    expect(appendEntry('LESSONS.md', '相同教训', { category: 'failure' }).ok).toBe(false);
    expect(replaceEntry('LESSONS.md', '教训', '两\n行').ok).toBe(false);
    expect(replaceEntry('LESSONS.md', '教训', '').ok).toBe(false);
  });

  it('不允许通过内部符号链接逃逸记忆目录', () => {
    fs.mkdirSync(process.env.PI_MEMORY_DIR!, { recursive: true });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(process.env.PI_MEMORY_DIR!, 'projects'), 'dir');
    expect(() => writeMemoryFile('project', '- 不能写', { projectName: 'p' })).toThrow('符号链接');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('检索与任务生命周期', () => {
  it('项目命中排在大量全局命中之前，支持多关键词、scope、分页、稳定 id', () => {
    writeMemoryFile(
      'MEMORY.md',
      Array.from({ length: 40 }, (_, i) => `- pnpm 全局 ${i}`).join('\n')
    );
    writeMemoryFile('project', '- pnpm 构建', { projectName: 'p' });
    const all = searchMemory('pnpm 构建', 'p', { limit: 30 });
    expect(all[0].scope).toBe('project');
    const id = all[0].id;
    appendEntry('project', '新知识', { projectName: 'p' });
    expect(searchMemory('构建', 'p')[0].id).toBe(id);
    expect(searchMemory('pnpm', 'p', { scope: 'project' })).toHaveLength(1);
    expect(searchMemory('pnpm', 'p', { scope: 'global', cursor: 30, limit: 30 })).toHaveLength(10);
    expect(memoryTopicIndex('p')).toContain('pnpm 构建');
    expect(readMemoryEntry(id, 'other')).toBeNull();
  });

  it.each(['cancel', 'disable', 'dispose', 'switch'] as const)(
    '%s 中断模型，互斥任务且迟到结果不落盘',
    async (action) => {
      const bridge = {
        cwd: root,
        win: { webContents: { send: vi.fn() } },
        getSession: () => ({ model: { provider: 'test', id: 'test' } }),
        modelRuntime: { completeSimple: vi.fn() }
      };
      const controller = new MemoryController(bridge as never);
      seed(controller.getProjectId());
      let finish!: (value: unknown) => void;
      bridge.modelRuntime.completeSimple.mockImplementation(
        () =>
          new Promise((r) => {
            finish = r;
          })
      );
      const task = controller.triggerConsolidation();
      expect((await controller.triggerExtraction()).ok).toBe(false);
      if (action === 'cancel') controller.cancel();
      else if (action === 'disable') controller.setConfig({ enabled: false });
      else if (action === 'dispose') await controller.dispose();
      else {
        bridge.cwd = path.join(root, 'other');
        controller.onSessionSwitch();
      }
      expect((await task).ok).toBe(false);
      finish({ content: [{ type: 'text', text: filesOutput() }], stopReason: 'stop' });
      await Promise.resolve();
      expect(listCandidates(projectIdentity(root).id)).toEqual([]);
      expect(readState().pendingExtractions).toEqual(['seed.md']);
      expect(controller.isBusy()).toEqual({ extracting: false, consolidating: false });
      const progress = bridge.win.webContents.send.mock.calls[0][1];
      expect(progress.projectId).toBe(projectIdentity(root).id);
      expect(progress.jobId).toBeTruthy();
    }
  );

  it('非法配置回落到有界值，模型输出被截断时拒绝入库', async () => {
    const cfg = writeMemoryConfig({ userProfileCharLimit: Infinity, consolidateThreshold: NaN });
    expect(cfg.userProfileCharLimit).toBe(4000);
    expect(cfg.consolidateThreshold).toBe(5);
    const bridge = {
      cwd: root,
      getSession: () => ({ model: {} }),
      modelRuntime: {
        completeSimple: async () => ({
          stopReason: 'length',
          content: [{ type: 'text', text: filesOutput() }]
        })
      }
    };
    const controller = new MemoryController(bridge as never);
    await expect(controller.makeCompleteFn()('system', 'user')).rejects.toThrow('LLM');
    expect(readPersisted('state.json')).toBe('');
  });
});
