/**
 * 设置页导航与搜索目录。
 *
 * 三件事集中在这里，避免 SettingsPage 越写越乱：
 * 1. `SETTINGS_GROUPS` —— 左栏分组导航（参照 Codex 设置页的「个人 / 集成 / 编码」分组）
 * 2. `SETTINGS_SEARCH_ENTRIES` —— 可搜索条目目录（tab + 分区标题 + 别名），供左栏搜索使用
 * 3. `searchSettings` / `flattenSettingsResults` —— 纯函数，便于单测
 *
 * 约定：条目的 `section` 必须是该 tab 内真实渲染的分区标题文案（`<h3>` 的文本，
 * 通常直接取 `t.xxx`）。搜索命中后靠它在页面里找元素并滚动 + 短暂高亮；
 * 写了不存在的标题不会报错，只是退化成「只切到该 tab」。
 * `keywords` 只参与匹配、不展示，因此不受「用户可见文案走 i18n」约束。
 */
import type { IconName } from '../common/icons';
import { t } from '../../i18n/zh';

export type SettingsTabKey =
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
  | 'shortcuts'
  | 'logs';

export interface SettingsTabMeta {
  key: SettingsTabKey;
  label: string;
  icon: IconName;
  /** MCP tab 用 multicolor 图标，不走 Icon 字体 */
  isMcp?: boolean;
}

export interface SettingsGroup {
  key: string;
  label: string;
  tabs: SettingsTabMeta[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    key: 'interface',
    label: t.settingsGroupInterface,
    tabs: [
      { key: 'appearance', label: t.tabAppearance, icon: 'sun' },
      { key: 'shortcuts', label: t.tabShortcuts, icon: 'keyboard' }
    ]
  },
  {
    key: 'agent',
    label: t.settingsGroupAgent,
    tabs: [
      { key: 'models', label: t.tabModels, icon: 'brain' },
      { key: 'classifier', label: t.tabClassifier, icon: 'classifier' },
      { key: 'agent', label: t.tabAgent, icon: 'robot' },
      { key: 'memory', label: t.tabMemory, icon: 'memory' }
    ]
  },
  {
    key: 'extensions',
    label: t.settingsGroupExtensions,
    tabs: [
      { key: 'browser', label: t.tabBrowser, icon: 'browser' },
      { key: 'hooks', label: t.tabHooks, icon: 'hook' },
      { key: 'skills', label: t.tabSkills, icon: 'cube' },
      { key: 'mcp', label: t.tabMcp, icon: 'settings', isMcp: true }
    ]
  },
  {
    key: 'data',
    label: t.settingsGroupData,
    tabs: [
      { key: 'statistics', label: t.tabStatistics, icon: 'statistics' },
      { key: 'logs', label: t.tabLogs, icon: 'logs' }
    ]
  }
];

/** 扁平化后的 tab 顺序（与左栏渲染顺序一致） */
export const SETTINGS_TABS: SettingsTabMeta[] = SETTINGS_GROUPS.flatMap((group) => group.tabs);

export const SETTINGS_TAB_BY_KEY = new Map<SettingsTabKey, SettingsTabMeta>(
  SETTINGS_TABS.map((tab) => [tab.key, tab])
);

export interface SettingsSearchEntry {
  tab: SettingsTabKey;
  /** 条目名（展示给用户，也参与匹配） */
  title: string;
  /** 别名 / 英文 / 常见叫法：只参与匹配 */
  keywords?: string[];
  /** 该条目所在分区的标题（= tab 内 h3 的文本），用于滚动定位 */
  section?: string;
}

/**
 * 搜索目录。粒度是「分区」，不是每个开关 —— 设置项太多，逐项登记维护成本高且容易腐化；
 * 分区级足以把用户送到正确位置，剩下的靠肉眼。
 */
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  // ===== 界面 =====
  {
    tab: 'appearance',
    title: '主题与配色',
    section: t.theme,
    keywords: ['主题', '配色', '颜色', '颜色模式', '深色', '浅色', '主题族', 'one dark', 'theme']
  },
  {
    tab: 'appearance',
    title: '界面字号、字体与毛玻璃',
    section: t.appearance,
    keywords: [
      '字号',
      '字体',
      '缩放',
      'ui 字体',
      '界面',
      'font',
      'zoom',
      '毛玻璃',
      '半透明',
      '透明',
      '不透明',
      '玻璃',
      '模糊',
      '背景',
      'vibrancy',
      'acrylic',
      'blur',
      'translucent'
    ]
  },
  {
    tab: 'appearance',
    title: t.editorSettings,
    section: t.editorSettings,
    keywords: ['编辑器', 'monaco', '行号', '换行', '缩进', '连字', '光标', '小地图']
  },
  {
    tab: 'appearance',
    title: t.terminalSettings,
    section: t.terminalSettings,
    keywords: ['终端', 'shell', '字体', '字号', '配色', 'terminal', 'bash', 'zsh', 'powershell']
  },
  {
    tab: 'appearance',
    title: t.chatSettings,
    section: t.chatSettings,
    keywords: ['聊天', '消息', '书签', '思考块', '工具调用', '折叠', '发送模式', 'markdown']
  },
  {
    tab: 'appearance',
    title: t.notifications,
    section: t.notifications,
    keywords: ['通知', '提醒', '声音', '失焦', '完成', '询问', 'notification']
  },
  // ===== 键盘快捷键 =====
  {
    tab: 'shortcuts',
    title: t.shortcutsNumberKeys,
    keywords: ['数字键', '1-9', '标签页', '切换标签', '工作区']
  },
  {
    tab: 'shortcuts',
    title: '快捷键绑定',
    keywords: ['快捷键', '按键', '组合键', '改键', '绑定', '键位', 'keybinding', 'shortcut']
  },
  // ===== 模型配置 =====
  {
    tab: 'models',
    title: '模型与供应商',
    section: t.providers,
    keywords: [
      '模型',
      '供应商',
      'api key',
      '密钥',
      'baseurl',
      '拉取',
      '自定义模型',
      'openai',
      'anthropic',
      'deepseek',
      'model'
    ]
  },
  {
    tab: 'models',
    title: t.modelPresetSection,
    section: t.providers,
    keywords: ['预设', '上下文窗口', '最大输出', '价格', '视觉', '思考等级', '推理']
  },
  // ===== 决策模型 =====
  {
    tab: 'classifier',
    title: t.classifierAvailable,
    section: t.classifierAvailable,
    keywords: ['决策模型', '分类器', '权限判断', '审批', 'classifier']
  },
  {
    tab: 'classifier',
    title: t.classifierCustomProviders,
    section: t.classifierCustomProviders,
    keywords: ['决策模型端点', '自定义', 'api key', 'baseurl', '端点']
  },
  {
    tab: 'classifier',
    title: t.classifierPlayground,
    section: t.classifierPlayground,
    keywords: ['试跑', '测试', '调试', '结果', 'playground']
  },
  // ===== 智能体配置 =====
  {
    tab: 'agent',
    title: t.defaultModelSection,
    section: t.defaultModelSection,
    keywords: ['默认模型', '模型', '思考等级', '推理强度']
  },
  {
    tab: 'agent',
    title: t.pendingModeSection,
    section: t.pendingModeSection,
    keywords: ['待发送', '排队', '发送模式', 'steer', 'follow up']
  },
  {
    tab: 'agent',
    title: t.readImgSection,
    section: t.readImgSection,
    keywords: ['图片', '识图', '视觉', 'read_img', 'ocr']
  },
  {
    tab: 'agent',
    title: t.webSearchSection,
    section: t.webSearchSection,
    keywords: [
      '搜索',
      '网络',
      '联网',
      'web_search',
      '搜索引擎',
      'bing',
      'brave',
      'searxng',
      '免 key'
    ]
  },
  {
    tab: 'agent',
    title: t.subagentSection,
    section: t.subagentSection,
    keywords: ['子智能体', '子 agent', 'subagent', 'task', '委派', '并行', '子任务']
  },
  {
    tab: 'agent',
    title: t.permissionSettings,
    section: t.permissionSettings,
    keywords: ['权限', '沙箱', '审批', 'auto-safe', 'permission', '允许', '拒绝']
  },
  {
    tab: 'agent',
    title: t.globalInstructions,
    section: t.globalInstructions,
    keywords: ['指令', 'agents.md', '系统提示词', '自定义指令', 'prompt']
  },
  {
    tab: 'agent',
    title: t.compactionSection,
    section: t.compactionSection,
    keywords: ['压缩', '上下文', 'compaction', 'reserve', 'keep recent', 'token']
  },
  {
    tab: 'agent',
    title: t.gitAiSection,
    section: t.gitAiSection,
    keywords: ['git-ai', '溯源', 'blame', '改动来源', '上报']
  },
  // ===== 内置浏览器 =====
  {
    tab: 'browser',
    title: t.browserSettings,
    section: t.browserSettings,
    keywords: ['浏览器', '截图', '点击', 'devtools', 'cdp', '标签页', 'browser', '网页']
  },
  // ===== 记忆系统 =====
  {
    tab: 'memory',
    title: '记忆与写入策略',
    section: t.memory.title,
    keywords: ['记忆', '长期记忆', '提取', '候选', '审核', 'memory', 'user.md', 'memory.md']
  },
  {
    tab: 'memory',
    title: t.memory.filesSection,
    section: t.memory.filesSection,
    keywords: ['记忆文件', '项目记忆', 'lessons', 'standing', '文件']
  },
  // ===== 钩子 =====
  {
    tab: 'hooks',
    title: t.hooks.title,
    section: t.hooks.title,
    keywords: ['钩子', 'hook', '生命周期', 'session_start', 'tool_call', '阻止', '改写', 'shell']
  },
  // ===== Skill =====
  {
    tab: 'skills',
    title: '技能目录与启停',
    section: t.skills,
    keywords: ['技能', 'skill', 'skill-creator', '用户级', '项目级', '斜杠命令']
  },
  // ===== MCP =====
  {
    tab: 'mcp',
    title: 'MCP 连接与工具',
    section: t.mcpTitle,
    keywords: ['mcp', 'stdio', 'http', 'sse', '工具', '连接', '服务器', '代理', 'server']
  },
  // ===== 数据统计 =====
  {
    tab: 'statistics',
    title: '用量与费用',
    section: t.tabStatistics,
    keywords: ['统计', 'token', '用量', '成本', '费用', '模型使用', 'usage', '缓存']
  },
  // ===== 日志 =====
  {
    tab: 'logs',
    title: t.logsChannelsTitle,
    section: t.logsChannelsTitle,
    keywords: ['日志', '通道', '开关', 'debug', '级别', 'log']
  },
  {
    tab: 'logs',
    title: t.logsFilesTitle,
    section: t.logsFilesTitle,
    keywords: ['日志文件', 'jsonl', '导出', '清理', '磁盘']
  },
  {
    tab: 'logs',
    title: t.logsPreviewTitle,
    section: t.logsPreviewTitle,
    keywords: ['最近日志', '预览', '排查', 'diagnose']
  }
];

export interface SettingsSearchResult {
  tab: SettingsTabMeta;
  /** tab 名称本身命中（此时即使没有分区命中也要给出结果） */
  tabHit: boolean;
  entries: SettingsSearchEntry[];
}

/** 归一化：小写 + 去掉空白（中文用户常带空格搜索「字体 大小」） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function entryHaystack(entry: SettingsSearchEntry): string {
  return normalize([entry.title, entry.section ?? '', ...(entry.keywords ?? [])].join(' '));
}

/**
 * 设置搜索：先按左栏顺序遍历 tab，再在每个 tab 内按目录顺序取命中的分区。
 * 空查询返回空数组（不是全部）—— 由调用方决定「无查询时显示分组导航」。
 */
export function searchSettings(query: string): SettingsSearchResult[] {
  const q = normalize(query);
  if (!q) return [];

  const results: SettingsSearchResult[] = [];
  for (const tab of SETTINGS_TABS) {
    const tabHit = normalize(tab.label).includes(q);
    const entries = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.tab === tab.key && entryHaystack(entry).includes(q)
    );
    if (tabHit || entries.length > 0) results.push({ tab, tabHit, entries });
  }
  return results;
}

export interface SettingsSearchRow {
  tab: SettingsTabMeta;
  /** 分组头（也是该 tab 的「回到顶部」行）：点击只切到该 tab */
  tabLevel: boolean;
  entry: SettingsSearchEntry | null;
  title: string;
}

/**
 * 把分组结果摊平成可上下选择的一维列表：每个 tab 先给出一个分组头行，
 * 再跟上命中的分区。分组头兼作「打开该页」入口，所以条目名要避开 tab 名（否那么两行重名）。
 */
export function flattenSettingsResults(results: SettingsSearchResult[]): SettingsSearchRow[] {
  const rows: SettingsSearchRow[] = [];
  for (const result of results) {
    rows.push({ tab: result.tab, tabLevel: true, entry: null, title: result.tab.label });
    for (const entry of result.entries) {
      rows.push({ tab: result.tab, tabLevel: false, entry, title: entry.title });
    }
  }
  return rows;
}
