/**
 * 子 agent 会话文件单测:
 * - buildConversationFromMessages:会话消息 → 对话流 + 工具流水(工具结果回填)
 * - readSubagentConversation:真实 SDK 会话文件落盘 → 回放(不 mock SDK)
 * - 路径边界校验与删除(只允许动 subagent-sessions/ 内的文件)
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  buildConversationFromMessages,
  deleteOrphanSubagentSessions,
  deleteSubagentSessionFile,
  deleteSubagentSessionsForParent,
  deleteSubagentSessionsForProject,
  isSubagentSessionFile,
  readSessionParent,
  readSubagentConversation,
  SUBAGENT_SESSIONS_DIR,
  SESSION_FILE_LIMITS
} from '../../electron/subagents/session-file';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piui-subagent-session-'));
const createdFiles: string[] = [];
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of createdFiles) fs.rmSync(f, { force: true });
});

/** 造一个子 agent 会话文件(只写 header,足够 parentSession 匹配) */
function writeChildSession(name: string, parentSession?: string): string {
  fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
  const file = path.join(SUBAGENT_SESSIONS_DIR, name);
  const header = {
    type: 'session',
    version: 3,
    id: name.replace(/\.jsonl$/, ''),
    timestamp: new Date().toISOString(),
    cwd: '/tmp',
    parentSession
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
  createdFiles.push(file);
  return file;
}

const assistant = (content: unknown[], timestamp = 1000) => ({
  role: 'assistant',
  content,
  timestamp
});

describe('buildConversationFromMessages', () => {
  it('assistant 内容块按顺序折算,toolResult 回填结果与错误标记', () => {
    const conv = buildConversationFromMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 900 },
      assistant([
        { type: 'thinking', thinking: '先看入口' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'text', text: '读完了' },
        { type: 'toolCall', id: 'tc2', name: 'bash', arguments: { command: 'ls' } }
      ]),
      {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read',
        content: 'file body',
        isError: false,
        timestamp: 1100
      },
      {
        role: 'toolResult',
        toolCallId: 'tc2',
        toolName: 'bash',
        content: 'boom',
        isError: true,
        timestamp: 1200
      }
    ]);

    // system / user 不进对话流(任务正文由弹窗的「任务」块展示)
    expect(conv.transcript.map((i) => i.kind)).toEqual(['thinking', 'tool', 'text', 'tool']);
    expect(conv.transcript[1]).toMatchObject({ kind: 'tool', toolCallId: 'tc1', at: 1000 });
    expect(conv.toolCalls).toHaveLength(2);
    expect(conv.toolCalls[0]).toMatchObject({
      toolCallId: 'tc1',
      toolName: 'read',
      args: { path: 'a.ts' },
      pending: false,
      result: 'file body',
      isError: false,
      startedAt: 1000,
      endedAt: 1100
    });
    expect(conv.toolCalls[1]).toMatchObject({ toolCallId: 'tc2', isError: true, endedAt: 1200 });
  });

  it('未匹配的 toolResult / 非法条目被忽略', () => {
    const conv = buildConversationFromMessages([
      { role: 'toolResult', toolCallId: 'nope', content: 'x', isError: false },
      null,
      'string',
      assistant([{ type: 'text', text: '' }, { type: 'toolCall' }])
    ]);
    expect(conv.toolCalls).toEqual([]);
    expect(conv.transcript).toEqual([]);
  });

  it('工具流水超上限时丢弃最旧', () => {
    const messages = Array.from({ length: SESSION_FILE_LIMITS.MAX_TOOL_CALLS + 3 }, (_, i) =>
      assistant([{ type: 'toolCall', id: `tc${i}`, name: 'read', arguments: {} }], i)
    );
    const conv = buildConversationFromMessages(messages);
    expect(conv.toolCalls).toHaveLength(SESSION_FILE_LIMITS.MAX_TOOL_CALLS);
    expect(conv.toolCalls[0].toolCallId).toBe('tc3');
  });
});

describe('readSubagentConversation(真实会话文件)', () => {
  it('落盘的子会话文件可回放出完整对话', () => {
    const sessionDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sm = SessionManager.create('/tmp/proj', sessionDir);
    const file = sm.getSessionFile()!;
    expect(file).toBeTruthy();

    // 落盘时机:首条 user/assistant 消息写入时才创建文件
    sm.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '执行任务' }],
      timestamp: 1
    } as never);
    expect(fs.existsSync(file)).toBe(true);
    sm.appendMessage(
      assistant(
        [
          { type: 'thinking', thinking: '想想' },
          { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'echo hi' } }
        ],
        2
      ) as never
    );
    sm.appendMessage({
      role: 'toolResult',
      toolCallId: 'tc1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
      timestamp: 3
    } as never);

    const conv = readSubagentConversation(file);
    expect(conv).not.toBeNull();
    expect(conv!.transcript.map((i) => i.kind)).toEqual(['thinking', 'tool']);
    expect(conv!.toolCalls).toHaveLength(1);
    expect(conv!.toolCalls[0]).toMatchObject({
      toolCallId: 'tc1',
      toolName: 'bash',
      isError: false
    });
    expect(JSON.stringify(conv!.toolCalls[0].result)).toContain('hi');
  });

  it('header 里的 parentSession 可读出(清理依据)', () => {
    const sessionDir = path.join(tmpDir, 'parent-link');
    fs.mkdirSync(sessionDir, { recursive: true });
    const parentFile = path.join(tmpDir, 'main.jsonl');
    const sm = SessionManager.create('/tmp/proj', sessionDir, { parentSession: parentFile });
    sm.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
      timestamp: 1
    } as never);
    expect(readSessionParent(sm.getSessionFile()!)).toBe(parentFile);
    // 非会话文件 / 不存在 → null
    const junk = path.join(tmpDir, 'junk.jsonl');
    fs.writeFileSync(junk, '{"type":"message"}\n');
    expect(readSessionParent(junk)).toBeNull();
    expect(readSessionParent(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
  });

  it('无文件 / 不存在 / 空参数返回 null', () => {
    expect(readSubagentConversation(undefined)).toBeNull();
    expect(readSubagentConversation(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
  });
});

describe('路径边界与清理', () => {
  it('只认 subagent-sessions/ 内的文件', () => {
    const inside = path.join(SUBAGENT_SESSIONS_DIR, 'a.jsonl');
    expect(isSubagentSessionFile(inside)).toBe(true);
    expect(isSubagentSessionFile(SUBAGENT_SESSIONS_DIR)).toBe(false);
    expect(
      isSubagentSessionFile(path.join(SUBAGENT_SESSIONS_DIR, '..', 'sessions', 'a.jsonl'))
    ).toBe(false);
    expect(isSubagentSessionFile('/tmp/a.jsonl')).toBe(false);
  });

  it('目录外文件不会被删除,目录内文件正常删除', () => {
    const outside = path.join(tmpDir, 'keep.jsonl');
    fs.writeFileSync(outside, 'x');
    deleteSubagentSessionFile(outside);
    expect(fs.existsSync(outside)).toBe(true);

    const inside = path.join(SUBAGENT_SESSIONS_DIR, `test-${Date.now()}.jsonl`);
    fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(inside, 'x');
    deleteSubagentSessionFile(inside);
    expect(fs.existsSync(inside)).toBe(false);
    // 不存在的文件静默
    deleteSubagentSessionFile(path.join(SUBAGENT_SESSIONS_DIR, 'gone.jsonl'));
  });
});

describe('主会话删除时清理子会话文件', () => {
  it('按 parentSession 精确删除(其他会话的文件不受影响)', () => {
    const parentA = path.join(tmpDir, 'main-a.jsonl');
    const parentB = path.join(tmpDir, 'main-b.jsonl');
    const childA = writeChildSession(`test-parent-a-${Date.now()}.jsonl`, parentA);
    const childB = writeChildSession(`test-parent-b-${Date.now()}.jsonl`, parentB);

    expect(deleteSubagentSessionsForParent(parentA)).toBe(1);
    expect(fs.existsSync(childA)).toBe(false);
    expect(fs.existsSync(childB)).toBe(true);
    expect(deleteSubagentSessionsForParent(parentB)).toBe(1);
    expect(fs.existsSync(childB)).toBe(false);
  });

  it('移除项目时删除该项目会话目录下所有主会话的子会话', () => {
    const projDir = path.join(tmpDir, 'sessions', '--proj--');
    const otherDir = path.join(tmpDir, 'sessions', '--other--');
    const inProj = writeChildSession(
      `test-proj-${Date.now()}.jsonl`,
      path.join(projDir, 'm1.jsonl')
    );
    const inOther = writeChildSession(
      `test-other-${Date.now()}.jsonl`,
      path.join(otherDir, 'm2.jsonl')
    );

    expect(deleteSubagentSessionsForProject(projDir)).toBe(1);
    expect(fs.existsSync(inProj)).toBe(false);
    expect(fs.existsSync(inOther)).toBe(true);
    deleteSubagentSessionFile(inOther);
  });

  it('孤儿清理:父会话不存在或未记录父会话的文件被删,父会话仍在的保留', () => {
    const liveParent = path.join(tmpDir, 'live-main.jsonl');
    fs.writeFileSync(liveParent, '{"type":"session"}\n');
    const kept = writeChildSession(`test-live-${Date.now()}.jsonl`, liveParent);
    const orphan = writeChildSession(
      `test-orphan-${Date.now()}.jsonl`,
      path.join(tmpDir, 'gone-main.jsonl')
    );
    const noParent = writeChildSession(`test-noparent-${Date.now()}.jsonl`);

    // 默认保护期内(刚写入的文件)不清理
    expect(deleteOrphanSubagentSessions()).toBe(0);
    expect(fs.existsSync(orphan)).toBe(true);

    deleteOrphanSubagentSessions(0);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(noParent)).toBe(false);
    deleteSubagentSessionFile(kept);
  });
});
