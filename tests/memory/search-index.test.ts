import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-index-'));
  process.env.PI_MEMORY_DIR = tmpDir;
  resetMemoryIndexStateForTests();
});
afterEach(() => {
  resetMemoryIndexStateForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_MEMORY_DIR;
});

import {
  closeMemoryIndex,
  listIndexableDocs,
  memoryIndexStats,
  rebuildMemoryIndex,
  resetMemoryIndexStateForTests,
  searchIndexedMemories,
  syncMemoryIndex
} from '../../electron/memory/search-index';
import { appendEntry, writeMemoryFile } from '../../electron/memory/store';

function seed() {
  writeMemoryFile('USER.md', '- 用户偏好中文注释\n- 固定用 pnpm install 安装依赖\n', {
    source: 'manual'
  });
  writeMemoryFile('MEMORY.md', '- 会话槽是多会话并发的核心结构\n- 体素引擎要用网格 + AO 面剔除\n', {
    source: 'manual'
  });
  writeMemoryFile('LESSONS.md', '- 不要在 Windows 用 process.env.HOME 拼路径\n', {
    source: 'manual'
  });
}

function seedProject(projectId: string, text: string) {
  fs.mkdirSync(path.join(tmpDir, 'projects', projectId), { recursive: true });
  writeMemoryFile('project', `- ${text}\n`, { source: 'manual', projectName: projectId });
}

describe('listIndexableDocs', () => {
  it('全局四个文件总是列出，项目记忆按磁盘扫描', () => {
    seedProject('p-abc', '项目里用 vite 构建');
    const docs = listIndexableDocs();
    expect(docs.map((d) => d.file)).toEqual([
      'USER.md',
      'MEMORY.md',
      'LESSONS.md',
      'STANDING.md',
      'projects/p-abc/MEMORY.md'
    ]);
    expect(docs[4]).toMatchObject({ scope: 'project', project: 'p-abc' });
  });
});

describe('searchIndexedMemories', () => {
  it('索引文件里的条目命中中文三字词', () => {
    seed();
    syncMemoryIndex(true);
    const hits = searchIndexedMemories('会话槽')!;
    expect(hits).not.toBeNull();
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('会话槽');
    expect(hits[0].file).toBe('MEMORY.md');
    expect(hits[0].scope).toBe('global');
  });

  it('两个字的词走 LIKE 兜底也能命中', () => {
    seed();
    syncMemoryIndex(true);
    const hits = searchIndexedMemories('体素')!;
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('体素引擎');
  });

  it('英文与项目作用域过滤', () => {
    seed();
    seedProject('p-abc', '项目里用 pnpm 构建前端');
    syncMemoryIndex(true);
    // 不传项目时只检索全局记忆
    expect(searchIndexedMemories('pnpm')!.length).toBe(1);
    expect(searchIndexedMemories('pnpm', 'p-abc')!.length).toBe(2);
    const projectOnly = searchIndexedMemories('pnpm', 'p-abc', { scope: 'project' })!;
    expect(projectOnly.length).toBe(1);
    expect(projectOnly[0].scope).toBe('project');
    expect(searchIndexedMemories('pnpm', undefined, { scope: 'global' })!.length).toBe(1);
  });

  it('all 作用域只返回当前项目的项目条目 + 全部全局条目', () => {
    seed();
    seedProject('p-abc', '项目里用 pnpm 构建前端');
    seedProject('p-other', '另一个项目也用 pnpm');
    syncMemoryIndex(true);
    const hits = searchIndexedMemories('pnpm', 'p-abc')!;
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.scope === 'global' || h.file.includes('p-abc'))).toBe(true);
  });

  it('项目条目排在全局条目之前（作用域加分）', () => {
    writeMemoryFile('MEMORY.md', '- 构建脚本统一放在 scripts 目录\n', { source: 'manual' });
    seedProject('p-abc', '构建脚本统一放在 scripts 目录');
    syncMemoryIndex(true);
    const hits = searchIndexedMemories('scripts', 'p-abc')!;
    expect(hits.length).toBe(2);
    expect(hits[0].scope).toBe('project');
  });

  it('没有命中返回空数组（而不是 null）', () => {
    seed();
    const hits = searchIndexedMemories('完全不存在的词');
    expect(hits).toEqual([]);
  });

  it('空查询返回空数组', () => {
    seed();
    expect(searchIndexedMemories('   ')).toEqual([]);
  });

  it('分页：limit + cursor', () => {
    writeMemoryFile(
      'MEMORY.md',
      '- 检索分页测试 alpha\n- 检索分页测试 beta\n- 检索分页测试 gamma\n',
      {
        source: 'manual'
      }
    );
    syncMemoryIndex(true);
    const first = searchIndexedMemories('检索分页测试', undefined, { limit: 2 })!;
    const second = searchIndexedMemories('检索分页测试', undefined, {
      limit: 2,
      cursor: 2
    })!;
    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
    expect(new Set([...first, ...second].map((h) => h.id)).size).toBe(3);
  });

  it('索引文件变化后增量同步（不需要手动重建）', () => {
    seed();
    expect(searchIndexedMemories('新的记忆条目')!).toEqual([]);
    appendEntry('MEMORY.md', '新的记忆条目内容');
    // 增量同步节流：直接强制同步模拟下一次检索
    syncMemoryIndex();
    const hits = searchIndexedMemories('新的记忆条目')!;
    expect(hits.length).toBe(1);
  });

  it('删除文件后残留条目被清理', () => {
    seedProject('p-abc', '临时项目记忆会被删掉');
    syncMemoryIndex(true);
    expect(searchIndexedMemories('临时项目记忆', 'p-abc')!.length).toBe(1);
    fs.rmSync(path.join(tmpDir, 'projects', 'p-abc'), { recursive: true, force: true });
    syncMemoryIndex(true);
    expect(searchIndexedMemories('临时项目记忆', 'p-abc')!).toEqual([]);
  });

  it('命中后记录使用度（usage 表）', () => {
    seed();
    syncMemoryIndex(true);
    searchIndexedMemories('会话槽');
    searchIndexedMemories('会话槽');
    expect(memoryIndexStats().usageEntries).toBe(1);
  });
});

describe('memoryIndexStats / rebuildMemoryIndex', () => {
  it('统计条目数与文件数', () => {
    seed();
    seedProject('p-abc', '项目条目');
    syncMemoryIndex(true);
    const stats = memoryIndexStats();
    expect(stats.available).toBe(true);
    expect(stats.files).toBe(5);
    expect(stats.entries).toBe(6);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.indexedAt).toBeTruthy();
  });

  it('重建索引幂等：条目数不变，不会重复', () => {
    seed();
    syncMemoryIndex(true);
    const before = memoryIndexStats();
    const after = rebuildMemoryIndex();
    expect(after.entries).toBe(before.entries);
    expect(after.files).toBe(before.files);
    expect(searchIndexedMemories('会话槽')!.length).toBe(1);
  });

  it('索引数据库落在记忆目录下', () => {
    seed();
    syncMemoryIndex(true);
    expect(fs.existsSync(path.join(tmpDir, 'index.db'))).toBe(true);
  });

  it('关闭句柄后可再次打开（不抛错）', () => {
    seed();
    syncMemoryIndex(true);
    closeMemoryIndex();
    expect(searchIndexedMemories('会话槽')!.length).toBe(1);
  });
});
