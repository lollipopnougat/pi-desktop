/**
 * 记忆存储层：Markdown 文件读写 + 条目操作 + 脱敏。
 *
 * 设计参考 pi-hermes-memory：
 * - Markdown 为真相源，人类可直接编辑
 * - 条目 = 无序列表行 + HTML 注释元数据（对渲染透明）
 * - 原子写（tmp + rename，同目录避免 EXDEV）
 * - 写盘前 redactSecrets 脱敏（oh-my-pi 的安全底线）
 *
 * 纯 node 依赖，可被 vitest 直接测试。
 */
import { randomUUID } from 'crypto';
import { readPersisted, commitMemoryChanges, revisionOf, type FileChange } from './persistence';
import path from 'path';
import { memoryFilePath, type MemoryFileId, getMemoryDir } from './config';

import { redactSecrets } from './secrets';
export { redactSecrets } from './secrets';

// ─── 版本化读写、来源与删除记录 ───

export function memoryRelativePath(id: MemoryFileId, projectName?: string): string {
  return path.relative(getMemoryDir(), memoryFilePath(id, projectName)).split(path.sep).join('/');
}
export function readMemoryFile(id: MemoryFileId, projectName?: string): string {
  return readPersisted(memoryRelativePath(id, projectName));
}
export function readMemorySnapshot(id: MemoryFileId, projectName?: string) {
  const content = readMemoryFile(id, projectName);
  return { content, revision: revisionOf(content) };
}

const ENTRY_RE = /^(\s*-\s+)(.*)$/;
export function entryBody(line: string): string {
  return ENTRY_RE.exec(line)?.[2] ?? line;
}
function isEntryLine(line: string): boolean {
  return ENTRY_RE.test(line);
}
export function stripMetadata(entry: string): string {
  return entry.replace(/(?:\s*<!--[^>]*-->)+\s*$/, '').trim();
}
export function normalizeLookup(text: string): string {
  return stripMetadata(text).replace(/\s+/g, ' ').trim().toLowerCase();
}
export function entryKey(line: string): string {
  return normalizeLookup(entryBody(line));
}
export function entryMetadata(line: string, file: string) {
  const value = (key: string) => new RegExp(`(?:<!--\\s*|\\s)${key}=([^\\s>]+)`).exec(line)?.[1];
  return {
    id: value('id') || revisionOf(`${file}:${entryKey(line)}`).slice(0, 24),
    created: value('created') || null,
    status: value('status') || 'unverified',
    sources: (value('sources') || '').split(',').filter(Boolean)
  };
}

export type Tombstones = Record<string, Record<string, { text: string; at: string }>>;
export function readTombstones(): Tombstones {
  return JSON.parse(readPersisted('tombstones.json') || '{}');
}
export function prepareDocument(
  content: string,
  before: string,
  file: string,
  sources: string[] = [],
  reviewed = false
): string {
  const existing = new Map(
    before
      .split('\n')
      .filter(isEntryLine)
      .map((l) => [entryKey(l), l])
  );
  const seen = new Set<string>();
  return redactSecrets(content)
    .split('\n')
    .filter((line) => {
      if (!isEntryLine(line)) return true;
      const key = entryKey(line);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((line) => {
      if (!isEntryLine(line)) return line;
      const old = existing.get(entryKey(line));
      if (old && / id=/.test(old)) return old;
      const meta = entryMetadata(old || '', file);
      const id = old ? entryMetadata(old, file).id : randomUUID();
      return `${stripMetadata(line)} <!-- created=${meta.created || new Date().toISOString().slice(0, 10)} id=${id} status=${reviewed ? 'reviewed' : 'unverified'}${sources.length ? ` sources=${sources.join(',')}` : ''} -->`;
    })
    .join('\n');
}

/** 所有文档入口共用此函数；候选写入不能复活已删除的同文条目。 */
export function documentChanges(documents: FileChange[], allowRestore = false): FileChange[] {
  const raw = readPersisted('tombstones.json');
  const tombstones: Tombstones = JSON.parse(raw || '{}');
  const changes = documents.map((doc) => {
    const removed = (tombstones[doc.file] ||= {});
    let after = redactSecrets(doc.after);
    if (!allowRestore)
      after = after
        .split('\n')
        .filter((l) => !isEntryLine(l) || !removed[revisionOf(entryKey(l))])
        .join('\n');
    const nextKeys = new Set(after.split('\n').filter(isEntryLine).map(entryKey));
    for (const line of doc.before.split('\n').filter(isEntryLine)) {
      const key = entryKey(line);
      if (!nextKeys.has(key))
        removed[revisionOf(key)] = {
          text: redactSecrets(stripMetadata(line)),
          at: new Date().toISOString()
        };
    }
    if (allowRestore) for (const key of nextKeys) delete removed[revisionOf(key)];
    return { ...doc, after };
  });
  return [...changes, { file: 'tombstones.json', before: raw, after: JSON.stringify(tombstones) }];
}

export function writeMemoryFile(
  id: MemoryFileId,
  content: string,
  opts?: {
    redact?: boolean;
    projectName?: string;
    baseRevision?: string;
    source?: 'manual' | 'tool';
  }
): string {
  const file = memoryRelativePath(id, opts?.projectName);
  const before = readPersisted(file);
  if (opts?.baseRevision !== undefined && revisionOf(before) !== opts.baseRevision)
    throw new Error('记忆版本冲突：文件已更新，请重新读取后再保存');
  if (content.length > 200_000) throw new Error('记忆文件超过 200000 字符上限');
  const after = prepareDocument(content, before, file, [], opts?.source !== 'tool');
  const changes = documentChanges([{ file, before, after }], opts?.source !== 'tool');
  commitMemoryChanges(
    changes,
    opts?.source === 'tool' ? 'tool' : 'edit',
    id === 'project' ? opts?.projectName : undefined
  );
  return changes[0].after;
}

export function appendEntry(
  id: MemoryFileId,
  content: string,
  opts?: { projectName?: string; category?: string }
) {
  const file = memoryFilePath(id, opts?.projectName);
  const body = redactSecrets(`${opts?.category ? `[${opts.category}] ` : ''}${content.trim()}`);
  if (!content.trim()) return { ok: false, reason: 'content is empty', file };
  if (/[\r\n]/.test(body)) return { ok: false, reason: '条目必须是单行文本', file };
  const current = readMemoryFile(id, opts?.projectName);
  if (current.split('\n').some((l) => isEntryLine(l) && entryKey(l) === normalizeLookup(body)))
    return { ok: false, reason: '已存在相同条目', file };
  const relative = memoryRelativePath(id, opts?.projectName);
  if (readTombstones()[relative]?.[revisionOf(normalizeLookup(body))])
    return { ok: false, reason: '该条目已删除，请在设置中明确恢复', file };
  writeMemoryFile(id, `${current.replace(/\n+$/, '')}${current ? '\n' : ''}- ${body}\n`, {
    ...opts,
    source: 'tool'
  });
  return { ok: true, file };
}

export function editEntryText(current: string, oldText: string, newContent?: string) {
  if (!oldText.trim()) return { ok: false, reason: 'old_text 为空', matches: 0, content: current };
  if (newContent !== undefined && (!newContent.trim() || /[\r\n]/.test(newContent)))
    return { ok: false, reason: '新条目必须是非空单行文本', matches: 0, content: current };
  const lines = current.split('\n');
  const hits = lines.flatMap((l, i) =>
    isEntryLine(l) && entryKey(l).includes(normalizeLookup(oldText)) ? [i] : []
  );
  if (hits.length !== 1)
    return {
      ok: false,
      reason: hits.length ? `匹配到 ${hits.length} 条，请提供更长的唯一片段` : '未匹配到条目',
      matches: hits.length,
      content: current
    };
  if (newContent === undefined) lines.splice(hits[0], 1);
  else lines[hits[0]] = `- ${redactSecrets(newContent.trim())}`;
  return { ok: true, matches: 1, content: lines.join('\n') };
}
export function replaceEntry(
  id: MemoryFileId,
  oldText: string,
  newContent: string,
  opts?: { projectName?: string }
) {
  const r = editEntryText(readMemoryFile(id, opts?.projectName), oldText, newContent);
  if (r.ok) writeMemoryFile(id, r.content, { ...opts, source: 'tool' });
  return r;
}
export function removeEntry(id: MemoryFileId, oldText: string, opts?: { projectName?: string }) {
  const r = editEntryText(readMemoryFile(id, opts?.projectName), oldText);
  if (r.ok) writeMemoryFile(id, r.content, { ...opts, source: 'tool' });
  return r;
}

export interface MemorySearchHit {
  file: string;
  line: number;
  text: string;
  id: string;
  created: string | null;
  status: string;
  sources: string[];
  scope: 'project' | 'global';
  score: number;
}
export interface MemorySearchOptions {
  scope?: 'all' | 'project' | 'global';
  limit?: number;
  cursor?: number;
}
function targets(projectName?: string) {
  const all: Array<{ id: MemoryFileId; display: string; project?: string }> = [];
  if (projectName)
    all.push({ id: 'project', display: `project:${projectName}/MEMORY.md`, project: projectName });
  for (const id of ['USER.md', 'MEMORY.md', 'LESSONS.md', 'STANDING.md'] as const)
    all.push({ id, display: id });
  return all;
}
export function searchMemory(
  query: string,
  projectName?: string,
  opts: MemorySearchOptions = {}
): MemorySearchHit[] {
  const words = [
    ...new Set(
      query
        .trim()
        .toLowerCase()
        .split(/[\s,，]+/)
        .filter(Boolean)
    )
  ];
  if (!words.length) return [];
  const hits: MemorySearchHit[] = [];
  for (const t of targets(projectName)) {
    if ((opts.scope === 'project' && !t.project) || (opts.scope === 'global' && t.project))
      continue;
    const file = memoryRelativePath(t.id, t.project);
    readMemoryFile(t.id, t.project)
      .split('\n')
      .forEach((line, i) => {
        if (!line.trim()) return;
        const body = stripMetadata(line.trim());
        const matched = words.filter((w) => body.toLowerCase().includes(w)).length;
        if (!matched) return;
        hits.push({
          file: t.display,
          line: i + 1,
          text: redactSecrets(body),
          ...entryMetadata(line, file),
          scope: t.project ? 'project' : 'global',
          score:
            (matched / words.length) * 100 +
            (t.project ? 30 : 0) +
            (/\[correction\]/.test(body) ? 15 : 0)
        });
      });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.created || '').localeCompare(a.created || '') ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
  );
  const cursor = Number.isFinite(opts.cursor) ? Math.max(0, Math.floor(opts.cursor!)) : 0;
  const limit = Number.isFinite(opts.limit)
    ? Math.min(100, Math.max(1, Math.floor(opts.limit!)))
    : 100;
  return hits.slice(cursor, cursor + limit);
}

/** 只展开当前项目可见的条目，来源限量并再次脱敏；来源是候选依据，不表示逐条事实已验证。 */
export function readMemoryEntry(id: string, projectName: string) {
  for (const target of targets(projectName)) {
    const file = memoryRelativePath(target.id, target.project);
    for (const line of readMemoryFile(target.id, target.project).split('\n')) {
      const meta = entryMetadata(line, file);
      if (meta.id !== id) continue;
      const sources = meta.sources.slice(0, 3).map((source) => {
        if (!/^[a-zA-Z0-9-]+$/.test(source)) return { id: source, content: '' };
        const raw = readPersisted(`sources/${source}.json`);
        if (!raw) return { id: source, content: '来源不可用' };
        const evidence = JSON.parse(raw) as {
          projectId: string;
          transcript: string;
          session: string;
          entryIds: string[];
          sourceTime?: string;
        };
        return {
          id: source,
          session: evidence.session,
          entryIds: evidence.entryIds,
          sourceTime: evidence.sourceTime,
          content: redactSecrets(evidence.transcript).slice(0, 2400)
        };
      });
      return { ...meta, file: target.display, text: redactSecrets(stripMetadata(line)), sources };
    }
  }
  return null;
}

export function memoryTopicIndex(projectName: string): string {
  return targets(projectName)
    .map((target) => {
      const content = readMemoryFile(target.id, target.project);
      const topics = content
        .split('\n')
        .filter((l) => /^#{1,3} |^- /.test(l))
        .slice(0, 5)
        .map((l) => redactSecrets(stripMetadata(l)).slice(0, 70));
      return topics.length ? `${target.display}: ${topics.join('；')}` : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 1600);
}
export function memoryStats(projectName?: string) {
  return targets(projectName).map((t) => {
    const content = readMemoryFile(t.id, t.project);
    return {
      id: t.display,
      size: Buffer.byteLength(content),
      entries: content.split('\n').filter(isEntryLine).length,
      exists: content.length > 0
    };
  });
}
export function extractionsDir(): string {
  return path.join(getMemoryDir(), 'extractions');
}
