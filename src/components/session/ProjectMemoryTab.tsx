import { useCallback, useEffect, useState } from 'react';
import Icon from '../common/Icon';
import MemoryReviewSection from '../chat/MemoryReviewSection';
import { MemoryEditModal, MemoryFileRow } from '../memory/MemoryFileCard';
import { t } from '../../i18n/zh';
import type { MemoryStatus } from '../../types/pi';

/**
 * 项目属性弹窗 - 记忆页：当前项目的记忆文件、待审核候选、检索来源与变更历史。
 * 记忆控制器按「当前会话所在项目」工作，因此只能展示焦点项目的记忆；
 * 其他项目的记忆请切换到该项目的会话后再查看。
 */
export default function ProjectMemoryTab({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [baseName, setBaseName] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.pi.memory.getStatus();
      setStatus(next);
      setError('');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await window.pi.memory.getStatus();
        if (alive) {
          setStatus(next);
          setError('');
        }
      } catch (e) {
        if (alive) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    window.pi
      .baseName(cwd)
      .then((n) => {
        if (alive && n) setBaseName(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cwd]);

  if (error) {
    return (
      <p role="alert" className="text-xs text-od-red">
        {error}
      </p>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center text-xs text-od-text-dim">
        <Icon name="spinner" spin className="mr-1.5 w-3" />
        {t.loading}
      </div>
    );
  }

  if (baseName && status.projectName !== baseName) {
    return (
      <div className="flex items-start gap-1.5 rounded border border-od-border-light px-3 py-2 text-xs text-od-text-dim">
        <Icon name="info" className="mt-0.5 w-3 shrink-0" />
        <span>{t.memory.projectOtherHint}</span>
      </div>
    );
  }

  const projectFile = status.files.find((f) => f.id === `project:${status.projectId}/MEMORY.md`);
  const label = t.memory.fileProject(status.projectName);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.memory.projectTabTitle}</h3>
        <div className="space-y-1.5">
          <MemoryFileRow
            fileId="project"
            projectName={status.projectId}
            label={label}
            stat={projectFile}
            onEdit={() => setEditing(true)}
          />
          <div className="text-xs text-od-text-dim">{t.memory.projectMemoryHint}</div>
        </div>
      </div>

      <MemoryReviewSection key={status.projectId} status={status} onChanged={refresh} />

      {editing && (
        <MemoryEditModal
          fileId="project"
          projectName={status.projectId}
          title={label}
          onClose={() => setEditing(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
