import { describe, expect, it } from 'vitest';
import { createTwoFilesPatch } from 'diff';
import { buildChatItems, groupChatItemsByTurn } from '../../src/components/chat/chat-items';
import { countPatchChanges, reconstructFromPatch, revertPatch } from '../../src/lib/patch-utils';
import {
  aggregateTurnChanges,
  changeSignature,
  collectToolCallChanges,
  relativeToCwd,
  shortHash,
  splitDisplayPath
} from '../../src/lib/turn-changes';
import { resolveTurnFileDiff } from '../../src/lib/turn-diff';

const patchOf = (before: string, after: string, path = 'src/a.ts') =>
  createTwoFilesPatch(path, path, before, after, '', '', { context: 3 });

const editPatch = patchOf('one\ntwo\nthree\n', 'one\nTWO\nthree\n');

/** 造一条带工具调用的 assistant 消息 */
const assistantWithTool = (id: string, name: string, args: Record<string, unknown>) => ({
  role: 'assistant',
  timestamp: 1,
  content: [{ type: 'toolCall', id, name, arguments: args }]
});

const toolResult = (id: string, details?: unknown, isError = false) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'edit',
  content: [{ type: 'text', text: 'ok' }],
  details,
  isError,
  timestamp: 2
});

describe('patch 工具函数', () => {
  it('统计 +/- 行数时跳过文件头', () => {
    expect(countPatchChanges(editPatch)).toEqual({ additions: 1, deletions: 1 });
  });

  it('只有 patch 时重建改动区域片段', () => {
    const { original, modified } = reconstructFromPatch(editPatch);
    expect(original).toContain('two');
    expect(modified).toContain('TWO');
  });

  it('反向应用 patch 还原改动前内容，内容不匹配时返回 null', () => {
    const before = 'one\ntwo\nthree\n';
    const after = 'one\nTWO\nthree\nfour\n';
    const patch = patchOf(before, after);
    expect(revertPatch(after, patch)).toBe(before);
    expect(revertPatch('完全不相关的内容\n', patch)).toBeNull();
  });
});

describe('从消息收集文件改动', () => {
  it('edit 取工具结果里的 patch，并记录路径与统计', () => {
    const changes = collectToolCallChanges([
      assistantWithTool('t1', 'edit', { path: 'src/a.ts', edits: [] }),
      toolResult('t1', { patch: editPatch })
    ]);
    expect(changes.get('t1')).toEqual({
      path: 'src/a.ts',
      patches: [editPatch],
      additions: 1,
      deletions: 1,
      kind: 'edit'
    });
  });

  it('write 用入参内容合成整文件 patch（新建文件完全准确）', () => {
    const changes = collectToolCallChanges([
      assistantWithTool('t2', 'write', { path: 'src/new.ts', content: 'a\nb\nc' }),
      toolResult('t2')
    ]);
    const change = changes.get('t2');
    expect(change?.kind).toBe('write');
    expect(change?.additions).toBe(3);
    expect(change?.deletions).toBe(0);
    expect(change?.patches[0]).toContain('+a');
  });

  it('失败结果、未知工具、缺 patch 的 edit 都不产生改动', () => {
    const changes = collectToolCallChanges([
      assistantWithTool('e1', 'edit', { path: 'src/a.ts' }),
      toolResult('e1', { patch: editPatch }, true),
      assistantWithTool('b1', 'bash', { command: 'rm x' }),
      toolResult('b1'),
      assistantWithTool('e2', 'edit', { path: 'src/a.ts' }),
      toolResult('e2', {}),
      assistantWithTool('w1', 'write', { path: 'src/a.ts' }),
      toolResult('w1')
    ]);
    expect(changes.size).toBe(0);
  });

  it('同一文件多次改动按文件聚合，统计累加', () => {
    const aggregated = aggregateTurnChanges([
      { path: 'src/a.ts', patches: [editPatch], additions: 1, deletions: 1, kind: 'edit' },
      { path: 'src/a.ts', patches: [editPatch], additions: 2, deletions: 0, kind: 'write' },
      { path: 'src/b.ts', patches: ['p'], additions: 5, deletions: 5, kind: 'write' }
    ]);
    expect(aggregated?.files).toHaveLength(2);
    expect(aggregated?.files[0]).toMatchObject({
      path: 'src/a.ts',
      additions: 3,
      deletions: 1,
      // 只要有一次精确 edit，就不是「整文件写入」
      kind: 'edit'
    });
    expect(aggregated?.files[0].patches).toHaveLength(2);
    expect(aggregated?.additions).toBe(8);
    expect(aggregated?.deletions).toBe(6);
    expect(aggregateTurnChanges([])).toBeUndefined();
  });
});

describe('按轮挂载改动', () => {
  it('改动只挂到发起该工具调用的那一轮', () => {
    const messages: any[] = [
      { role: 'user', timestamp: 10, content: '第一轮' },
      assistantWithTool('a1', 'read', { path: 'src/a.ts' }),
      toolResult('a1', {}),
      { role: 'user', timestamp: 20, content: '第二轮' },
      assistantWithTool('e1', 'edit', { path: 'src/a.ts' }),
      toolResult('e1', { patch: editPatch })
    ];
    const turns = groupChatItemsByTurn(
      buildChatItems(messages, null),
      collectToolCallChanges(messages)
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].changes).toBeUndefined();
    expect(turns[1].changes?.files[0]).toMatchObject({ path: 'src/a.ts', additions: 1 });
  });

  it('不传改动表时不挂载任何改动（流式期间的快速路径）', () => {
    const turns = groupChatItemsByTurn(
      buildChatItems([{ role: 'user', timestamp: 1, content: 'hi' }], null)
    );
    expect(turns.every((turn) => turn.changes === undefined)).toBe(true);
  });
});

describe('展示路径与 id', () => {
  it('项目内路径转成相对 cwd，项目外保持原样', () => {
    expect(relativeToCwd('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(relativeToCwd('/repo/src/a.ts', '/repo/')).toBe('src/a.ts');
    expect(relativeToCwd('/other/src/a.ts', '/repo')).toBe('/other/src/a.ts');
    expect(relativeToCwd('src\\a.ts', null)).toBe('src/a.ts');
  });

  it('拆分目录与文件名', () => {
    expect(splitDisplayPath('src/components/a.tsx')).toEqual({
      dir: 'src/components/',
      name: 'a.tsx'
    });
    expect(splitDisplayPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });

  it('同一文件同一轮改动得到相同签名，统计变化后签名不同', () => {
    const change = {
      path: 'src/a.ts',
      patches: ['p'],
      additions: 1,
      deletions: 1,
      kind: 'edit' as const
    };
    expect(changeSignature(change)).toBe(changeSignature({ ...change }));
    expect(changeSignature(change)).not.toBe(changeSignature({ ...change, additions: 2 }));
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});

describe('还原本轮改动的完整前后内容', () => {
  it('从当前文件内容倒序反应用 patch', async () => {
    const first = patchOf('a\nb\nc\n', 'a\nB\nc\n');
    const second = patchOf('a\nB\nc\n', 'a\nB\nC\nd\n');
    const resolved = await resolveTurnFileDiff(
      { path: 'f.ts', patches: [first, second], additions: 2, deletions: 2, kind: 'edit' },
      async () => 'a\nB\nC\nd\n'
    );
    expect(resolved).toEqual({ original: 'a\nb\nc\n', modified: 'a\nB\nC\nd\n' });
  });

  it('读不到当前文件时返回 null，交给 patch 片段渲染', async () => {
    const resolved = await resolveTurnFileDiff(
      { path: 'f.ts', patches: [editPatch], additions: 1, deletions: 1, kind: 'edit' },
      async () => {
        throw new Error('ENOENT');
      }
    );
    expect(resolved).toBeNull();
  });

  it('patch 应用不上（文件被后续改动覆盖）时返回 null', async () => {
    const resolved = await resolveTurnFileDiff(
      { path: 'f.ts', patches: [editPatch], additions: 1, deletions: 1, kind: 'edit' },
      async () => '完全不一样的内容\n'
    );
    expect(resolved).toBeNull();
  });

  it('write 按整文件新增展示', async () => {
    const resolved = await resolveTurnFileDiff(
      { path: 'f.ts', patches: ['x'], additions: 2, deletions: 0, kind: 'write' },
      async () => 'brand new\nfile\n'
    );
    expect(resolved).toEqual({ original: '', modified: 'brand new\nfile\n' });
  });
});
