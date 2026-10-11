/** 同步提交日志：主进程内不跨 await；多文件提交中断后在下次访问时恢复。 */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { getMemoryDir } from './config';
import { redactSecrets } from './secrets';

export const revisionOf = (content: string) => createHash('sha256').update(content).digest('hex');
export interface FileChange {
  file: string;
  before: string;
  after: string;
  beforeRevision?: string;
}
export interface MemoryTransaction {
  id: string;
  at: string;
  reason: string;
  projectId?: string;
  status: 'prepared' | 'committed';
  changes: FileChange[];
}

export function memoryPath(relative: string): string {
  const root = path.resolve(getMemoryDir());
  const full = path.resolve(root, relative);
  if (full === root || !full.startsWith(root + path.sep)) throw new Error('无效的记忆路径');
  // 配置目录允许整体重定向，但不沿其内部的符号链接写入其他目录。
  let current = full;
  while (current !== root) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('记忆目录内部不能使用符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = path.dirname(current);
  }
  return full;
}

export function readRaw(relative: string): string {
  try {
    return fs.readFileSync(memoryPath(relative), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function atomicWrite(relative: string, content: string): void {
  const full = memoryPath(relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, full);
}

function finish(tx: MemoryTransaction): void {
  // 全部先校验，恢复时不覆盖日志之外的人工改动。
  for (const change of tx.changes) {
    const current = readRaw(change.file);
    if (
      revisionOf(current) !== (change.beforeRevision || revisionOf(change.before)) &&
      current !== change.after
    ) {
      throw new Error(`记忆恢复冲突：${change.file}，请保留文件并检查 transactions/${tx.id}.json`);
    }
  }
  for (const change of tx.changes) {
    if (readRaw(change.file) !== change.after) atomicWrite(change.file, change.after);
  }
  if (tx.changes.some((c) => isMemoryDocument(c.file)))
    atomicWrite(`history/${tx.id}.json`, JSON.stringify({ ...tx, status: 'committed' }));
  fs.unlinkSync(memoryPath(`transactions/${tx.id}.json`));
}

export function recoverMemoryTransactions(): void {
  const dir = memoryPath('transactions');
  if (!fs.existsSync(dir)) return;
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const tx = JSON.parse(readRaw(`transactions/${name}`)) as MemoryTransaction;
    if (!tx.id || name !== `${tx.id}.json` || !Array.isArray(tx.changes))
      throw new Error('记忆提交日志损坏');
    finish(tx);
  }
}

export function readPersisted(relative: string): string {
  recoverMemoryTransactions();
  return readRaw(relative);
}

export function commitMemoryChanges(
  changes: FileChange[],
  reason: string,
  projectId?: string
): string {
  recoverMemoryTransactions();
  if (new Set(changes.map((c) => c.file)).size !== changes.length)
    throw new Error('重复的提交文件');
  for (const change of changes) {
    if (revisionOf(readRaw(change.file)) !== (change.beforeRevision || revisionOf(change.before)))
      throw new Error(`记忆版本冲突：${change.file} 已更新，请重新读取或生成候选`);
  }
  const tx: MemoryTransaction = {
    id: `${Date.now()}-${randomUUID()}`,
    at: new Date().toISOString(),
    reason,
    projectId,
    status: 'prepared',
    changes: changes
      .filter((c) => (c.beforeRevision || revisionOf(c.before)) !== revisionOf(c.after))
      .map((c) =>
        isMemoryDocument(c.file)
          ? {
              ...c,
              beforeRevision: c.beforeRevision || revisionOf(c.before),
              before: redactSecrets(c.before),
              after: redactSecrets(c.after)
            }
          : c
      )
  };
  atomicWrite(`transactions/${tx.id}.json`, JSON.stringify(tx));
  finish(tx);
  return tx.id;
}

export function listMemoryHistory(projectId: string): MemoryTransaction[] {
  recoverMemoryTransactions();
  const dir = memoryPath('history');
  if (!fs.existsSync(dir)) return [];
  const result: MemoryTransaction[] = [];
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse()) {
    const tx = JSON.parse(readRaw(`history/${name}`)) as MemoryTransaction;
    if (
      (!tx.projectId || tx.projectId === projectId) &&
      tx.changes.some((c) => isMemoryDocument(c.file))
    )
      result.push(tx);
    if (result.length >= 30) break;
  }
  return result;
}

export function isMemoryDocument(file: string): boolean {
  return (
    /^(USER|MEMORY|LESSONS|STANDING)\.md$/.test(file) || /^projects\/[^/]+\/MEMORY\.md$/.test(file)
  );
}
