import { atomicWrite, readPersisted } from './persistence';

export interface ExtractionRecord {
  projectId: string;
  sourceKey: string;
  at: string;
  status: 'pending' | 'merged' | 'rejected';
}
export interface MemoryPipelineState {
  processed: Record<
    string,
    {
      mtimeMs: number;
      size: number;
      at: string;
      noop?: boolean;
      error?: string;
      projectId?: string;
      name?: string;
      seen?: string[];
    }
  >;
  pendingExtractions: string[];
  extractions?: Record<string, ExtractionRecord>;
  lastConsolidation?: string;
  stats?: { extractions: number; consolidations: number };
}
export function readState(): MemoryPipelineState {
  const raw = readPersisted('state.json');
  if (!raw)
    return {
      processed: {},
      pendingExtractions: [],
      extractions: {},
      stats: { extractions: 0, consolidations: 0 }
    };
  const parsed = JSON.parse(raw) as MemoryPipelineState;
  if (!parsed.processed || !Array.isArray(parsed.pendingExtractions))
    throw new Error('记忆水位文件损坏，请检查 state.json');
  return { ...parsed, extractions: parsed.extractions || {} };
}
export function writeState(state: MemoryPipelineState): void {
  readPersisted('state.json');
  atomicWrite('state.json', JSON.stringify(state));
}
export function pendingForProject(state: MemoryPipelineState, projectId: string): string[] {
  // 没有可靠 projectId 的旧提取不自动认领，保留原文件供人工查看迁移。
  return state.pendingExtractions.filter(
    (id) =>
      state.extractions?.[id]?.projectId === projectId && state.extractions[id].status === 'pending'
  );
}
