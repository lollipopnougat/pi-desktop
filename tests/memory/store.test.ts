import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 每个测试用独立临时目录
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'));
  process.env.PI_MEMORY_DIR = tmpDir;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_MEMORY_DIR;
});

import {
  redactSecrets,
  readMemoryFile,
  writeMemoryFile,
  appendEntry,
  replaceEntry,
  removeEntry,
  searchMemory,
  memoryStats,
  stripMetadata
} from '../../electron/memory/store';
import {
  readMemoryConfig,
  writeMemoryConfig,
  memoryFilePath,
  sanitizeProjectName,
  DEFAULT_MEMORY_CONFIG
} from '../../electron/memory/config';

// ─── redactSecrets ───

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys', () => {
    const out = redactSecrets('my key is sk-abcdefghijklmnopqrst1234 ok');
    expect(out).not.toContain('sk-abcdefghijklmnopqrst1234');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts GitHub tokens', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    expect(redactSecrets(`token=${token}`)).not.toContain(token);
  });

  it('redacts AWS keys', () => {
    const key = 'AKIA' + 'A'.repeat(16);
    expect(redactSecrets(`aws ${key}`)).toContain('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
    expect(redactSecrets(`auth ${jwt}`)).not.toContain(jwt);
  });

  it('redacts key=value pairs but keeps key name', () => {
    const out = redactSecrets('api_key: abcdefghijklmnopqrstuvwxyz12');
    expect(out).toContain('api_key');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz12');
  });

  it('leaves normal text untouched', () => {
    const text = '用户偏好 pnpm，测试文件放 __tests__ 目录';
    expect(redactSecrets(text)).toBe(text);
  });
});

// ─── 文件读写 ───

describe('memory file io', () => {
  it('returns empty string for missing file', () => {
    expect(readMemoryFile('USER.md')).toBe('');
  });

  it('writes and reads back with redaction', () => {
    const written = writeMemoryFile('USER.md', 'name: tester\nkey sk-abcdefghijklmnopqrst');
    expect(written).toContain('[REDACTED]');
    expect(readMemoryFile('USER.md')).toContain('[REDACTED]');
  });

  it('writes project file into projects/<name>/', () => {
    writeMemoryFile('project', 'project fact', { projectName: 'My Repo!' });
    const p = path.join(tmpDir, 'projects', 'My-Repo', 'MEMORY.md');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toContain('project fact');
  });
});

// ─── 条目操作 ───

describe('appendEntry', () => {
  it('appends a single-line entry with metadata', () => {
    const r = appendEntry('USER.md', '偏好使用 pnpm');
    expect(r.ok).toBe(true);
    const content = readMemoryFile('USER.md');
    expect(content).toMatch(
      /- 偏好使用 pnpm <!-- created=\d{4}-\d{2}-\d{2} id=[^ ]+ status=unverified -->/
    );
  });

  it('rejects empty and multiline content', () => {
    expect(appendEntry('USER.md', '   ').ok).toBe(false);
    expect(appendEntry('USER.md', 'line1\nline2').ok).toBe(false);
  });

  it('rejects duplicate entries (normalized)', () => {
    appendEntry('USER.md', 'use pnpm');
    const r = appendEntry('USER.md', 'Use  Pnpm ');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('相同');
  });

  it('supports category prefix', () => {
    appendEntry('LESSONS.md', 'CI 需要 --frozen-lockfile', { category: 'convention' });
    expect(readMemoryFile('LESSONS.md')).toContain('[convention] CI 需要 --frozen-lockfile');
  });

  it('redacts secrets in entry', () => {
    appendEntry('MEMORY.md', 'token is ghp_' + 'b'.repeat(36));
    expect(readMemoryFile('MEMORY.md')).toContain('[REDACTED]');
  });
});

describe('replaceEntry / removeEntry', () => {
  beforeEach(() => {
    writeMemoryFile(
      'LESSONS.md',
      '- [correction] use npm <!-- created=2026-01-01 -->\n- other lesson <!-- created=2026-01-01 -->\n'
    );
  });

  it('replaces matched entry', () => {
    const r = replaceEntry('LESSONS.md', 'use npm', 'use pnpm instead');
    expect(r.ok).toBe(true);
    const content = readMemoryFile('LESSONS.md');
    expect(content).toContain('use pnpm instead');
    expect(content).not.toContain('use npm <');
    expect(content).toContain('other lesson');
  });

  it('reports no match', () => {
    const r = replaceEntry('LESSONS.md', 'nonexistent', 'x');
    expect(r.ok).toBe(false);
    expect(r.matches).toBe(0);
  });

  it('requires unique match', () => {
    writeMemoryFile('LESSONS.md', '- lesson a one\n- lesson b one\n');
    const r = replaceEntry('LESSONS.md', 'one', 'x');
    expect(r.ok).toBe(false);
    expect(r.matches).toBe(2);
  });

  it('removes matched entry', () => {
    const r = removeEntry('LESSONS.md', 'other lesson');
    expect(r.ok).toBe(true);
    expect(readMemoryFile('LESSONS.md')).not.toContain('other lesson');
    expect(readMemoryFile('LESSONS.md')).toContain('use npm');
  });
});

// ─── 检索 ───

describe('searchMemory', () => {
  beforeEach(() => {
    writeMemoryFile('USER.md', '- prefers dark theme\n- uses macOS\n');
    writeMemoryFile('LESSONS.md', '- [correction] always use pnpm\n');
    writeMemoryFile('project', '- build via vite only', { projectName: 'demo' });
  });

  it('finds case-insensitive hits across files', () => {
    const hits = searchMemory('PNPM');
    expect(hits.length).toBe(1);
    expect(hits[0].file).toBe('LESSONS.md');
  });

  it('searches project memory when projectName given', () => {
    const hits = searchMemory('vite', 'demo');
    expect(hits.length).toBe(1);
    expect(hits[0].file).toBe('project:demo/MEMORY.md');
  });

  it('returns empty for empty query', () => {
    expect(searchMemory('')).toEqual([]);
  });
});

describe('memoryStats', () => {
  it('counts entries and size', () => {
    writeMemoryFile('USER.md', '- a\n- b\n');
    const stats = memoryStats();
    const user = stats.find((s) => s.id === 'USER.md')!;
    expect(user.entries).toBe(2);
    expect(user.exists).toBe(true);
    const lessons = stats.find((s) => s.id === 'LESSONS.md')!;
    expect(lessons.exists).toBe(false);
  });
});

describe('stripMetadata', () => {
  it('removes trailing html comment', () => {
    expect(stripMetadata('- foo <!-- created=2026-01-01 -->')).toBe('- foo');
  });
});

// ─── config ───

describe('memory config', () => {
  it('returns defaults when file missing', () => {
    expect(readMemoryConfig()).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  it('persists patches', () => {
    const next = writeMemoryConfig({
      enabled: false,
      extractModel: { provider: 'anthropic', modelId: 'claude-x' }
    });
    expect(next.enabled).toBe(false);
    expect(next.extractModel).toEqual({ provider: 'anthropic', modelId: 'claude-x' });
    const again = readMemoryConfig();
    expect(again.enabled).toBe(false);
    expect(again.consolidateThreshold).toBe(DEFAULT_MEMORY_CONFIG.consolidateThreshold);
  });

  it('sanitizeProjectName strips unsafe chars', () => {
    expect(sanitizeProjectName('My Repo!')).toBe('My-Repo');
    expect(sanitizeProjectName('///')).toBe('default');
  });

  it('memoryFilePath for project id', () => {
    expect(memoryFilePath('project', 'demo')).toBe(
      path.join(tmpDir, 'projects', 'demo', 'MEMORY.md')
    );
  });
});
