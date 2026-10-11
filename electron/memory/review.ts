import fs from 'fs';
import { randomUUID } from 'crypto';
import { memoryFilePath, sanitizeProjectName, type MemoryProject } from './config';
import {
  readPersisted,
  revisionOf,
  memoryPath,
  commitMemoryChanges,
  listMemoryHistory,
  isMemoryDocument,
  type FileChange
} from './persistence';
import {
  documentChanges,
  prepareDocument,
  redactSecrets,
  readTombstones,
  entryKey,
  readMemoryFile,
  memoryRelativePath
} from './store';
import { readState } from './state';

export interface MemoryCandidate {
  id: string;
  projectId: string;
  createdAt: string;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  extractionIds: string[];
  changes: FileChange[];
  warnings: string[];
}
export function createCandidate(
  projectId: string,
  changes: FileChange[],
  extractionIds: string[],
  reason = 'consolidation'
): MemoryCandidate {
  const tombstones = readTombstones();
  const candidate: MemoryCandidate = {
    id: randomUUID(),
    projectId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    extractionIds,
    reason,
    changes: changes.map((c) => ({
      ...c,
      beforeRevision: c.beforeRevision || revisionOf(c.before),
      before: redactSecrets(c.before),
      after: redactSecrets(c.after)
        .split('\n')
        .filter(
          (line) =>
            reason === 'rollback' ||
            reason === 'migration' ||
            !/^\s*-\s+/.test(line) ||
            !tombstones[c.file]?.[revisionOf(entryKey(line))]
        )
        .join('\n')
    })),
    warnings: []
  };
  for (const c of candidate.changes) {
    if (
      c.before.trim() &&
      (!c.after.trim() ||
        c.after.split('\n').filter((l) => l.startsWith('- ')).length <
          c.before.split('\n').filter((l) => l.startsWith('- ')).length / 2)
    )
      candidate.warnings.push(c.file);
  }
  const replaced = listCandidates(projectId).filter((c) =>
    c.extractionIds.some((id) => extractionIds.includes(id))
  );
  const writes = replaced.map((c) => {
    const file = `candidates/${c.id}.json`;
    return {
      file,
      before: readPersisted(file),
      after: JSON.stringify({ ...c, status: 'superseded' })
    };
  });
  commitMemoryChanges(
    [
      ...writes,
      { file: `candidates/${candidate.id}.json`, before: '', after: JSON.stringify(candidate) }
    ],
    'candidate',
    projectId
  );
  return candidate;
}
export function listCandidates(projectId: string): MemoryCandidate[] {
  readPersisted('state.json');
  const dir = memoryPath('candidates');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readPersisted(`candidates/${n}`)) as MemoryCandidate)
    .filter((c) => c.projectId === projectId && c.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function reviewCandidate(
  id: string,
  projectId: string,
  accept: boolean,
  edits?: Record<string, string>
): void {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效候选');
  const file = `candidates/${id}.json`;
  const raw = readPersisted(file);
  if (!raw) throw new Error('候选不存在');
  const candidate = JSON.parse(raw) as MemoryCandidate;
  if (candidate.projectId !== projectId || candidate.status !== 'pending')
    throw new Error('候选项目或状态已变化');
  const stateRaw = readPersisted('state.json');
  const state = readState();
  for (const key of candidate.extractionIds) {
    if (
      state.extractions?.[key]?.status !== 'pending' ||
      state.extractions[key].projectId !== projectId
    )
      throw new Error('提取已被其他候选处理，请重新生成');
  }
  const docs = candidate.changes.map((c) => {
    const revised = edits?.[c.file];
    const after =
      revised !== undefined
        ? prepareDocument(
            revised,
            c.after,
            c.file,
            candidate.extractionIds.map((e) => e.replace(/\.md$/, '')),
            true
          )
        : c.after;
    return { ...c, after };
  });
  if (docs.some((c) => c.after.length > 200000)) throw new Error('候选文件过大');
  const changes = accept
    ? documentChanges(docs, candidate.reason === 'rollback' || candidate.reason === 'migration')
    : [];
  candidate.status = accept ? 'accepted' : 'rejected';
  for (const key of candidate.extractionIds)
    state.extractions![key].status = accept ? 'merged' : 'rejected';
  state.pendingExtractions = state.pendingExtractions.filter(
    (key) => !candidate.extractionIds.includes(key)
  );
  if (accept && candidate.extractionIds.length) {
    state.lastConsolidation = new Date().toISOString();
    state.stats ||= { extractions: 0, consolidations: 0 };
    state.stats.consolidations++;
  }
  commitMemoryChanges(
    [
      ...changes,
      { file, before: raw, after: JSON.stringify(candidate) },
      { file: 'state.json', before: stateRaw, after: JSON.stringify(state) }
    ],
    accept ? candidate.reason : 'reject',
    projectId
  );
}

export function historyForProject(projectId: string) {
  return listMemoryHistory(projectId).map((tx) => ({
    ...tx,
    changes: tx.changes.filter((c) => isMemoryDocument(c.file))
  }));
}
export function proposeRollback(id: string, projectId: string): MemoryCandidate {
  const tx = historyForProject(projectId).find((t) => t.id === id);
  if (!tx) throw new Error('历史版本不存在');
  return createCandidate(
    projectId,
    tx.changes.map((c) => ({ file: c.file, before: readPersisted(c.file), after: c.before })),
    [],
    'rollback'
  );
}

export function legacyProjects(): Array<{ name: string; content: string }> {
  const dir = memoryPath('projects');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^p-[a-f0-9]{24}$/.test(e.name))
    .map((e) => ({ name: e.name, content: readPersisted(`projects/${e.name}/MEMORY.md`) }))
    .filter((e) => e.content.length > 0);
}
export function proposeLegacyMigration(name: string, project: MemoryProject): MemoryCandidate {
  if (sanitizeProjectName(name) !== name) throw new Error('无效旧项目名');
  const legacy = legacyProjects().find((p) => p.name === name);
  if (!legacy) throw new Error('旧项目不存在');
  const before = readMemoryFile('project', project.id);
  return createCandidate(
    project.id,
    [
      {
        file: memoryRelativePath('project', project.id),
        before,
        after: prepareDocument(
          [before, legacy.content].filter(Boolean).join('\n'),
          before,
          memoryFilePath('project', project.id),
          [],
          true
        )
      }
    ],
    [],
    'migration'
  );
}
