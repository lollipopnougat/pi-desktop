/** 增量提取 -> 不可变来源 -> 项目候选 -> 审核事务。模型调用不持有文件锁。 */
import fs from 'fs';
import { randomUUID } from 'crypto';
import { projectIdentity } from './config';
import {
  redactSecrets,
  readMemoryFile,
  extractionsDir,
  memoryRelativePath,
  prepareDocument,
  readTombstones
} from './store';
import { readPersisted, commitMemoryChanges, revisionOf } from './persistence';
import { readState, pendingForProject, type MemoryPipelineState } from './state';
import { createCandidate, listCandidates } from './review';
import {
  listSessionFiles,
  parseSessionTranscript,
  transcriptChunks,
  formatTranscript,
  watermarkKey,
  type SessionFileMeta
} from './session-reader';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseExtractionOutput,
  CONSOLIDATION_SYSTEM_PROMPT,
  buildConsolidationUserPrompt,
  parseConsolidationOutput,
  type ExtractionOutput
} from './prompts';
export { readState, writeState, pendingForProject, type MemoryPipelineState } from './state';

export type CompleteFn = (
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
) => Promise<string>;
export interface ExtractionProgress {
  total: number;
  done: number;
  current?: string;
  phase: 'scan' | 'extract' | 'done' | 'error';
  message?: string;
}
export interface ExtractionResult {
  scanned: number;
  extracted: number;
  skipped: number;
  failed: number;
  pendingConsolidation: number;
}
export interface PipelineOptions {
  signal?: AbortSignal;
  sessionDir?: string;
}
export interface MemoryFailedSession {
  name: string;
  at: string;
  error: string;
}

export function needsProcessing(meta: SessionFileMeta, state: MemoryPipelineState): boolean {
  const prev = state.processed[watermarkKey(meta)];
  return !prev || !!prev.error || prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size;
}
export function listFailedSessions(state = readState(), projectId?: string): MemoryFailedSession[] {
  return Object.entries(state.processed)
    .filter(([, v]) => v?.error && (!projectId || v.projectId === projectId))
    .map(([key, v]) => ({ name: v.name || key, at: v.at, error: v.error! }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function runExtraction(
  cwd: string,
  projectName: string,
  completeFn: CompleteFn,
  onProgress?: (p: ExtractionProgress) => void,
  options: PipelineOptions = {}
): Promise<ExtractionResult> {
  const projectId = projectIdentity(cwd).id;
  const files = listSessionFiles(cwd, options.sessionDir);
  const initial = readState();
  const todo = files.filter((f) => needsProcessing(f, initial));
  const result: ExtractionResult = {
    scanned: files.length,
    extracted: 0,
    skipped: files.length - todo.length,
    failed: 0,
    pendingConsolidation: 0
  };
  onProgress?.({ phase: 'scan', total: todo.length, done: 0 });
  let done = 0;
  for (const meta of todo) {
    options.signal?.throwIfAborted();
    const key = watermarkKey(meta);
    onProgress?.({ phase: 'extract', total: todo.length, done, current: meta.name });
    let produced = false;
    try {
      const { lines } = parseSessionTranscript(meta.path, Infinity);
      const seen = new Set(readState().processed[key]?.seen || []);
      const chunks = transcriptChunks(lines.filter((line) => !seen.has(line.fingerprint!)));
      for (const chunk of chunks) {
        options.signal?.throwIfAborted();
        const transcript = formatTranscript(chunk);
        const prompt = buildExtractionUserPrompt(transcript, projectName);
        let parsed = parseExtractionOutput(
          await completeFn(EXTRACTION_SYSTEM_PROMPT, prompt, options.signal)
        );
        options.signal?.throwIfAborted();
        if (!parsed)
          parsed = parseExtractionOutput(
            await completeFn(
              EXTRACTION_SYSTEM_PROMPT + '\n上次输出无效，只输出合法 JSON。',
              prompt,
              options.signal
            )
          );
        options.signal?.throwIfAborted();
        if (!parsed) throw new Error('模型输出无法解析为提取 JSON');
        const stateRaw = readPersisted('state.json');
        const state = readState();
        const existingSeen = new Set(state.processed[key]?.seen || []);
        // 同一 source 并发完成时不重复入队。
        if (chunk.every((l) => existingSeen.has(l.fingerprint!))) continue;
        for (const l of chunk) existingSeen.add(l.fingerprint!);
        const at = new Date().toISOString();
        state.processed[key] = {
          name: meta.name,
          mtimeMs: meta.mtimeMs,
          size: meta.size,
          projectId,
          at,
          seen: [...existingSeen],
          error: '提取尚未完成'
        };
        const changes = [];
        if (
          !parsed.noOp &&
          [
            parsed.userPreferences,
            parsed.lessons,
            parsed.globalFacts,
            parsed.projectKnowledge
          ].some((a) => a.length)
        ) {
          const id = randomUUID();
          const name = `${id}.md`;
          const source = {
            id,
            projectId,
            session: meta.name,
            sourceKey: key,
            revision: revisionOf(transcript),
            entryIds: chunk.map((l) => l.entryId),
            sourceTime: chunk
              .map((l) => l.timestamp)
              .filter(Boolean)
              .at(-1),
            generatedAt: at,
            evidenceKind: 'conversation',
            status: 'unverified',
            transcript
          };
          changes.push({
            file: `sources/${id}.json`,
            before: '',
            after: JSON.stringify({
              ...source,
              transcript: redactSecrets(source.transcript),
              session: redactSecrets(source.session)
            })
          });
          changes.push({
            file: `extractions/${name}`,
            before: '',
            after: redactSecrets(
              formatExtractionMarkdown(parsed, projectName, meta.name) +
                `\n<!-- projectId=${projectId} source=${id} sourceTime=${source.sourceTime || 'unknown'} -->\n`
            )
          });
          state.extractions ||= {};
          state.extractions[name] = { projectId, sourceKey: key, at, status: 'pending' };
          state.pendingExtractions.push(name);
          state.stats ||= { extractions: 0, consolidations: 0 };
          state.stats.extractions++;
          produced = true;
        }
        changes.push({ file: 'state.json', before: stateRaw, after: JSON.stringify(state) });
        commitMemoryChanges(changes, 'extraction', projectId);
      }
      options.signal?.throwIfAborted();
      const raw = readPersisted('state.json');
      const state = readState();
      state.processed[key] = {
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        name: meta.name,
        projectId,
        at: new Date().toISOString(),
        seen: state.processed[key]?.seen || [],
        noop: !produced
      };
      commitMemoryChanges(
        [{ file: 'state.json', before: raw, after: JSON.stringify(state) }],
        'checkpoint',
        projectId
      );
      if (produced) result.extracted++;
    } catch (error) {
      options.signal?.throwIfAborted();
      const raw = readPersisted('state.json');
      const state = readState();
      state.processed[key] = {
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        name: meta.name,
        projectId,
        at: new Date().toISOString(),
        seen: state.processed[key]?.seen || [],
        error: redactSecrets(String(error instanceof Error ? error.message : error))
      };
      commitMemoryChanges(
        [{ file: 'state.json', before: raw, after: JSON.stringify(state) }],
        'failure',
        projectId
      );
      result.failed++;
    }
    done++;
  }
  result.pendingConsolidation = pendingForProject(readState(), projectId).length;
  onProgress?.({ phase: 'done', total: todo.length, done });
  return result;
}

/** extraction 文件的 Markdown 格式（Phase2 输入 + 人类审计） */
export function formatExtractionMarkdown(
  out: ExtractionOutput,
  projectName: string,
  sourceSession: string
): string {
  const lines: string[] = [];
  lines.push(`---`);
  lines.push(`source: ${sourceSession}`);
  lines.push(`project: ${projectName}`);
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`---`);
  lines.push('');
  if (out.summary) {
    lines.push(`## ${out.summary}`);
    lines.push('');
  }
  if (out.userPreferences.length) {
    lines.push('### 用户偏好');
    for (const p of out.userPreferences) lines.push(`- ${p}`);
    lines.push('');
  }
  if (out.lessons.length) {
    lines.push('### 教训');
    for (const l of out.lessons) lines.push(`- ${l}`);
    lines.push('');
  }
  if (out.globalFacts.length) {
    lines.push('### 全局事实');
    for (const f of out.globalFacts) lines.push(`- ${f}`);
    lines.push('');
  }
  if (out.projectKnowledge.length) {
    lines.push(`### 项目知识（${projectName}）`);
    for (const k of out.projectKnowledge) lines.push(`- ${k}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function listExtractionFiles(projectId?: string): string[] {
  if (projectId)
    return Object.entries(readState().extractions || {})
      .filter(([, e]) => e.projectId === projectId)
      .map(([name]) => name)
      .sort();
  try {
    return fs
      .readdirSync(extractionsDir())
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface ConsolidationResult {
  ok: boolean;
  merged: number;
  candidateId?: string;
  error?: string;
}
export async function runConsolidation(
  projectId: string,
  completeFn: CompleteFn,
  options: PipelineOptions = {}
): Promise<ConsolidationResult> {
  try {
    options.signal?.throwIfAborted();
    const occupied = new Set(
      listCandidates(projectId)
        .filter((c) =>
          c.changes.every(
            (d) => revisionOf(readPersisted(d.file)) === (d.beforeRevision || revisionOf(d.before))
          )
        )
        .flatMap((c) => c.extractionIds)
    );
    const pending = pendingForProject(readState(), projectId).filter((id) => !occupied.has(id));
    const extractions: Array<{ file: string; content: string }> = [];
    let used = 0;
    for (const file of pending) {
      if (!/^[a-zA-Z0-9-]+\.md$/.test(file)) throw new Error('无效的提取记录');
      const content = readPersisted(`extractions/${file}`);
      if (!content) throw new Error(`提取文件缺失：${file}`);
      if (content.length > 40000) throw new Error(`提取文件过大：${file}`);
      if (used + content.length > 48000 || extractions.length >= 10) break;
      used += content.length;
      extractions.push({ file, content });
    }
    if (!extractions.length) return { ok: true, merged: 0 };
    const ids = ['USER.md', 'MEMORY.md', 'LESSONS.md', 'project'] as const;
    const before = ids.map((id) => readMemoryFile(id, projectId));
    if (before.join('').length > 80000)
      throw new Error('当前记忆超过合并输入预算，请先在设置中整理文件');
    const prompt = buildConsolidationUserPrompt({
      userMd: before[0],
      memoryMd: before[1],
      lessonsMd: before[2],
      projectMd: before[3],
      extractions,
      projectName: projectId
    });
    const tombstones = readTombstones();
    const excluded = ids
      .flatMap((id) =>
        Object.values(tombstones[memoryRelativePath(id, projectId)] || {}).map((t) => t.text)
      )
      .join('\n')
      .slice(0, 12000);
    const raw = await completeFn(
      CONSOLIDATION_SYSTEM_PROMPT,
      redactSecrets(prompt + `\n以下已删除条目禁止恢复或换句话重写：\n${excluded}`),
      options.signal
    );
    options.signal?.throwIfAborted();
    const out = parseConsolidationOutput(raw);
    if (!out) throw new Error('模型合并输出缺少四个文件或格式无效');
    const outputs = [out.userMd, out.memoryMd, out.lessonsMd, out.projectMd];
    if (outputs.some((o) => o.length > 100000)) throw new Error('模型合并输出超过大小限制');
    const candidate = createCandidate(
      projectId,
      ids.map((id, index) => {
        const file = memoryRelativePath(id, projectId);
        return {
          file,
          before: before[index],
          after: prepareDocument(
            outputs[index],
            before[index],
            file,
            extractions.map((e) => e.file.replace(/\.md$/, ''))
          )
        };
      }),
      extractions.map((e) => e.file)
    );
    return { ok: true, merged: extractions.length, candidateId: candidate.id };
  } catch (error) {
    return {
      ok: false,
      merged: 0,
      error: redactSecrets(String(error instanceof Error ? error.message : error))
    };
  }
}
