/**
 * 会话索引：把 `~/.pi-desktop/sessions/**\/*.jsonl` 里的 user/assistant 文本
 * 送进同一个 `index.db` 的 FTS5 trigram 索引，供 `session_search` / `session_read` 使用。
 *
 * 与 `search-index.ts`（记忆索引）共享数据库文件、各自开连接、各自建表：
 * 删除 `index.db` 等于同时清空两类索引，重建也互不干扰。
 *
 * 三条约定：
 * 1. **索引是派生数据**：会话文件是唯一真相，任何不一致都可以整库重建；
 * 2. **按 mtime + size 增量**：没变的文件直接跳过（31 个文件首轮 209ms，之后只碰改动过的）；
 * 3. **失败即降级**：返回 `null` 表示索引不可用，工具层退回「没有结果」而不是报错。
 *
 * 保留策略：默认 180 天、最多 20 万条消息（对齐 docs/MEMORY-REDESIGN.md §4.3）。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from '../config-dir';
import { projectIdentity } from './config';
import { redactSecrets } from './secrets';
import { bm25ToUnit, buildFtsMatch, matchRatio, recencyUnit, snippet, splitQueryTerms } from './search';

const DB_FILE = 'index.db';
/** 增量同步节流：每次检索最多 5s 扫一次 stat（改动过的文件才重新解析） */
const SYNC_TTL_MS = 5000;
const RETRY_MS = 30_000;
/** 单条消息进索引的字符上限（长 tool 输出对话对检索没用，截断可把索引压到 1/10） */
const MAX_TEXT_CHARS = 1500;
/** 单文件最多收录的消息条数（防止超大历史会话拖慢首轮索引） */
const MAX_MESSAGES_PER_FILE = 5000;
const RETENTION_DAYS = 180;
const MAX_ROWS = 200_000;
const CANDIDATE_POOL = 200;

const SCHEMA = `
create table if not exists session_files(
  path text primary key,
  session text not null,
  project text not null,
  mtime_ms integer not null,
  size integer not null,
  indexed_at text not null
);
create table if not exists session_docs(
  rowid integer primary key,
  session text not null,
  project text not null,
  role text not null,
  ts text,
  line integer not null,
  text text not null
);
create index if not exists session_docs_session on session_docs(session);
create index if not exists session_docs_project on session_docs(project);
create virtual table if not exists session_fts using fts5(
  body,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);
`;

// ─── node:sqlite 的最小类型面（与 search-index.ts 一致，避免共享可变状态） ───

interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string) => SqliteDatabase;
}

function loadSqlite(): SqliteModule | null {
  try {
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

let sqlite: SqliteModule | null | undefined;
let db: SqliteDatabase | null = null;
let dbPath: string | null = null;
let lastSyncAt = 0;
let failure: { at: number; message: string } | null = null;

/** 会话根目录（测试可经 PI_SESSIONS_DIR 重定向） */
export function getSessionsRoot(): string {
  return process.env.PI_SESSIONS_DIR || path.join(DESKTOP_AGENT_DIR, 'sessions');
}

function indexPath(): string {
  const dir = process.env.PI_MEMORY_DIR || path.join(DESKTOP_AGENT_DIR, 'memory');
  return path.join(dir, DB_FILE);
}

function open(): SqliteDatabase {
  const target = indexPath();
  if (db && dbPath === target) return db;
  if (db) closeSessionIndex();
  if (failure && Date.now() - failure.at < RETRY_MS) throw new Error(failure.message);
  if (sqlite === undefined) sqlite = loadSqlite();
  if (!sqlite) throw new Error('当前运行时没有 node:sqlite，会话索引不可用');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const instance = new sqlite.DatabaseSync(target);
  instance.exec('pragma journal_mode = wal');
  instance.exec('pragma synchronous = normal');
  instance.exec('pragma wal_autocheckpoint = 256');
  try {
    instance.exec('pragma busy_timeout = 5000');
  } catch {
    /* 旧版本不支持时忽略 */
  }
  instance.exec(SCHEMA);
  db = instance;
  dbPath = target;
  return db;
}

export function closeSessionIndex(): void {
  try {
    db?.close();
  } catch {
    /* 关闭失败不阻塞退出 */
  }
  db = null;
  dbPath = null;
  lastSyncAt = 0;
}

// ─── 会话文件扫描 ───

interface SessionFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** 列出所有会话 JSONL（不跟随符号链接，跳过非目录） */
export function listSessionFiles(root = getSessionsRoot()): SessionFile[] {
  const files: SessionFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return files;
  }
  for (const dir of dirs) {
    const full = path.join(root, dir);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        files.push({ path: file, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
      } catch {
        /* 文件在扫描过程中消失 */
      }
    }
  }
  return files;
}

interface SessionMessage {
  role: 'user' | 'assistant';
  ts: string | null;
  line: number;
  text: string;
}

interface ParsedSession {
  session: string;
  project: string;
  messages: SessionMessage[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** 解析一个会话文件：首行取 id/cwd，其余取 user/assistant 的文本 */
export function parseSessionFile(file: string): ParsedSession {
  const raw = fs.readFileSync(file, 'utf-8');
  let session = path.basename(file, '.jsonl');
  let cwd = '';
  const messages: SessionMessage[] = [];
  let line = 0;
  for (const row of raw.split('\n')) {
    line += 1;
    if (!row.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row) as Record<string, unknown>;
    } catch {
      continue; // 会话文件正在写入时可能有半行
    }
    if (parsed.type === 'session') {
      if (typeof parsed.id === 'string') session = parsed.id;
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
      continue;
    }
    if (parsed.type !== 'message') continue;
    const message = parsed.message as { role?: string; content?: unknown; timestamp?: number } | undefined;
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(message?.content).trim();
    if (!text) continue;
    const ts =
      typeof message?.timestamp === 'number'
        ? new Date(message.timestamp).toISOString()
        : typeof parsed.timestamp === 'string'
          ? parsed.timestamp
          : null;
    messages.push({ role, ts, line, text });
    if (messages.length >= MAX_MESSAGES_PER_FILE) break;
  }
  return { session, project: projectIdentity(cwd || path.dirname(file)).id, messages };
}

// ─── 增量同步 + 保留策略 ───

export function syncSessionIndex(force = false): void {
  const database = open();
  const files = listSessionFiles();
  const known = new Set(files.map((f) => f.path));
  const selectFile = database.prepare('select mtime_ms, size from session_files where path = ?');
  const deleteFts = database.prepare(
    'delete from session_fts where rowid in (select rowid from session_docs where session in (select session from session_files where path = ?))'
  );
  const deleteDocs = database.prepare(
    'delete from session_docs where session in (select session from session_files where path = ?)'
  );
  const insertDoc = database.prepare(
    'insert into session_docs(session, project, role, ts, line, text) values (?, ?, ?, ?, ?, ?)'
  );
  const insertFts = database.prepare('insert into session_fts(rowid, body) values (?, ?)');
  const upsertFile = database.prepare(
    'insert into session_files(path, session, project, mtime_ms, size, indexed_at) values (?, ?, ?, ?, ?, ?) ' +
      'on conflict(path) do update set session = excluded.session, project = excluded.project, ' +
      'mtime_ms = excluded.mtime_ms, size = excluded.size, indexed_at = excluded.indexed_at'
  );

  for (const file of files) {
    const previous = selectFile.get(file.path);
    if (!force && previous && Number(previous.mtime_ms) === file.mtimeMs && Number(previous.size) === file.size)
      continue;
    let parsed: ParsedSession;
    try {
      parsed = parseSessionFile(file.path);
    } catch {
      continue; // 单个文件读失败不影响其它文件
    }
    deleteFts.run(file.path);
    deleteDocs.run(file.path);
    for (const message of parsed.messages) {
      const text = redactSecrets(message.text).slice(0, MAX_TEXT_CHARS);
      const result = insertDoc.run(parsed.session, parsed.project, message.role, message.ts, message.line, text);
      insertFts.run(Number(result.lastInsertRowid), text);
    }
    upsertFile.run(file.path, parsed.session, parsed.project, file.mtimeMs, file.size, new Date().toISOString());
  }

  // 文件被删除：连同条目一起清掉
  for (const row of database.prepare('select path from session_files').all()) {
    const file = String(row.path);
    if (known.has(file)) continue;
    deleteFts.run(file);
    deleteDocs.run(file);
    database.prepare('delete from session_files where path = ?').run(file);
  }

  pruneSessionIndex(Date.now(), database);
  lastSyncAt = Date.now();
}

/** 保留策略：超期与超量的老消息先删（索引随时可重建，删掉只是检索不到） */
export function pruneSessionIndex(now = Date.now(), database = open()): number {
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  let removed = 0;
  const dropRows = (rowids: number[]) => {
    if (!rowids.length) return;
    const delFts = database.prepare('delete from session_fts where rowid = ?');
    const delDoc = database.prepare('delete from session_docs where rowid = ?');
    for (const rowid of rowids) {
      delFts.run(rowid);
      delDoc.run(rowid);
    }
    removed += rowids.length;
  };
  for (;;) {
    const expired = database
      .prepare("select rowid from session_docs where ts is not null and ts < ? limit 1000")
      .all(cutoff)
      .map((row) => Number(row.rowid));
    if (!expired.length) break;
    dropRows(expired);
  }
  const total = Number(database.prepare('select count(*) as c from session_docs').get()?.c ?? 0);
  if (total > MAX_ROWS) {
    const excess = database
      .prepare("select rowid from session_docs order by coalesce(ts, '') asc limit ?")
      .all(total - MAX_ROWS)
      .map((row) => Number(row.rowid));
    dropRows(excess);
  }
  return removed;
}

function ensureSynced(): SqliteDatabase {
  const database = open();
  if (Date.now() - lastSyncAt > SYNC_TTL_MS) syncSessionIndex();
  return database;
}

// ─── 检索 ───

export interface SessionSearchOptions {
  /** 只搜某个项目（projectIdentity().id）；不传则搜全部 */
  project?: string;
  role?: 'user' | 'assistant';
  /** 只返回该时间点之后的会话消息（ISO） */
  since?: string;
  limit?: number;
  cursor?: number;
}

export interface SessionSearchHit {
  session: string;
  /** 会话文件路径 */
  file: string;
  project: string;
  role: string;
  ts: string | null;
  line: number;
  snippet: string;
  score: number;
}

function fileOfSession(database: SqliteDatabase, session: string): string {
  const row = database.prepare('select path from session_files where session = ? limit 1').get(session);
  return row ? String(row.path) : '';
}

/**
 * 会话消息检索：`null` 表示索引不可用。
 * 排序 = 相关度（BM25 归一化）0.75 + 新近度 0.25。
 */
export function searchSessionMessages(
  query: string,
  opts: SessionSearchOptions = {}
): SessionSearchHit[] | null {
  try {
    const database = ensureSynced();
    const terms = splitQueryTerms(query);
    if (!terms.all.length) return [];
    const limit = Math.min(30, Math.max(1, Math.floor(opts.limit ?? 10)));
    const filters: string[] = [];
    const filterParams: unknown[] = [];
    if (opts.project) {
      filters.push('project = ?');
      filterParams.push(opts.project);
    }
    if (opts.role) {
      filters.push('role = ?');
      filterParams.push(opts.role);
    }
    if (opts.since) {
      filters.push("coalesce(ts, '') >= ?");
      filterParams.push(opts.since);
    }
    const where = filters.length ? ` and ${filters.join(' and ')}` : '';

    const rows = new Map<number, { row: Record<string, unknown>; relevance: number }>();

    if (terms.fts.length) {
      const found = database
        .prepare(
          'select d.rowid as rid, d.session, d.project, d.role, d.ts, d.line, d.text,' +
            ' bm25(session_fts) as rank from session_fts' +
            ' join session_docs d on d.rowid = session_fts.rowid' +
            ' where session_fts match ?' +
            where +
            ' order by rank limit ?'
        )
        .all(buildFtsMatch(terms.fts), ...filterParams, CANDIDATE_POOL);
      const ranks = found.map((row) => Number(row.rank)).filter((value) => Number.isFinite(value));
      const min = ranks.length ? Math.min(...ranks) : 0;
      const max = ranks.length ? Math.max(...ranks) : 0;
      for (const row of found) {
        rows.set(Number(row.rid), { row, relevance: bm25ToUnit(Number(row.rank), min, max) });
      }
    }

    if (terms.short.length) {
      const clause = terms.short.map(() => 'text like ?').join(' or ');
      const found = database
        .prepare(
          `select rowid as rid, session, project, role, ts, line, text from session_docs where (${clause})` +
            where +
            ' limit ?'
        )
        .all(...terms.short.map((term) => `%${term}%`), ...filterParams, CANDIDATE_POOL);
      for (const row of found) {
        const rid = Number(row.rid);
        const relevance = matchRatio(terms.all, String(row.text ?? ''));
        const existing = rows.get(rid);
        if (!existing || existing.relevance < relevance) rows.set(rid, { row, relevance });
      }
    }

    const now = Date.now();
    const hits: SessionSearchHit[] = [...rows.values()].map(({ row, relevance }) => ({
      session: String(row.session),
      file: fileOfSession(database, String(row.session)),
      project: String(row.project ?? ''),
      role: String(row.role ?? ''),
      ts: row.ts ? String(row.ts) : null,
      line: Number(row.line) || 0,
      snippet: snippet(String(row.text ?? ''), terms.all, 160),
      score: Math.round((0.75 * relevance + 0.25 * recencyUnit(row.ts ? String(row.ts) : null, now)) * 1000) / 10
    }));
    hits.sort((a, b) => b.score - a.score || (b.ts || '').localeCompare(a.ts || ''));
    const cursor = Math.max(0, Math.floor(opts.cursor ?? 0));
    return hits.slice(cursor, cursor + limit);
  } catch (error) {
    failure = { at: Date.now(), message: error instanceof Error ? error.message : String(error) };
    return null;
  }
}

/** 按会话 id 找文件（`session_read` 用） */
export function findSessionFile(sessionId: string): string | null {
  try {
    const database = ensureSynced();
    const file = fileOfSession(database, sessionId);
    return file || null;
  } catch {
    return null;
  }
}

export interface SessionContextMessage {
  role: string;
  ts: string | null;
  line: number;
  text: string;
}

/**
 * 取某条命中消息前后的原文（走真实会话文件，不依赖索引里的截断文本）。
 * `radius` 为前后各取多少条消息。
 */
export function readSessionContext(
  sessionId: string,
  line: number,
  radius = 3
): { session: string; file: string; messages: SessionContextMessage[] } | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  let parsed: ParsedSession;
  try {
    parsed = parseSessionFile(file);
  } catch {
    return null;
  }
  const messages = parsed.messages;
  const index = messages.findIndex((message) => message.line >= line);
  const center = index === -1 ? messages.length - 1 : index;
  if (center < 0) return { session: parsed.session, file, messages: [] };
  const start = Math.max(0, center - Math.max(0, radius));
  const end = Math.min(messages.length, center + Math.max(0, radius) + 1);
  return {
    session: parsed.session,
    file,
    messages: messages.slice(start, end).map((message) => ({
      role: message.role,
      ts: message.ts,
      line: message.line,
      text: redactSecrets(message.text).slice(0, 1200)
    }))
  };
}

// ─── 状态与重建 ───

export interface SessionIndexStats {
  available: boolean;
  entries: number;
  files: number;
  indexedAt: string | null;
  error?: string;
}

export function sessionIndexStats(sync = true): SessionIndexStats {
  try {
    // 只读查询时不建库：没索引过就返回空统计，避免面板轮询凭空创建 index.db
    if (!sync && !fs.existsSync(indexPath())) {
      return { available: true, entries: 0, files: 0, indexedAt: null };
    }
    const database = sync ? ensureSynced() : open();
    const entries = Number(database.prepare('select count(*) as c from session_docs').get()?.c ?? 0);
    const files = Number(database.prepare('select count(*) as c from session_files').get()?.c ?? 0);
    const indexedAt = database
      .prepare('select indexed_at from session_files order by indexed_at desc limit 1')
      .get()?.indexed_at;
    return {
      available: true,
      entries,
      files,
      indexedAt: indexedAt ? String(indexedAt) : null
    };
  } catch (error) {
    return {
      available: false,
      entries: 0,
      files: 0,
      indexedAt: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 全量重建会话索引（会话文件是真相，重建永远安全） */
export function rebuildSessionIndex(): SessionIndexStats {
  try {
    const database = open();
    database.exec('delete from session_fts');
    database.exec('delete from session_docs');
    database.exec('delete from session_files');
    syncSessionIndex(true);
    try {
      // 全量重建后合并倒排段（FTS5 的 optimize），体积与查询都更稳
      database.exec("insert into session_fts(session_fts) values('optimize')");
    } catch {
      /* optimize 失败不影响可用性 */
    }
    try {
      database.exec('pragma wal_checkpoint(truncate)');
    } catch {
      /* 有读者时下次再试 */
    }
    return sessionIndexStats();
  } catch {
    return sessionIndexStats(false);
  }
}

/** 仅测试用 */
export function resetSessionIndexStateForTests(): void {
  closeSessionIndex();
  lastSyncAt = 0;
  failure = null;
  sqlite = undefined;
}
