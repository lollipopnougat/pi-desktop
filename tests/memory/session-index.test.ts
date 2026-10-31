/**
 * 会话索引（session_search / session_read 的数据层）测试：
 * 增量同步、项目作用域、中英文检索、删除清理、保留策略、上下文读取。
 *
 * 记忆目录与会话目录都走 PI_MEMORY_DIR / PI_SESSIONS_DIR 注入的 tmp。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let memoryDir: string;
let sessionsDir: string;
let projA: string;
let projB: string;

const env = process.env;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-index-'));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-files-'));
  projA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-a-'));
  projB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-b-'));
  process.env.PI_MEMORY_DIR = memoryDir;
  process.env.PI_SESSIONS_DIR = sessionsDir;
  resetSessionIndexStateForTests();
});

afterEach(() => {
  resetSessionIndexStateForTests();
  for (const dir of [memoryDir, sessionsDir, projA, projB]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env.PI_MEMORY_DIR = env.PI_MEMORY_DIR;
  process.env.PI_SESSIONS_DIR = env.PI_SESSIONS_DIR;
});

import {
  findSessionFile,
  listSessionFiles,
  parseSessionFile,
  pruneSessionIndex,
  readSessionContext,
  rebuildSessionIndex,
  resetSessionIndexStateForTests,
  searchSessionMessages,
  sessionIndexStats,
  syncSessionIndex
} from '../../electron/memory/session-index';
import { projectIdentity } from '../../electron/memory/config';

interface Msg {
  role: 'user' | 'assistant' | 'toolResult';
  text?: string;
  thinking?: string;
  ts?: number;
}

/** 写一个会话 JSONL（首行 session 头 + 每行 message） */
function writeSession(
  projectCwd: string,
  id: string,
  messages: Msg[],
  opts: { dir?: string; extra?: Record<string, unknown> } = {}
): string {
  const dirName = opts.dir ?? `--${projectCwd.replace(/\//g, '-')}--`;
  const dir = path.join(sessionsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-10-01T00:00:00.000Z',
      cwd: projectCwd
    }),
    JSON.stringify({ type: 'model_change', provider: 'x', modelId: 'y' })
  ];
  for (const message of messages) {
    const content: unknown[] = [];
    if (message.text) content.push({ type: 'text', text: message.text });
    if (message.thinking) content.push({ type: 'thinking', thinking: message.thinking });
    if (message.role === 'toolResult') content.length = 0;
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: message.role, content, timestamp: message.ts ?? Date.now() }
      })
    );
  }
  if (opts.extra) lines.push('{ this is not json'); // 半行写入的容错
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
}

describe('parseSessionFile', () => {
  it('只收 user/assistant 文本，忽略 thinking 与 toolResult', () => {
    const file = writeSession(projA, 's1', [
      { role: 'user', text: '把 TodoPanel 图标对齐修一下' },
      { role: 'assistant', text: '已修正行高', thinking: '思考过程不该进索引' },
      { role: 'toolResult', text: '工具输出' }
    ]);
    const parsed = parseSessionFile(file);
    expect(parsed.session).toBe('s1');
    expect(parsed.project).toBe(projectIdentity(projA).id);
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(parsed.messages.map((m) => m.text)).toEqual([
      '把 TodoPanel 图标对齐修一下',
      '已修正行高'
    ]);
    expect(parsed.messages[0].line).toBe(3);
  });

  it('坏行不影响解析', () => {
    const file = writeSession(projA, 's2', [{ role: 'user', text: 'hello world' }], { extra: {} });
    expect(parseSessionFile(file).messages).toHaveLength(1);
  });
});

describe('listSessionFiles', () => {
  it('只列 .jsonl', () => {
    writeSession(projA, 'a1', [{ role: 'user', text: 'x y z' }]);
    fs.writeFileSync(path.join(sessionsDir, 'notes.txt'), 'ignore me');
    const files = listSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0].path.endsWith('a1.jsonl')).toBe(true);
  });

  it('目录不存在时返回空数组', () => {
    expect(listSessionFiles(path.join(sessionsDir, 'nope'))).toEqual([]);
  });
});

describe('searchSessionMessages', () => {
  it('英文与中文（≥3 字）走 FTS，两字走 LIKE', () => {
    writeSession(projA, 's1', [
      { role: 'user', text: 'ChatStream 的滚动容器用 max-w-[56rem] 包住' },
      { role: 'assistant', text: '会话槽的焦点门闩在 sendEvent 闭包里' }
    ]);
    syncSessionIndex(true);
    expect(searchSessionMessages('ChatStream')!.length).toBeGreaterThan(0);
    expect(searchSessionMessages('会话槽')!.length).toBeGreaterThan(0);
    // 两字中文 trigram 匹配不到，靠 LIKE 兜底
    expect(searchSessionMessages('门闩')!.length).toBeGreaterThan(0);
  });

  it('命中带 session / line / snippet / 分数', () => {
    writeSession(projA, 's1', [{ role: 'user', text: '体素引擎的网格与 AO 面剔除' }]);
    syncSessionIndex(true);
    const hit = searchSessionMessages('体素引擎')![0];
    expect(hit.session).toBe('s1');
    expect(hit.role).toBe('user');
    expect(hit.line).toBe(3);
    expect(hit.snippet).toContain('体素');
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.file.endsWith('s1.jsonl')).toBe(true);
  });

  it('默认按项目过滤，scope 传 undefined 查全部', () => {
    writeSession(projA, 'sa', [{ role: 'user', text: 'alpha beta gamma' }]);
    writeSession(projB, 'sb', [{ role: 'user', text: 'alpha beta delta' }]);
    syncSessionIndex(true);
    const onlyA = searchSessionMessages('alpha', { project: projectIdentity(projA).id })!;
    expect(onlyA.map((h) => h.session)).toEqual(['sa']);
    expect(
      searchSessionMessages('alpha')!
        .map((h) => h.session)
        .sort()
    ).toEqual(['sa', 'sb']);
  });

  it('role 与 since 过滤', () => {
    const old = Date.parse('2026-01-01T00:00:00.000Z');
    const recent = Date.parse('2026-10-01T00:00:00.000Z');
    writeSession(projA, 's1', [
      { role: 'user', text: 'legacy pipeline old', ts: old },
      { role: 'assistant', text: 'legacy pipeline new', ts: recent }
    ]);
    syncSessionIndex(true);
    expect(searchSessionMessages('legacy', { role: 'assistant' })!.length).toBe(1);
    const since = searchSessionMessages('legacy', { since: '2026-06-01T00:00:00.000Z' })!;
    expect(since.every((hit) => hit.role === 'assistant')).toBe(true);
  });

  it('空查询返回空数组，limit/cursor 生效', () => {
    writeSession(projA, 's1', [
      { role: 'user', text: 'toolbar alignment one' },
      { role: 'assistant', text: 'toolbar alignment two' },
      { role: 'user', text: 'toolbar alignment three' }
    ]);
    syncSessionIndex(true);
    expect(searchSessionMessages('   ')).toEqual([]);
    expect(searchSessionMessages('toolbar', { limit: 1 })).toHaveLength(1);
    const first = searchSessionMessages('toolbar', { limit: 1 })![0];
    const second = searchSessionMessages('toolbar', { limit: 1, cursor: 1 })![0];
    expect(first.line).not.toBe(second.line);
  });

  it('索引库不存在且只读查询时不创建数据库', () => {
    const stats = sessionIndexStats(false);
    expect(stats).toMatchObject({ available: true, entries: 0, files: 0 });
    expect(fs.existsSync(path.join(memoryDir, 'index.db'))).toBe(false);
  });
});

describe('增量同步', () => {
  it('文件未变时跳过，变了就替换该文件的全部条目', () => {
    const file = writeSession(projA, 's1', [{ role: 'user', text: 'first version token' }]);
    syncSessionIndex(true);
    expect(sessionIndexStats().entries).toBe(1);

    // 未变：再同步不新增
    syncSessionIndex();
    expect(sessionIndexStats().entries).toBe(1);

    // 变了：旧条目被替换，不残留
    fs.writeFileSync(
      file,
      `{"type":"session","id":"s1","cwd":"${projA}"}\n` +
        `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second version token' }], timestamp: Date.now() } })}\n`,
      'utf-8'
    );
    syncSessionIndex();
    const rows = searchSessionMessages('token')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].snippet).toContain('second');
  });

  it('会话文件被删除时条目一起清理', () => {
    const file = writeSession(projA, 's1', [{ role: 'user', text: 'doomed session text' }]);
    syncSessionIndex(true);
    expect(sessionIndexStats().entries).toBe(1);
    fs.rmSync(file);
    syncSessionIndex();
    expect(sessionIndexStats().entries).toBe(0);
    expect(sessionIndexStats().files).toBe(0);
    expect(searchSessionMessages('doomed')).toEqual([]);
  });

  it('重建索引幂等', () => {
    writeSession(projA, 's1', [{ role: 'user', text: 'rebuild me please' }]);
    const first = rebuildSessionIndex();
    const second = rebuildSessionIndex();
    expect(first.entries).toBe(1);
    expect(second.entries).toBe(1);
    expect(second.files).toBe(1);
    expect(second.indexedAt).toBeTruthy();
  });
});

describe('保留策略', () => {
  it('超过保留期的消息被删除', () => {
    const hundredDays = 100 * 24 * 3600 * 1000;
    writeSession(projA, 'old', [
      { role: 'user', text: 'ancient memory words', ts: Date.now() - hundredDays }
    ]);
    writeSession(projA, 'new', [{ role: 'user', text: 'fresh memory words' }]);
    syncSessionIndex(true);
    expect(sessionIndexStats().entries).toBe(2);
    // 把「现在」往后推 100 天：100 天前的消息超出 180 天保留期，新的仍在期
    const removed = pruneSessionIndex(Date.now() + hundredDays);
    expect(removed).toBe(1);
    expect(sessionIndexStats().entries).toBe(1);
    expect(searchSessionMessages('ancient')).toEqual([]);
    expect(searchSessionMessages('fresh')!.length).toBe(1);
  });
});

describe('readSessionContext', () => {
  it('返回命中位置前后原文（含角色与行号）', () => {
    const file = writeSession(projA, 's1', [
      { role: 'user', text: '第一句：先看 TodoPanel' },
      { role: 'assistant', text: '第二句：确认行高' },
      { role: 'user', text: '第三句：改成 items-center' },
      { role: 'assistant', text: '第四句：已改' },
      { role: 'user', text: '第五句：跑测试' }
    ]);
    syncSessionIndex(true);
    const hit = searchSessionMessages('行高')![0];
    const context = readSessionContext('s1', hit.line, 1)!;
    expect(context.file).toBe(file);
    expect(context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(context.messages[1].text).toContain('行高');
  });

  it('未知会话返回 null', () => {
    syncSessionIndex(true);
    expect(readSessionContext('missing-session', 1)).toBeNull();
    expect(findSessionFile('missing-session')).toBeNull();
  });

  it('radius 超出边界时夹紧', () => {
    writeSession(projA, 's1', [
      { role: 'user', text: 'only one message here' },
      { role: 'assistant', text: 'second message here' }
    ]);
    syncSessionIndex(true);
    const context = readSessionContext('s1', 3, 10)!;
    expect(context.messages).toHaveLength(2);
  });
});
