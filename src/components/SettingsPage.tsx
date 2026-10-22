import { useMemo, useRef, useState } from 'react';
import { usePiStore } from '../store/pi-store';
import Icon from './common/Icon';
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
import ShortcutsTab from './settings/ShortcutsTab';
import {
  SETTINGS_GROUPS,
  flattenSettingsResults,
  searchSettings,
  type SettingsSearchRow,
  type SettingsTabKey
} from './settings/settings-nav';

/**
 * tab → 内容组件。用 Record 而不是一长串 `&&`，漏挂 tab 会直接编译报错。
 */
const TAB_CONTENT: Record<SettingsTabKey, () => JSX.Element> = {
  appearance: AppearanceTab,
  shortcuts: ShortcutsTab,
  models: ModelsTab,
  classifier: ClassifierTab,
  agent: AgentTab,
  memory: MemoryTab,
  browser: BrowserTab,
  hooks: HooksTab,
  skills: SkillsTab,
  mcp: McpTab,
  statistics: StatisticsTab,
  logs: LogsTab
};

/** 搜索命中后在内容区按标题文案找分区（各 tab 的分区标题统一是 h2/h3） */
function findSectionHeading(root: HTMLElement, section: string): HTMLElement | null {
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4');
  for (const heading of headings) {
    if (heading.textContent?.trim() === section) return heading;
  }
  return null;
}

function flashSection(el: HTMLElement) {
  el.classList.remove('settings-section-flash');
  // 强制 reflow，保证同一元素连续命中时动画能重放
  void el.offsetWidth;
  el.classList.add('settings-section-flash');
  window.setTimeout(() => el.classList.remove('settings-section-flash'), 1200);
}

/**
 * 设置页：全屏页面，左侧分组 tab 导航（带设置搜索） + 右侧内容区。
 * 各 tab 内容拆分到 ./settings/ 子目录。
 */
export default function SettingsPage() {
  const setSettingsOpen = usePiStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('appearance');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isMac = window.pi?.platform === 'darwin';

  const rows = useMemo(() => flattenSettingsResults(searchSettings(query)), [query]);
  const searching = query.trim().length > 0;
  const activeRowIndex = rows.length > 0 ? Math.min(cursor, rows.length - 1) : -1;
  const ActiveTab = TAB_CONTENT[activeTab];

  /** 切 tab 并把内容区滚回顶部 */
  const selectTab = (key: SettingsTabKey) => {
    setActiveTab(key);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
  };

  /** 打开一条搜索结果：切 tab → 等渲染 → 滚到分区标题并短暂高亮 */
  const openRow = (row: SettingsSearchRow) => {
    setActiveTab(row.tab.key);
    const section = row.entry?.section;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = contentRef.current;
        if (!root) return;
        const heading = section ? findSectionHeading(root, section) : null;
        if (heading) {
          heading.scrollIntoView({ block: 'center', behavior: 'smooth' });
          flashSection(heading);
        } else {
          // 分区标题没匹配到（或 tab 级命中）时退化为回到顶部
          scrollRef.current?.scrollTo({ top: 0 });
        }
      });
    });
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (query) setQuery('');
      else event.currentTarget.blur();
      return;
    }
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => (current + 1) % rows.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => (current - 1 + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[activeRowIndex];
      if (row) openRow(row);
    }
  };

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
        </div>

        {/* 主体：左侧分组导航 + 右侧内容 */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-52 shrink-0 flex-col border-r border-od-border bg-od-bg-alt">
            {/* 设置搜索：参照 Codex 设置页，固定在导航顶部，结果就地替换分组列表 */}
            <div className="p-2 pb-1">
              <div className="flex items-center gap-2 rounded-md border border-od-border bg-od-bg px-2 py-1.5 focus-within:border-od-border-light">
                <Icon name="search" className="w-3 shrink-0 text-od-text-dim" />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setCursor(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t.settingsSearchPlaceholder}
                  aria-label={t.settingsSearchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-transparent focus:shadow-none focus:outline-none"
                />
                {query ? (
                  <button
                    onClick={() => setQuery('')}
                    title={t.cancel}
                    aria-label={t.settingsSearchClear}
                    className="shrink-0 rounded p-0.5 text-od-text-dim transition-colors hover:text-od-text-bright"
                  >
                    <Icon name="close" className="w-3" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-1">
              {searching ? (
                rows.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-od-text-dim">
                    {t.settingsSearchEmpty}
                  </div>
                ) : (
                  <>
                    {rows.map((row, index) =>
                      row.tabLevel ? (
                        // 分组头兼作「打开该页」入口（此时分组内可能没有命中的分区）
                        <button
                          key={`${row.tab.key}:@tab`}
                          onClick={() => openRow(row)}
                          onMouseEnter={() => setCursor(index)}
                          className={`flex w-full items-center rounded-md px-2.5 pb-1 pt-2 text-left text-[0.7rem] font-semibold uppercase tracking-wide transition-colors ${
                            index === activeRowIndex
                              ? 'text-od-accent'
                              : 'text-od-text-dim hover:text-od-text'
                          }`}
                        >
                          <span className="truncate">{row.tab.label}</span>
                        </button>
                      ) : (
                        <button
                          key={`${row.tab.key}:${row.title}`}
                          onClick={() => openRow(row)}
                          onMouseEnter={() => setCursor(index)}
                          className={`flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors ${
                            index === activeRowIndex
                              ? 'bg-od-accent/15 text-od-accent'
                              : 'text-od-text hover:bg-od-bg-hover'
                          }`}
                        >
                          {/* 窄阔导航里放不下「标题 + 分区」两列，分区提示换行到第二行 */}
                          <span className="w-full truncate text-sm">{row.title}</span>
                          {row.entry?.section &&
                          row.entry.section !== row.title &&
                          row.entry.section !== row.tab.label ? (
                            <span className="w-full truncate text-[0.7rem] text-od-text-dim">
                              {row.entry.section}
                            </span>
                          ) : null}
                        </button>
                      )
                    )}
                    <div className="px-2.5 pb-1 pt-2 text-[0.7rem] text-od-text-dim">
                      {t.settingsSearchHint}
                    </div>
                  </>
                )
              ) : (
                SETTINGS_GROUPS.map((group) => (
                  <div key={group.key} className="pb-2">
                    <div className="truncate px-2.5 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wide text-od-text-dim">
                      {group.label}
                    </div>
                    {group.tabs.map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => selectTab(tab.key)}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                          activeTab === tab.key
                            ? 'bg-od-accent/15 text-od-accent'
                            : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text'
                        }`}
                      >
                        {tab.isMcp ? (
                          <McpIcon className="h-3 w-3" />
                        ) : (
                          <Icon name={tab.icon} className="w-3" />
                        )}
                        <span className="truncate" title={tab.label}>
                          {tab.label}
                        </span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>

          <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
            <div
              ref={contentRef}
              className={`mx-auto w-full px-6 py-6 ${activeTab === 'statistics' ? 'max-w-6xl' : 'max-w-5xl'}`}
            >
              <ActiveTab />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
