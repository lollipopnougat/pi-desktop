import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { MemoryEditModal, MemoryFileRow } from '../memory/MemoryFileCard';
import { usePiStore } from '../../store/pi-store';
import type { MemoryConfig, MemoryFileStat, MemoryFileId, MemoryIndexStats } from '../../types/pi';

/**
 * 设置页 - 记忆系统 tab：
 * - 总开关 + 写入策略 + 提取/合并模型选择 + 合并阈值
 * - 全局记忆文件（USER.md / MEMORY.md / LESSONS.md / STANDING.md）查看与编辑
 * - 记忆目录展示与打开
 *
 * 项目记忆（含候选审核、检索来源、变更历史）不在设置页展示——它是项目属性，
 * 入口在侧栏项目的「项目属性」弹窗 → 记忆页（`src/components/session/ProjectMemoryTab.tsx`）。
 */
const FILE_IDS = ['USER.md', 'MEMORY.md', 'LESSONS.md', 'STANDING.md'] as const;
type FixedFileId = (typeof FILE_IDS)[number];

const FILE_LABELS: Record<FixedFileId, string> = {
  'USER.md': t.memory.fileUser,
  'MEMORY.md': t.memory.fileGlobal,
  'LESSONS.md': t.memory.fileLessons,
  'STANDING.md': t.memory.fileStanding
};

export default function MemoryTab() {
  const showToast = usePiStore((state) => state.showToast);
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [stats, setStats] = useState<MemoryFileStat[]>([]);
  const [index, setIndex] = useState<MemoryIndexStats | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  /** 弹窗编辑中：{ fileId, label } */
  const [editing, setEditing] = useState<{ fileId: MemoryFileId; label: string } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const cfg = await window.pi.memory.getConfig();
      setConfig(cfg);
    } catch {}
    await refreshStats();
    try {
      const ms = await window.pi.getAvailableModels();
      setModels(Array.isArray(ms) ? ms : []);
    } catch {}
  };

  const toggleEnabled = async (v: boolean) => {
    try {
      const next = await window.pi.memory.setConfig({ enabled: v });
      setConfig(next);
    } catch {}
  };

  const pickModel = async (value: string) => {
    try {
      const next =
        value === ''
          ? await window.pi.memory.setConfig({ extractModel: null })
          : await window.pi.memory.setConfig({ extractModel: JSON.parse(value) });
      setConfig(next);
    } catch {}
  };

  const changeThreshold = async (raw: string) => {
    const n = raw === '' ? 5 : Number(raw);
    if (!Number.isFinite(n) || n < 1) return;
    try {
      const next = await window.pi.memory.setConfig({ consolidateThreshold: Math.floor(n) });
      setConfig(next);
    } catch {}
  };

  const patchConfig = async (patch: Partial<MemoryConfig>) => {
    try {
      setConfig(await window.pi.memory.setConfig(patch));
    } catch (e) {
      showToast(t.memory.autoSaveFailed((e as Error)?.message || ''), { variant: 'error' });
    }
  };

  /** 数值阈值：夹到 1..200 再落盘（空串回退默认） */
  const changeNudge = async (
    field: 'nudgeTurns' | 'nudgeToolCalls',
    raw: string,
    fallback: number
  ) => {
    const n = raw === '' ? fallback : Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return;
    await patchConfig({ [field]: Math.min(200, n) } as Partial<MemoryConfig>);
  };

  const refreshStats = async () => {
    try {
      const status = await window.pi.memory.getStatus();
      setStats(status.files || []);
      setIndex(status.index || null);
    } catch {}
  };

  const rebuildIndex = async () => {
    setRebuilding(true);
    try {
      setIndex(await window.pi.memory.reindex());
      showToast(t.memory.indexRebuilt, { variant: 'success' });
    } catch (e) {
      showToast(t.memory.indexRebuildFailed((e as Error)?.message || ''), { variant: 'error' });
    } finally {
      setRebuilding(false);
    }
  };

  const openDir = async () => {
    try {
      const dir = await window.pi.memory.getDir();
      await window.pi.showInFolder(dir);
    } catch {}
  };

  const enabled = config?.enabled ?? true;
  const modelValue = config?.extractModel ? JSON.stringify(config.extractModel) : '';

  return (
    <div>
      {/* 总开关 */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.memory.title}</h3>
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.memory.enabledLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.desc}</div>
            </div>
            <Switch checked={enabled} onChange={toggleEnabled} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.writePolicyLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.writePolicyHint}</div>
            </div>
            <Dropdown
              className="w-52 shrink-0"
              value={config?.writePolicy || 'automatic'}
              ariaLabel={t.memory.writePolicyLabel}
              options={[
                { value: 'automatic', label: t.memory.policyAutomatic },
                { value: 'review', label: t.memory.policyReview },
                { value: 'explicit', label: t.memory.policyExplicit }
              ]}
              onChange={async (value) =>
                setConfig(
                  await window.pi.memory.setConfig({
                    writePolicy: value as MemoryConfig['writePolicy']
                  })
                )
              }
            />
          </div>
          {/* 提取模型 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.extractModelLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.extractModelDesc}</div>
            </div>
            <Dropdown
              className="w-52 shrink-0"
              fullWidth
              value={modelValue}
              onChange={pickModel}
              searchable
              searchPlaceholder={t.searchModels}
              panelWidth="w-72"
              ariaLabel={t.memory.extractModelLabel}
              options={[
                { value: '', label: t.memory.extractModelFollow },
                ...models.map((m: any) => ({
                  value: JSON.stringify({ provider: m.provider, modelId: m.id }),
                  label: m.name || m.id,
                  hint: `${m.provider} / ${m.id}`
                }))
              ]}
            />
          </div>
          {/* 合并阈值 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">
                {t.memory.consolidateThresholdLabel}
              </div>
              <div className="text-xs text-od-text-dim">{t.memory.consolidateThresholdDesc}</div>
            </div>
            <input
              type="number"
              min={1}
              value={config?.consolidateThreshold ?? 5}
              onChange={(e) => changeThreshold(e.target.value)}
              className="w-32 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          {/* 记忆目录 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-od-text-dim">~/.pi-desktop/memory/</div>
            <button
              onClick={openDir}
              className="shrink-0 rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
            >
              <Icon name="memory" className="mr-1 inline w-3" />
              {t.memory.openDir}
            </button>
          </div>
        </div>
      </div>

      {/* 自动沉淀 */}
      <div className="mb-4">
        <div className="mb-2">
          <h3 className="text-xs font-semibold text-od-text">{t.memory.autoSection}</h3>
          <div className="text-xs text-od-text-dim">{t.memory.autoSectionDesc}</div>
        </div>
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.autoExtractLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.autoExtractDesc}</div>
            </div>
            <Switch
              checked={config?.autoExtract ?? true}
              onChange={(v) => patchConfig({ autoExtract: v })}
              ariaLabel={t.memory.autoExtractLabel}
              disabled={!enabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.nudgeTurnsLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.nudgeTurnsDesc}</div>
            </div>
            <input
              type="number"
              min={1}
              max={200}
              value={config?.nudgeTurns ?? 12}
              onChange={(e) => changeNudge('nudgeTurns', e.target.value, 12)}
              disabled={!enabled || !(config?.autoExtract ?? true)}
              aria-label={t.memory.nudgeTurnsLabel}
              className="w-24 shrink-0 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.nudgeToolCallsLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.nudgeToolCallsDesc}</div>
            </div>
            <input
              type="number"
              min={1}
              max={200}
              value={config?.nudgeToolCalls ?? 20}
              onChange={(e) => changeNudge('nudgeToolCalls', e.target.value, 20)}
              disabled={!enabled || !(config?.autoExtract ?? true)}
              aria-label={t.memory.nudgeToolCallsLabel}
              className="w-24 shrink-0 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.correctionLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.correctionDesc}</div>
            </div>
            <Switch
              checked={config?.correctionDetect ?? true}
              onChange={(v) => patchConfig({ correctionDetect: v })}
              ariaLabel={t.memory.correctionLabel}
              disabled={!enabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.memory.preCompactLabel}</div>
              <div className="text-xs text-od-text-dim">{t.memory.preCompactDesc}</div>
            </div>
            <Switch
              checked={config?.preCompactFlush ?? true}
              onChange={(v) => patchConfig({ preCompactFlush: v })}
              ariaLabel={t.memory.preCompactLabel}
              disabled={!enabled}
            />
          </div>
        </div>
      </div>

      {/* 检索索引（FTS5） */}
      <div className="mb-4">
        <div className="mb-2">
          <h3 className="text-xs font-semibold text-od-text">{t.memory.indexSection}</h3>
          <div className="text-xs text-od-text-dim">{t.memory.indexDesc}</div>
        </div>
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {index?.available ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-od-text">{t.memory.indexEntries}</span>
                <span className="shrink-0 text-xs text-od-text-dim">
                  {index.entries} · {t.memory.indexFiles(index.files)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-od-text">{t.memory.indexSessions}</span>
                <span className="shrink-0 text-xs text-od-text-dim">
                  {index.sessions?.available
                    ? t.memory.indexSessionsValue(index.sessions.entries, index.sessions.files)
                    : t.memory.indexNever}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-od-text">{t.memory.indexSize}</span>
                <span className="shrink-0 text-xs text-od-text-dim">
                  {(index.bytes / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-od-text">
                  {t.memory.indexUsage(index.usageEntries)}
                </span>
                <span className="shrink-0 text-xs text-od-text-dim">
                  {index.indexedAt
                    ? t.memory.indexUpdated(new Date(index.indexedAt).toLocaleString())
                    : t.memory.indexNever}
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-start gap-1.5 text-xs text-od-text-dim">
              <Icon name="info" className="mt-0.5 w-3 shrink-0" />
              <span>
                {index?.error ? t.memory.indexUnavailable(index.error) : t.memory.indexNever}
              </span>
            </div>
          )}
          <div className="flex items-center justify-end">
            <button
              onClick={rebuildIndex}
              disabled={rebuilding || !enabled}
              className="shrink-0 rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover disabled:opacity-50"
            >
              <Icon name="spinner" spin={rebuilding} className="mr-1 inline w-3" />
              {rebuilding ? t.memory.indexRebuilding : t.memory.indexRebuild}
            </button>
          </div>
        </div>
      </div>

      {/* 记忆文件（仅全局） */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.memory.filesSection}</h3>
        <div className="space-y-1.5">
          {FILE_IDS.map((id) => (
            <MemoryFileRow
              key={id}
              fileId={id}
              label={FILE_LABELS[id]}
              stat={stats.find((s) => s.id === id)}
              onEdit={() => setEditing({ fileId: id, label: FILE_LABELS[id] })}
            />
          ))}
        </div>
        <div className="mt-2 flex items-start gap-1.5 rounded border border-od-border-light px-3 py-2 text-xs text-od-text-dim">
          <Icon name="info" className="mt-0.5 w-3 shrink-0" />
          <span>{t.memory.projectMemoryMovedHint}</span>
        </div>
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <MemoryEditModal
          fileId={editing.fileId}
          title={editing.label}
          onClose={() => setEditing(null)}
          onSaved={refreshStats}
        />
      )}
    </div>
  );
}
