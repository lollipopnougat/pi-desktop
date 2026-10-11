import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpRoot: string;
let origAgentDir: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-reader-'));
  origAgentDir = process.env.PI_CODING_AGENT_DIR;
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = origAgentDir;
});

// 直接测内部纯函数（parse/format），listSessionFiles 经真实目录注入测
import {
  parseSessionTranscript,
  formatTranscript,
  firstUserText,
  listSessionFiles,
  watermarkKey
} from '../../electron/memory/session-reader';

function writeJsonl(name: string, rows: object[]): string {
  const dir = path.join(tmpRoot, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
  return p;
}

const SESSION_HEADER = { type: 'session', version: 3, id: 's1', cwd: '/x' };
function msg(role: string, blocks: any[]) {
  return {
    type: 'message',
    id: Math.random().toString(36).slice(2),
    message: { role, content: blocks }
  };
}
const text = (t: string) => ({ type: 'text', text: t });

describe('parseSessionTranscript', () => {
  it('keeps bounded tool evidence while dropping thinking', () => {
    const p = writeJsonl('a.jsonl', [
      SESSION_HEADER,
      { type: 'model_change', id: 'm1' },
      msg('user', [text('你好，帮我配置项目')]),
      msg('assistant', [
        { type: 'thinking', thinking: '内部推理不应保留' },
        text('好的，开始配置')
      ]),
      msg('toolResult', [text('tool output')])
    ]);
    const { lines } = parseSessionTranscript(p);
    expect(lines.map((l) => l.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(lines[1].text).not.toContain('内部推理');
  });

  it('summarizes assistant toolCalls as single-line traces', () => {
    const p = writeJsonl('a.jsonl', [
      SESSION_HEADER,
      msg('assistant', [
        {
          type: 'toolCall',
          id: 't1',
          name: 'bash',
          arguments: { command: 'ls -la /some/very/long/path' }
        },
        text('done')
      ])
    ]);
    const { lines } = parseSessionTranscript(p);
    expect(lines[0].text).toContain('[bash: ls -la /some/very/long/path]');
    expect(lines[0].text).toContain('done');
  });

  it('reports corrupted rows so they are not checkpointed as complete', () => {
    const dir = path.join(tmpRoot, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'b.jsonl');
    fs.writeFileSync(
      p,
      [
        '{corrupted',
        JSON.stringify(SESSION_HEADER),
        JSON.stringify(msg('user', [text('')])) // 空 user 消息
      ].join('\n'),
      'utf-8'
    );
    expect(() => parseSessionTranscript(p)).toThrow('不完整或损坏');
  });

  it('truncates very long transcripts', () => {
    const long = 'x'.repeat(500);
    const rows = [SESSION_HEADER, msg('user', [text(long + ' ' + long + ' ' + long)])];
    const p = writeJsonl('c.jsonl', rows);
    const { truncated } = parseSessionTranscript(p, 1000);
    expect(truncated).toBe(true);
  });

  it('preserves long message tails within the transcript budget', () => {
    const p = writeJsonl('d.jsonl', [SESSION_HEADER, msg('user', [text('y'.repeat(5000))])]);
    const { lines } = parseSessionTranscript(p);
    expect(lines.map((l) => l.text).join('')).toBe('y'.repeat(5000));
  });

  it('returns empty for missing file', () => {
    expect(() => parseSessionTranscript('/nonexistent/file.jsonl')).toThrow();
  });
});

describe('formatTranscript', () => {
  it('formats roles in Chinese and redacts secrets', () => {
    const out = formatTranscript([
      { role: 'user', text: 'key sk-abcdefghijklmnopqrst1234 here' },
      { role: 'assistant', text: 'ok' }
    ]);
    expect(out).toContain('用户:');
    expect(out).toContain('助手（陈述不等于验证）:');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abcdefghijklmnopqrst1234');
  });
});

describe('firstUserText', () => {
  it('returns first user line', () => {
    expect(
      firstUserText([
        { role: 'assistant', text: 'hi' },
        { role: 'user', text: '帮我写测试' }
      ])
    ).toBe('帮我写测试');
  });
});

describe('listSessionFiles / watermarkKey', () => {
  it('lists jsonl files sorted by mtime', async () => {
    const dir = path.join(tmpRoot, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const f1 = path.join(dir, '2026-01-01_a.jsonl');
    const f2 = path.join(dir, '2026-01-02_b.jsonl');
    const notJsonl = path.join(dir, 'readme.txt');
    fs.writeFileSync(f1, '{}');
    fs.writeFileSync(f2, '{}');
    fs.writeFileSync(notJsonl, '{}');
    // 保证 mtime 顺序
    fs.utimesSync(f1, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(f2, new Date('2026-01-02'), new Date('2026-01-02'));
    // 显式注入扫描目录，同时验证不存在目录的降级路径。
    expect(listSessionFiles('/definitely/not/exist')).toEqual([]);
    expect(listSessionFiles('/unused', dir).map((f) => f.path)).toEqual([f1, f2]);
    expect(watermarkKey({ path: f1, name: 'a.jsonl', mtimeMs: 0, size: 0 })).not.toBe(
      watermarkKey({ path: f2, name: 'a.jsonl', mtimeMs: 0, size: 0 })
    );
  });
});
