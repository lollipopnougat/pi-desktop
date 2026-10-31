import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMemoryTools } from '../../electron/memory/tools';
import { readMemoryFile, writeMemoryFile } from '../../electron/memory/store';
import { readMemoryConfig, writeMemoryConfig } from '../../electron/memory/config';
import { listCandidates, reviewCandidate } from '../../electron/memory/review';

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-tools-'));
  previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = root;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_MEMORY_DIR;
  else process.env.PI_MEMORY_DIR = previous;
});
function tools() {
  return createMemoryTools({
    getProjectName: () => 'project-a',
    isEnabled: () => readMemoryConfig().enabled
  });
}
const execute = (
  tool: ReturnType<typeof tools>[keyof ReturnType<typeof tools>],
  params: Record<string, unknown>
) => tool.execute('test', params as never, undefined as never, undefined as never, {} as never);

describe('记忆工具写入策略', () => {
  it('默认延续直接保存，但关闭开关后拒绝写入和读取', async () => {
    const t = tools();
    await execute(t.memorySaveTool, { target: 'project', content: '使用 pnpm' });
    expect(readMemoryFile('project', 'project-a')).toContain('pnpm');
    writeMemoryConfig({ enabled: false });
    await execute(t.memoryRemoveTool, { target: 'project', old_text: 'pnpm' });
    expect(readMemoryFile('project', 'project-a')).toContain('pnpm');
    expect(JSON.stringify(await execute(t.memorySearchTool, { query: 'pnpm' }))).toContain(
      '已禁用'
    );
    expect(JSON.stringify(await execute(t.memoryReadTool, { id: 'any' }))).toContain('已禁用');
  });

  it.each(['save', 'update', 'remove'] as const)(
    'review 模式下 %s 只能生成候选',
    async (operation) => {
      writeMemoryFile('project', '- 旧知识', { projectName: 'project-a' });
      const before = readMemoryFile('project', 'project-a');
      writeMemoryConfig({ writePolicy: 'review' });
      const t = tools();
      const tool =
        operation === 'save'
          ? t.memorySaveTool
          : operation === 'update'
            ? t.memoryUpdateTool
            : t.memoryRemoveTool;
      await execute(tool, { target: 'project', content: '新知识', old_text: '旧知识' });
      expect(readMemoryFile('project', 'project-a')).toBe(before);
      const candidates = listCandidates('project-a');
      expect(candidates).toHaveLength(1);
      reviewCandidate(candidates[0].id, 'project-a', true);
      if (operation !== 'save')
        expect(readMemoryFile('project', 'project-a')).not.toContain('旧知识');
      if (operation !== 'remove')
        expect(readMemoryFile('project', 'project-a')).toContain('新知识');
    }
  );

  it.each(['save', 'update', 'remove'] as const)(
    'explicit 模式下 %s 要求本轮用户原话',
    async (operation) => {
      writeMemoryFile('project', '- 旧知识', { projectName: 'project-a' });
      const before = readMemoryFile('project', 'project-a');
      writeMemoryConfig({ writePolicy: 'explicit' });
      const t = tools();
      const tool =
        operation === 'save'
          ? t.memorySaveTool
          : operation === 'update'
            ? t.memoryUpdateTool
            : t.memoryRemoveTool;
      await execute(tool, { target: 'project', content: '新知识', old_text: '旧知识' });
      expect(readMemoryFile('project', 'project-a')).toBe(before);
      await execute(tool, {
        target: 'project',
        content: '新知识',
        old_text: '旧知识',
        explicit_request: '请更新这条记忆'
      });
      expect(readMemoryFile('project', 'project-a')).not.toBe(before);
    }
  );

  it('review 模式拒绝多行或重复条目', async () => {
    writeMemoryConfig({ writePolicy: 'review' });
    writeMemoryFile('USER.md', '- 相同条目');
    await execute(tools().memorySaveTool, { target: 'user', content: '相同条目' });
    await execute(tools().memorySaveTool, { target: 'user', content: '一\n二' });
    expect(listCandidates('project-a')).toEqual([]);
  });
});

describe('会话检索工具', () => {
  const textOf = (result: { content: { type: string; text?: string }[] }) =>
    result.content.map((part) => part.text || '').join('\n');

  it('disabled 时拒绝', async () => {
    writeMemoryConfig({ enabled: false });
    const t = tools();
    const searched = await execute(t.sessionSearchTool, { query: 'anything' });
    expect(textOf(searched as never)).toContain('已禁用');
    const read = await execute(t.sessionReadTool, { session: 'x' });
    expect(textOf(read as never)).toContain('已禁用');
  });

  it('没有会话文件时给出空结果提示', async () => {
    const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-sessions-'));
    const previousSessions = process.env.PI_SESSIONS_DIR;
    process.env.PI_SESSIONS_DIR = sessions;
    try {
      const { resetSessionIndexStateForTests } =
        await import('../../electron/memory/session-index');
      resetSessionIndexStateForTests();
      const t = tools();
      const result = await execute(t.sessionSearchTool, { query: 'anything at all' });
      expect(textOf(result as never)).toContain('没有匹配');
      const read = await execute(t.sessionReadTool, { session: 'missing' });
      expect(textOf(read as never)).toContain('未找到该会话');
    } finally {
      fs.rmSync(sessions, { recursive: true, force: true });
      if (previousSessions === undefined) delete process.env.PI_SESSIONS_DIR;
      else process.env.PI_SESSIONS_DIR = previousSessions;
    }
  });
});
