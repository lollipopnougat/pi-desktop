/**
 * 记忆索引层：`~/.pi-desktop/memory/index.db`（SQLite + FTS5 trigram）。
 *
 * 为什么可以这么做：Electron 44 的 Node 24 自带 `node:sqlite`（SQLite 3.53 + FTS5 + trigram），
 * 不需要 better-sqlite3、不需要 native 编译、也不需要 asarUnpack。见 docs/MEMORY-REDESIGN.md §1。
 *
 * 三条硬约定：
 * 1. **markdown 是唯一真相**，本文件只写派生索引；索引可随时删除重建。
 * 2. **任何异常都降级**：出错时返回 `null`，调用方回退到 `store.searchMemory` 的子串检索。
 * 3. **不阻塞主流程**：同步是同步函数但与 markdown 写入解耦（按 revision 惰性增量）。
 */
import fs from 'fs';
import path from 'path';
import { getMemoryDir } from './config';
import { entryBody, entryMetadata, entryKey, stripMetadata } from './store';
import type { MemorySearchHit, MemorySearchOptions } from './store';
import { readPersisted, revisionOf } from './persistence';
import { redactSecrets } from './secrets';
import { bm25ToUnit, buildFtsMatch, computeScore, matchRatio, splitQueryTerms } from './search';

const DB_FILE = 'index.db';
const SYNC_TTL_MS = 1500;
/** 索引失败后多久允许重试（避免每次检索都重建一次失败） */
const RETRY_MS = 30_000;
/** 单条目进入 FTS 的字符上限（`memories.text` 仍存全文，供 LIKE 兜底与展示） */
const MAX_INDEXED_CHARS = 2000;
/** 单次检索最多取回的候选数（排序前的池子） */
const CANDIDATE_POOL = 200;

const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists memories(
  rowid integer primary key,
  id text not null,
  file text not null,
  line integer not null,
  scope text not null,
  project text,
  display text not null,
  created text,
  status text,
  sources text,
  key text not null,
  text text not null
);
create index if not exists memories_file on memories(file);
create index if not exists memories_entry on memories(id);
create virtual table if not exists memories_fts using fts5(
  body,
  content='',
  contentless_delete=1,
  tokenize='trigram'
);
create table if not exists files(path text primary key, revision text, indexed_at text);
create table if not exists usage(id text primary key, hit integer not null default 0, last text);
`;

// ─── node:sqlite 的最小类型面（内建模块，无 @types 依赖） ───

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
let dbDir: string | null = null;
let lastSyncAt = 0;
let failure: { at: number; message: string } | null = null;

function open(): SqliteDatabase {
  const dir = getMemoryDir();
  if (db && dbDir === dir) return db;
  if (db) closeMemoryIndex();
  if (failure && Date.now() - failure.at < RETRY_MS) throw new Error(failure.message);
  if (sqlite === undefined) sqlite = loadSqlite();
  if (!sqlite) throw new Error('当前运行时没有 node:sqlite，记忆索引不可用');
  fs.mkdirSync(dir, { recursive: true });
  const instance = new sqlite.DatabaseSync(path.join(dir, DB_FILE));
  instance.exec('pragma journal_mode = wal');
  instance.exec('pragma synchronous = normal');
  // WAL 自动 checkpoint 调小：检索会写 usage（命中计数），避免 WAL 长期涨到 4MB
  instance.exec('pragma wal_autocheckpoint = 256');
  try {
    instance.exec('pragma busy_timeout = 5000');
  } catch {
    /* 旧版本不支持时忽略 */
  }
  instance.exec(SCHEMA);
  db = instance;
  dbDir = dir;
  return db;
}

/** 释放句柄（测试与退出时调用；下次访问会重新打开） */
export function closeMemoryIndex(): void {
  try {
    db?.close();
  } catch {
    /* 关闭失败不阻塞退出 */
  }
  db = null;
  dbDir = null;
  lastSyncAt = 0;
}

// ─── 文档枚举与增量同步 ───

interface DocTarget {
  /** 相对记忆根的路径，例如 `USER.md`、`projects/p-xxx/MEMORY.md` */
  file: string;
  /** 展示名，与 store.targets() 保持一致 */
  display: string;
  scope: 'project' | 'global';
  project?: string;
}

/** 全局四个文件 + `projects/<id>/MEMORY.md`（项目目录按磁盘实际情况扫描，不依赖当前会话） */
export function listIndexableDocs(): DocTarget[] {
  const docs: DocTarget[] = (['USER.md', 'MEMORY.md', 'LESSONS.md', 'STANDING.md'] as const).map(
    (id) => ({ file: id, display: id, scope: 'global' as const })
  );
  let names: string[] = [];
  const projectsDir = path.join(getMemoryDir(), 'projects');
  try {
    names = fs
      .readdirSync(projectsDir)
      .filter((name) => {
        try {
          return fs.statSync(path.join(projectsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    /* 没有项目记忆目录 */
  }
  for (const project of names) {
    docs.push({
      file: `projects/${project}/MEMORY.md`,
      display: `project:${project}/MEMORY.md`,
      scope: 'project',
      project
    });
  }
  return docs;
}

interface EntryRow {
  id: string;
  line: number;
  created: string | null;
  status: string;
  sources: string;
  key: string;
  text: string;
  body: string;
}

function parseDoc(content: string, file: string): EntryRow[] {
  const rows: EntryRow[] = [];
  const seen = new Set<string>();
  content.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const isEntry = /^\s*-\s+/.test(raw);
    const text = stripMetadata(isEntry ? entryBody(raw) : trimmed);
    if (!text) return;
    const key = entryKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const meta = entryMetadata(raw, file);
    rows.push({
      id: meta.id,
      line: index + 1,
      created: meta.created,
      status: meta.status,
      sources: meta.sources.join(','),
      key,
      text: redactSecrets(text),
      body: redactSecrets(text).slice(0, MAX_INDEXED_CHARS)
    });
  });
  return rows;
}

function documentFor(doc: DocTarget): string {
  try {
    return readPersisted(doc.file);
  } catch {
    return '';
  }
}

/** 按 revision 增量同步；`force` 时重建全部文档。 */
export function syncMemoryIndex(force = false): void {
  const database = open();
  const docs = listIndexableDocs();
  const known = new Set(docs.map((doc) => doc.file));
  const selectRevision = database.prepare('select revision from files where path = ?');
  const deleteFts = database.prepare(
    'delete from memories_fts where rowid in (select rowid from memories where file = ?)'
  );
  const deleteRows = database.prepare('delete from memories where file = ?');
  const upsertFile = database.prepare(
    'insert into files(path, revision, indexed_at) values (?, ?, ?) ' +
      'on conflict(path) do update set revision = excluded.revision, indexed_at = excluded.indexed_at'
  );
  const insertRow = database.prepare(
    'insert into memories(id, file, line, scope, project, display, created, status, sources, key, text) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertFts = database.prepare('insert into memories_fts(rowid, body) values (?, ?)');

  for (const doc of docs) {
    const content = documentFor(doc);
    const revision = revisionOf(content);
    const previous = selectRevision.get(doc.file);
    if (!force && previous && previous.revision === revision) continue;
    deleteFts.run(doc.file);
    deleteRows.run(doc.file);
    for (const row of parseDoc(content, doc.file)) {
      const result = insertRow.run(
        row.id,
        doc.file,
        row.line,
        doc.scope,
        doc.project ?? null,
        doc.display,
        row.created,
        row.status,
        row.sources,
        row.key,
        row.text
      );
      const rowid = Number(result.lastInsertRowid);
      insertFts.run(rowid, row.body);
    }
    upsertFile.run(doc.file, revision, new Date().toISOString());
  }

  // 文件已被删除（或项目记忆目录被移走）：清掉残留条目
  const staleFiles = database
    .prepare('select path from files')
    .all()
    .map((row) => String(row.path))
    .filter((file) => !known.has(file));
  for (const file of staleFiles) {
    deleteFts.run(file);
    deleteRows.run(file);
    database.prepare('delete from files where path = ?').run(file);
  }

  database
    .prepare(
      'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
    )
    .run('last_index_at', new Date().toISOString());
  lastSyncAt = Date.now();
}

function ensureSynced(): SqliteDatabase {
  const database = open();
  if (Date.now() - lastSyncAt > SYNC_TTL_MS) syncMemoryIndex();
  return database;
}

// ─── 检索 ───

function scopeClause(
  scope: MemorySearchOptions['scope'],
  projectName: string | undefined
): { sql: string; params: unknown[] } {
  if (scope === 'project' && projectName)
    return { sql: ' and scope = ? and project = ?', params: ['project', projectName] };
  if (scope === 'project') return { sql: ' and scope = ?', params: ['project'] };
  if (scope === 'global') return { sql: ' and scope = ?', params: ['global'] };
  if (projectName)
    return { sql: ' and (scope = ? or project = ?)', params: ['global', projectName] };
  return { sql: ' and scope = ?', params: ['global'] };
}

interface UsageRow {
  hit: number;
  last: string | null;
}

function readUsage(database: SqliteDatabase): Map<string, UsageRow> {
  const map = new Map<string, UsageRow>();
  for (const row of database.prepare('select id, hit, last from usage').all()) {
    map.set(String(row.id), {
      hit: Number(row.hit) || 0,
      last: row.last ? String(row.last) : null
    });
  }
  return map;
}

function recordUsage(database: SqliteDatabase, ids: string[]): void {
  if (!ids.length) return;
  const statement = database.prepare(
    'insert into usage(id, hit, last) values (?, 1, ?) ' +
      'on conflict(id) do update set hit = hit + 1, last = excluded.last'
  );
  const today = new Date().toISOString();
  for (const id of ids) statement.run(id, today);
}

function toHit(row: Record<string, unknown>, score: number): MemorySearchHit {
  return {
    file: String(row.display),
    line: Number(row.line) || 0,
    text: String(row.text ?? ''),
    id: String(row.id),
    created: row.created ? String(row.created) : null,
    status: row.status ? String(row.status) : 'unverified',
    sources: row.sources ? String(row.sources).split(',').filter(Boolean) : [],
    scope: String(row.scope) === 'project' ? 'project' : 'global',
    score
  };
}

/**
 * 索引检索：返回 `null` 表示索引不可用（调用方应回退到子串检索）。
 * 返回空数组表示索引可用但没有命中。
 */
export function searchIndexedMemories(
  query: string,
  projectName?: string,
  opts: MemorySearchOptions = {}
): MemorySearchHit[] | null {
  try {
    const database = ensureSynced();
    const terms = splitQueryTerms(query);
    if (!terms.all.length) return [];
    const limit = Number.isFinite(opts.limit)
      ? Math.min(100, Math.max(1, Math.floor(opts.limit!)))
      : 100;
    const cursor = Number.isFinite(opts.cursor) ? Math.max(0, Math.floor(opts.cursor!)) : 0;

    const rows = new Map<number, { row: Record<string, unknown>; relevance: number }>();

    // 通道 A：FTS5（≥3 字符的词）
    if (terms.fts.length) {
      const scope = scopeClause(opts.scope, projectName);
      const match = buildFtsMatch(terms.fts);
      const found = database
        .prepare(
          'select m.rowid as rid, m.id, m.line, m.scope, m.display, m.created, m.status, m.sources, m.text,' +
            ' bm25(memories_fts) as rank from memories_fts' +
            ' join memories m on m.rowid = memories_fts.rowid' +
            ' where memories_fts match ?' +
            scope.sql +
            ' order by rank limit ?'
        )
        .all(match, ...scope.params, CANDIDATE_POOL);
      const ranks = found.map((row) => Number(row.rank)).filter((value) => Number.isFinite(value));
      const min = ranks.length ? Math.min(...ranks) : 0;
      const max = ranks.length ? Math.max(...ranks) : 0;
      for (const row of found) {
        rows.set(Number(row.rid), {
          row,
          relevance: bm25ToUnit(Number(row.rank), min, max)
        });
      }
    }

    // 通道 B：LIKE 兜底（1–2 字符的中文词 trigram 匹配不到）
    if (terms.short.length) {
      const scope = scopeClause(opts.scope, projectName);
      const clause = terms.short.map(() => 'text like ?').join(' or ');
      const found = database
        .prepare(
          `select rowid as rid, id, line, scope, display, created, status, sources, text from memories where (${clause})` +
            scope.sql +
            ' limit ?'
        )
        .all(...terms.short.map((term) => `%${term}%`), ...scope.params, CANDIDATE_POOL);
      for (const row of found) {
        const rid = Number(row.rid);
        const relevance = matchRatio(terms.all, String(row.text ?? ''));
        const existing = rows.get(rid);
        if (!existing || existing.relevance < relevance) rows.set(rid, { row, relevance });
      }
    }

    if (!rows.size) return [];

    const usage = readUsage(database);
    const hits = [...rows.values()].map(({ row, relevance }) => {
      const id = String(row.id);
      const used = usage.get(id);
      const score = computeScore({
        relevance,
        scope: String(row.scope) === 'project' ? 'project' : 'global',
        lastReferenced: used?.last ?? null,
        created: row.created ? String(row.created) : null,
        hitCount: used?.hit ?? 0,
        text: String(row.text ?? '')
      });
      return toHit(row, score);
    });

    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (b.created || '').localeCompare(a.created || '') ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
    const page = hits.slice(cursor, cursor + limit);
    recordUsage(
      database,
      page.map((hit) => hit.id)
    );
    return page;
  } catch (error) {
    failure = {
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error)
    };
    return null;
  }
}

// ─── 状态与重建 ───

export interface MemoryIndexStats {
  available: boolean;
  entries: number;
  files: number;
  bytes: number;
  indexedAt: string | null;
  usageEntries: number;
  /** 索引不可用时的原因（面板展示） */
  error?: string;
}

function sizeOfIndex(dir: string): number {
  let bytes = 0;
  for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      bytes += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* 文件不存在 */
    }
  }
  return bytes;
}

/** `sync = false` 时不触发增量同步（状态轮询用，避免每次都读文件） */
export function memoryIndexStats(sync = true): MemoryIndexStats {
  const dir = getMemoryDir();
  try {
    const database = sync ? ensureSynced() : open();
    const entries = Number(database.prepare('select count(*) as c from memories').get()?.c ?? 0);
    const files = Number(database.prepare('select count(*) as c from files').get()?.c ?? 0);
    const usageEntries = Number(database.prepare('select count(*) as c from usage').get()?.c ?? 0);
    const indexedAt =
      database.prepare("select value from meta where key = 'last_index_at'").get()?.value ?? null;
    return {
      available: true,
      entries,
      files,
      bytes: sizeOfIndex(dir),
      indexedAt: indexedAt ? String(indexedAt) : null,
      usageEntries
    };
  } catch (error) {
    return {
      available: false,
      entries: 0,
      files: 0,
      bytes: sizeOfIndex(dir),
      indexedAt: null,
      usageEntries: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 全量重建（索引是派生数据，重建永远安全） */
export function rebuildMemoryIndex(): MemoryIndexStats {
  try {
    const database = open();
    database.exec('delete from memories_fts');
    database.exec('delete from memories');
    database.exec('delete from files');
    syncMemoryIndex(true);
    try {
      // 全量重建后合并倒排段（FTS5 的 optimize）
      database.exec("insert into memories_fts(memories_fts) values('optimize')");
    } catch {
      /* optimize 失败不影响可用性 */
    }
    // 重建会产生大量失效页，落盘并截断 WAL（否则统计里的体积是虚高）
    try {
      database.exec('pragma wal_checkpoint(truncate)');
    } catch {
      /* 有读者时 checkpoint 可能失败，下次再试 */
    }
    return memoryIndexStats();
  } catch (error) {
    failure = {
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error)
    };
    return memoryIndexStats();
  }
}

/** 仅测试用：清空全局单例状态（失败冷却/同步节流） */
export function resetMemoryIndexStateForTests(): void {
  closeMemoryIndex();
  lastSyncAt = 0;
  failure = null;
  sqlite = undefined;
}
