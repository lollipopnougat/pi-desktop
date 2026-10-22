import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import MemoryReviewSection from '../chat/MemoryReviewSection';
import type { MemoryConfig, MemoryFileStat, MemoryFileId, MemoryStatus } from '../../types/pi';

/**
 * 设置页 - 记忆系统 tab：
 * - 总开关 + 提取/合并模型选择 + 合并阈值
 * - 四个记忆文件 + 当前项目记忆的查看/编辑（点击「编辑」打开弹窗）
 * - 记忆目录展示与打开
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
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [stats, setStats] = useState<MemoryFileStat[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [projectName, setProjectName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  /** 弹窗编辑中：{ fileId, projName?, label } */
  const [editing, setEditing] = useState<{
    fileId: MemoryFileId;
    projName?: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const [cfg, status] = await Promise.all([
        window.pi.memory.getConfig(),
        window.pi.memory.getStatus()
      ]);
      setConfig(cfg);
      setStats(status.files || []);
      setProjectName(status.projectName || '');
      setProjectId(status.projectId);
      setMemoryStatus(status);
    } catch {}
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

  const refreshStats = async () => {
    try {
      const status = await window.pi.memory.getStatus();
      setStats(status.files || []);
      setMemoryStatus(status);
    } catch {}
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

      {memoryStatus && (
        <MemoryReviewSection
          key={memoryStatus.projectId}
          status={memoryStatus}
          onChanged={refreshStats}
        />
      )}

      {/* 记忆文件 */}
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
          {projectName && (
            <MemoryFileRow
              fileId="project"
              projectName={projectId}
              label={t.memory.fileProject(projectName)}
              stat={stats.find((s) => s.id === `project:${projectId}/MEMORY.md`)}
              onEdit={() =>
                setEditing({
                  fileId: 'project',
                  projName: projectId,
                  label: t.memory.fileProject(projectName)
                })
              }
            />
          )}
        </div>
      </div>

      {/* 编辑弹窗 */}
      {editing && (
        <MemoryEditModal
          fileId={editing.fileId}
          projectName={editing.projName}
          title={editing.label}
          onClose={() => setEditing(null)}
          onSaved={refreshStats}
        />
      )}
    </div>
  );
}

function MemoryFileRow({
  fileId,
  projectName,
  label,
  stat,
  onEdit
}: {
  fileId: MemoryFileId;
  projectName?: string;
  label: string;
  stat?: MemoryFileStat;
  onEdit: () => void;
}) {
  const handleOpen = async () => {
    try {
      const p = await window.pi.memory.getFilePath(fileId, projectName);
      await window.pi.openWith(p, 'default');
    } catch {}
  };
  return (
    <div className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm text-od-text-bright">{label}</div>
        <div className="text-xs text-od-text-dim">
          {stat?.exists ? t.memory.entriesCount(stat.entries) : '—'} ·{' '}
          {stat ? `${Math.ceil(stat.size / 1024)}KB` : '0KB'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={handleOpen}
          disabled={!stat?.exists}
          className="flex items-center gap-1 rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover disabled:opacity-40"
          title={t.memory.openFileDesc}
        >
          <Icon name="file" className="w-3" />
          {t.memory.openFile}
        </button>
        <button
          onClick={onEdit}
          className="shrink-0 rounded border border-od-border-light px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
        >
          {t.edit}
        </button>
      </div>
    </div>
  );
}

/** 记忆文件编辑弹窗：textarea + 保存/取消，Esc 关闭 */
function MemoryEditModal({
  fileId,
  projectName,
  title,
  onClose,
  onSaved
}: {
  fileId: MemoryFileId;
  projectName?: string;
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const showToast = usePiStore((state) => state.showToast);
  const isMac = window.pi?.platform === 'darwin';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await window.pi.memory.readFile(fileId, projectName);
        if (alive) {
          setContent(c.content);
          setRevision(c.revision);
          setLoaded(true);
        }
      } catch {
        if (alive) {
          showToast(t.memory.readFileFailed, { variant: 'error' });
        }
      }
    })();
    return () => {
      alive = false;
    };
    // showToast 是 store 上的稳定 action，加入依赖不会引起重跑
  }, [fileId, projectName, showToast]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await window.pi.memory.writeFile(fileId, content, projectName, revision);
      setContent(saved.content);
      setRevision(saved.revision);
      showToast(t.memory.savedFile, { variant: 'success' });
      onSaved();
    } catch (e: any) {
      showToast(t.memory.saveFileFailed(String(e?.message || e)), { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/50"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 flex-1 flex-col mx-auto my-6 w-[min(640px,90vw)] rounded-lg border border-od-border bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-od-border px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="memory" className="w-3.5 text-od-accent" />
            {title}
          </div>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="close" size="xs" />
          </button>
        </div>
        {/* 编辑区 */}
        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
          {!loaded ? (
            <div className="flex flex-1 items-center justify-center text-xs text-od-text-dim">
              <Icon name="spinner" spin className="mr-1.5 w-3" />
              {t.loading}
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded border border-od-border-light bg-od-bg px-2.5 py-2 font-mono text-xs leading-relaxed text-od-text-bright outline-none focus:border-od-accent"
            />
          )}
        </div>
        {/* 底栏 */}
        <div className="flex shrink-0 items-center justify-between border-t border-od-border px-4 py-2.5">
          <div className="min-w-0 truncate text-xs text-od-text-dim">{t.memory.editorHint}</div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClose}
              className="rounded border border-od-border-light px-3 py-1.5 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
            >
              {t.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={!loaded || saving}
              className="rounded bg-od-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-od-accent/80 active:bg-od-accent/65 disabled:opacity-50"
            >
              {saving ? t.memory.savingFile : t.memory.saveFile}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
