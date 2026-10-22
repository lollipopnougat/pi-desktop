import { useEffect, useState, useRef } from 'react';
import Icon from '../common/Icon';
import ConfirmDialog from '../common/ConfirmDialog';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import { useShallow } from 'zustand/react/shallow';

/**
 * 设置页 - Skill 管理 tab：查看/编辑/删除/启用禁用/导入/创建
 * projectMode=true 时只管理项目级技能（项目属性弹窗使用）。
 */
export default function SkillsTab({
  projectMode = false,
  projectCwd,
  onCloseModal
}: {
  projectMode?: boolean;
  projectCwd?: string;
  /** 创建技能时关闭包裹弹窗（项目属性弹窗用） */
  onCloseModal?: () => void;
} = {}) {
  const [skills, setSkills] = useState<any[]>([]);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState('');
  const [skillPath, setSkillPath] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const { setSettingsOpen, setPendingChatInput, showToast } = usePiStore(
    useShallow((s) => ({
      setSettingsOpen: s.setSettingsOpen,
      setPendingChatInput: s.setPendingChatInput,
      showToast: s.showToast
    }))
  );

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    try {
      const res = projectMode
        ? await window.pi.getProjectSkills(projectCwd)
        : await window.pi.getSkills();
      setSkills(res.skills || []);
    } catch {}
  };

  /** 强制重新扫描技能目录并刷新列表（导入/刷新按钮使用） */
  const reloadSkillsList = async () => {
    try {
      if (projectMode) {
        const res = await window.pi.getProjectSkills(projectCwd);
        setSkills(res.skills || []);
      } else {
        const res = await window.pi.reloadSkills();
        setSkills(res.skills || []);
      }
    } catch {}
  };

  const handleEditSkill = async (name: string) => {
    try {
      const res = await window.pi.readSkillFile(name);
      setEditingSkill(name);
      setSkillContent(res.content);
      setSkillPath(res.path);
    } catch (e: any) {
      console.error('Failed to load skill file:', e);
    }
  };

  const handleSaveSkill = async () => {
    if (!editingSkill) return;
    try {
      await window.pi.writeSkillFile(editingSkill, skillContent);
      setEditingSkill(null);
      setSkillContent('');
      setSkillPath('');
      await loadSkills();
    } catch (e: any) {
      console.error('Failed to save skill:', e);
    }
  };

  const handleDeleteSkill = async (name: string) => {
    setConfirmDelete(name);
  };

  const performDeleteSkill = async () => {
    const name = confirmDelete;
    if (!name) return;
    try {
      await window.pi.deleteSkill(name);
      if (editingSkill === name) {
        setEditingSkill(null);
        setSkillContent('');
        setSkillPath('');
      }
      await loadSkills();
    } catch (e: any) {
      console.error('Failed to delete skill:', e);
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleToggleSkill = async (name: string, currentDisabled: boolean) => {
    try {
      await window.pi.toggleSkill(name, !currentDisabled);
      await loadSkills();
    } catch (e: any) {
      console.error('Failed to toggle skill:', e);
    }
  };

  // 点击外部关闭添加菜单
  useEffect(() => {
    if (!addMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addMenuOpen]);

  /** 创建技能：关闭设置页/项目弹窗，跳转聊天框并注入 $skill:skill-creator */
  const handleCreateSkill = () => {
    setAddMenuOpen(false);
    if (projectMode) {
      onCloseModal?.();
    } else {
      setSettingsOpen(false);
    }
    setPendingChatInput('$skill:skill-creator ');
  };

  /** 从技能目录导入（项目级时走项目级 IPC） */
  const handleImportFromDir = async () => {
    setAddMenuOpen(false);
    try {
      const dir = await window.pi.selectDirectory();
      if (!dir) return; // 用户取消
      const result =
        projectMode && projectCwd
          ? await window.pi.importProjectSkillFromDir(dir, projectCwd)
          : await window.pi.importSkillFromDir(dir);
      if (result.ok) {
        showToast(t.skillImported(result.name), { variant: 'success' });
        await reloadSkillsList();
      }
    } catch (e: any) {
      showToast(`${t.skillImportFail}: ${e?.message ?? e}`, { variant: 'error' });
    }
  };

  /** 从技能 zip 导入（项目级时走项目级 IPC） */
  const handleImportFromZip = async () => {
    setAddMenuOpen(false);
    try {
      const zipPath = await window.pi.selectFile({
        title: '选择技能 zip 文件',
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
      });
      if (!zipPath) return;
      const result =
        projectMode && projectCwd
          ? await window.pi.importProjectSkillFromZip(zipPath, projectCwd)
          : await window.pi.importSkillFromZip(zipPath);
      if (result.ok) {
        showToast(t.skillImported(result.name), { variant: 'success' });
        await reloadSkillsList();
      }
    } catch (e: any) {
      showToast(`${t.skillImportFail}: ${e?.message ?? e}`, { variant: 'error' });
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-od-text">{t.skills}</h3>
          <div className="text-xs text-od-text-dim">{t.skillsDesc}</div>
        </div>
        {/* 右侧操作按钮组 */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={reloadSkillsList}
            className="flex items-center justify-center rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.skillRefresh}
          >
            <Icon name="rotate" className="w-3" />
          </button>
          {/* 添加技能下拉按钮 */}
          <div ref={addMenuRef} className="relative">
            <button
              onClick={() => setAddMenuOpen(!addMenuOpen)}
              className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
              title={t.skillAdd}
            >
              <Icon name="plus" className="w-3" />
              <span>{t.skillAdd}</span>
              <Icon name="chevronDown" size="xs" />
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-od-border-light bg-od-bg-alt py-1 shadow-xl">
                <button
                  onClick={handleCreateSkill}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
                >
                  <Icon name="plus" className="w-3 text-od-accent" />
                  {t.skillCreate}
                </button>
                <button
                  onClick={handleImportFromDir}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
                >
                  <Icon name="folder" className="w-3 text-od-yellow" />
                  {t.skillImportDir}
                </button>
                <button
                  onClick={handleImportFromZip}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
                >
                  <Icon name="file" className="w-3 text-od-green" />
                  {t.skillImportZip}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1">
        {skills.length === 0 && (
          <div className="py-2 text-xs text-od-text-dim">{t.skillNoSkills}</div>
        )}
        {skills.map((s) => {
          const isPlugin = s.origin === 'package';
          const isBuiltin = !!s.builtin;
          const scopeLabel = isBuiltin
            ? t.skillScopeBuiltin
            : isPlugin
              ? t.skillScopePlugin
              : s.scope === 'project'
                ? t.skillScopeProject
                : s.scope === 'temporary'
                  ? t.skillScopeTemporary
                  : t.skillScopeUser;
          const scopeColor = isBuiltin
            ? 'bg-od-accent/20 text-od-accent'
            : isPlugin
              ? 'bg-od-orange/20 text-od-orange'
              : s.scope === 'project'
                ? 'bg-od-purple/20 text-od-purple'
                : s.scope === 'temporary'
                  ? 'bg-od-orange/20 text-od-orange'
                  : 'bg-od-accent/20 text-od-accent';
          const isEditing = editingSkill === s.name;
          return (
            <div key={s.name} className="rounded border border-od-border bg-od-bg-alt px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Icon name="cube" className="w-3 shrink-0 text-od-yellow" />
                    <span className="text-sm text-od-text-bright">{s.name}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${scopeColor}`}>
                      {scopeLabel}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                        s.disableModelInvocation
                          ? 'bg-od-bg-hover text-od-text-dim'
                          : 'bg-od-green/20 text-od-green'
                      }`}
                      title={s.disableModelInvocation ? t.skillDisabledHint : ''}
                    >
                      {s.disableModelInvocation ? t.skillDisabled : t.skillEnabled}
                    </span>
                  </div>
                  <div className="truncate text-xs text-od-text-dim">
                    {s.description || t.skillNoDesc}
                  </div>
                  <div className="truncate font-mono text-xs text-od-text-dim" title={s.filePath}>
                    {s.filePath}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {!isBuiltin && (
                    <>
                      <button
                        onClick={() => handleToggleSkill(s.name, s.disableModelInvocation)}
                        className={`flex items-center justify-center rounded px-2 py-0.5 text-xs ${
                          s.disableModelInvocation
                            ? 'text-od-green hover:bg-od-green/20'
                            : 'text-od-text-dim hover:bg-od-bg-hover'
                        }`}
                        title={s.disableModelInvocation ? t.skillEnable : t.skillDisable}
                      >
                        <Icon
                          name={s.disableModelInvocation ? 'eyeSlash' : 'eye'}
                          className="w-3"
                        />
                      </button>
                      <button
                        onClick={() =>
                          isEditing
                            ? (setEditingSkill(null), setSkillContent(''), setSkillPath(''))
                            : handleEditSkill(s.name)
                        }
                        className={`flex items-center justify-center rounded px-2 py-0.5 text-xs ${
                          isEditing
                            ? 'bg-od-bg-hover text-od-text'
                            : 'text-od-text hover:bg-od-bg-hover'
                        }`}
                        title={isEditing ? t.cancel : t.skillEdit}
                      >
                        <Icon name="edit2" className="w-3" />
                      </button>
                      <button
                        onClick={() => handleDeleteSkill(s.name)}
                        className="flex items-center justify-center rounded px-2 py-0.5 text-xs text-od-red hover:bg-od-red/20"
                        title={t.skillDelete}
                      >
                        <Icon name="delete" className="w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {isEditing && (
                <div className="mt-2">
                  <div className="mb-1 truncate font-mono text-xs text-od-text-dim">
                    {t.skillFilePath}: {skillPath}
                  </div>
                  <textarea
                    value={skillContent}
                    onChange={(e) => setSkillContent(e.target.value)}
                    rows={16}
                    className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1.5 font-mono text-xs text-od-text-bright"
                    spellCheck={false}
                  />
                  <div className="mt-1 flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setEditingSkill(null);
                        setSkillContent('');
                        setSkillPath('');
                      }}
                      className="rounded px-3 py-1 text-xs text-od-text hover:bg-od-bg-hover"
                    >
                      {t.cancel}
                    </button>
                    <button
                      onClick={handleSaveSkill}
                      className="rounded bg-od-accent px-3 py-1 text-xs text-white hover:bg-od-accent/80 active:bg-od-accent/65"
                    >
                      {t.saveProvider}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 删除技能二次确认 */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t.skillDeleteTitle}
        message={confirmDelete ? t.skillDeleteConfirm(confirmDelete) : ''}
        confirmText={t.delete}
        danger
        onConfirm={performDeleteSkill}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
