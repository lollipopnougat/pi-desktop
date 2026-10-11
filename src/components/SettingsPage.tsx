import { useState } from 'react';
import { usePiStore } from '../store/pi-store';
import Icon from './common/Icon';
import type { IconName } from './common/icons';
import McpIcon from './common/McpIcon';
import { t } from '../i18n/zh';
import AppearanceTab from './settings/AppearanceTab';
import ModelsTab from './settings/ModelsTab';
import SkillsTab from './settings/SkillsTab';
import McpTab from './settings/McpTab';
import AgentTab from './settings/AgentTab';
import MemoryTab from './settings/MemoryTab';
import HooksTab from './settings/HooksTab';
import BrowserTab from './settings/BrowserTab';
import StatisticsTab from './settings/StatisticsTab';
import ClassifierTab from './settings/ClassifierTab';
import LogsTab from './settings/LogsTab';

type TabKey =
  | 'appearance'
  | 'statistics'
  | 'models'
  | 'classifier'
  | 'agent'
  | 'browser'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'hooks'
  | 'logs';

/**
 * 设置页：全屏页面，左侧 tab 导航 + 右侧内容区。
 * 各 tab 内容拆分到 ./settings/ 子目录。
 */
export default function SettingsPage() {
  const setSettingsOpen = usePiStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState<TabKey>('appearance');
  const isMac = window.pi?.platform === 'darwin';

  const tabs: {
    key: TabKey;
    label: string;
    icon: IconName;
    isMcp?: boolean;
  }[] = [
    { key: 'appearance', label: t.tabAppearance, icon: 'sun' },
    { key: 'models', label: t.tabModels, icon: 'brain' },
    { key: 'classifier', label: t.tabClassifier, icon: 'classifier' },
    { key: 'agent', label: t.tabAgent, icon: 'robot' },
    { key: 'browser', label: t.tabBrowser, icon: 'browser' },
    { key: 'memory', label: t.tabMemory, icon: 'memory' },
    { key: 'hooks', label: t.tabHooks, icon: 'hook' },
    { key: 'skills', label: t.tabSkills, icon: 'cube' },
    { key: 'mcp', label: t.tabMcp, icon: 'settings', isMcp: true },
    { key: 'statistics', label: t.tabStatistics, icon: 'statistics' },
    { key: 'logs', label: t.tabLogs, icon: 'logs' }
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ paddingTop: isMac ? 38 : 32 }}>
      {/* 顶部 paddingTop 区域保持透明：露出原生标题栏毛玻璃（不铺 bg-od-bg，
          背景只从 Header 行开始铺） */}
      <div className="flex min-h-0 flex-1 flex-col bg-od-bg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-od-border bg-od-bg-alt px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(false)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            >
              <Icon name="back" className="w-3" />
              {t.back}
            </button>
            <h2 className="text-sm font-semibold text-od-text-bright">{t.settingsTitle}</h2>
          </div>
          {/* <button
          onClick={() => setSettingsOpen(false)}
          className="text-od-text-dim hover:text-od-text-bright"
          title={t.cancel}
        >
          <Icon name="close" size="sm" />
        </button> */}
        </div>

        {/* 主体：左侧 tab 导航 + 右侧内容 */}
        <div className="flex flex-1 min-h-0">
          {/* 选中样式对齐会话列表（SessionSidebar.tsx）：圆角块 bg-od-accent/15 + 文字 text-od-accent */}
          <div className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-od-border bg-od-bg-alt p-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  activeTab === tab.key
                    ? 'bg-od-accent/15 text-od-accent'
                    : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text'
                }`}
              >
                {tab.isMcp ? (
                  <McpIcon className="w-3 h-3" />
                ) : (
                  <Icon name={tab.icon} className="w-3" />
                )}
                <span className="truncate" title={tab.label}>
                  {tab.label}
                </span>
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto">
            <div
              className={`mx-auto w-full px-6 py-6 ${activeTab === 'statistics' ? 'max-w-6xl' : 'max-w-5xl'}`}
            >
              {activeTab === 'appearance' && <AppearanceTab />}
              {activeTab === 'statistics' && <StatisticsTab />}
              {activeTab === 'logs' && <LogsTab />}
              {activeTab === 'models' && <ModelsTab />}
              {activeTab === 'classifier' && <ClassifierTab />}
              {activeTab === 'agent' && <AgentTab />}
              {activeTab === 'browser' && <BrowserTab />}
              {activeTab === 'memory' && <MemoryTab />}
              {activeTab === 'hooks' && <HooksTab />}
              {activeTab === 'skills' && <SkillsTab />}
              {activeTab === 'mcp' && <McpTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
