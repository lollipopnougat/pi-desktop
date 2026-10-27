import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { MemoryFileId, MemoryFileStat } from '../../types/pi';

/**
 * 记忆文件卡片 + 编辑弹窗（设置页「记忆系统」与项目属性弹窗的「记忆」页共用）。
 * - `MemoryFileRow`：文件名 + 条数/体积 + 打开/编辑按钮
 * - `MemoryEditModal`：整文件 textarea 编辑，保存走乐观版本校验
 */
export function MemoryFileRow({
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
export function MemoryEditModal({
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
        className="mx-auto my-6 flex min-h-0 w-[min(640px,90vw)] flex-1 flex-col rounded-lg border border-od-border bg-od-bg-alt shadow-2xl"
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
