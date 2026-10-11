import { useState, useEffect } from 'react';
import Icon from '../common/Icon';
import SkillsTab from '../settings/SkillsTab';
import McpTab from '../settings/McpTab';
import { t } from '../../i18n/zh';

interface ProjectInfoModalProps {
  /** 项目目录 */
  cwd: string;
  onClose: () => void;
}

type TabKey = 'skills' | 'mcp';

/**
 * 项目属性弹窗：展示项目真实路径，管理项目级 Skill、MCP 服务器。
 * - Skill tab：项目级技能（<cwd>/.pi-desktop/skills、<cwd>/.agents/skills）
 * - MCP tab：项目级 MCP 配置（<cwd>/.mcp.json）
 */
export default function ProjectInfoModal({ cwd, onClose }: ProjectInfoModalProps) {
  const isMac = window.pi?.platform === 'darwin';
  const [activeTab, setActiveTab] = useState<TabKey>('skills');
  const [projectName, setProjectName] = useState(cwd);

  // 跨平台取项目名（renderer 无法直接用 node path.basename）
  useEffect(() => {
    let alive = true;
    window.pi
      .baseName(cwd)
      .then((n) => {
        if (alive && n) setProjectName(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cwd]);

  const tabs: { key: TabKey; label: string; icon: 'cube' | 'settings' }[] = [
    { key: 'skills', label: t.tabSkills, icon: 'cube' },
    { key: 'mcp', label: t.tabMcp, icon: 'settings' }
  ];

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center bg-black/60"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 w-full max-w-3xl flex-1 flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="folder" className="w-3.5 shrink-0 text-od-yellow" />
            <span className="truncate">{projectName}</span>
            <span className="shrink-0 text-xs font-normal text-od-text-dim">
              — {t.projectInfoTitle}
            </span>
          </h2>
          <button onClick={onClose} className="shrink-0 text-od-text-dim hover:text-od-text-bright">
            <Icon name="close" size="sm" />
          </button>
        </div>

        {/* 项目真实路径 */}
        <div className="flex items-center gap-1.5 border-b border-od-border px-4 py-1.5">
          <Icon name="folder" className="w-3 shrink-0 text-od-text-dim" />
          <span className="truncate font-mono text-xs text-od-text-dim" title={cwd}>
            {cwd}
          </span>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-od-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs transition-colors ${
                activeTab === tab.key
                  ? 'border-b-2 border-od-accent text-od-accent'
                  : 'text-od-text-dim hover:text-od-text-bright'
              }`}
            >
              <Icon name={tab.icon} className="w-3" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {activeTab === 'skills' && (
            <SkillsTab projectMode projectCwd={cwd} onCloseModal={onClose} />
          )}
          {activeTab === 'mcp' && <McpTab projectMode projectCwd={cwd} />}
        </div>
      </div>
    </div>
  );
}
