import { contextBridge, ipcRenderer } from 'electron';
import os from 'os';
import type { SessionIdentity } from './src/types/session';
import type { UsageStatistics, UsageStatisticsQuery } from './src/types/usage-statistics';
import type { ExternalApp } from './src/types/shared';

// 渲染层无 node 能力：家目录经 piAPI.homeDir 暴露（注意不能用 window.__X__ ——
// preload 在隔离世界里，主世界读不到那个属性）
const HOME_DIR = os.homedir();

const piAPI = {
  // === Prompting ===
  prompt: (text: string, opts?: any) => ipcRenderer.invoke('pi:prompt', text, opts),
  steer: (text: string) => ipcRenderer.invoke('pi:steer', text),
  followUp: (text: string) => ipcRenderer.invoke('pi:followUp', text),
  abort: (sessionKey?: string | null) => ipcRenderer.invoke('pi:abort', sessionKey),
  clearQueue: () => ipcRenderer.invoke('pi:clearQueue'),
  /** 撤回单条排队消息到聊天框（clearQueue + 其余重新入队） */
  revokeQueuedMessage: (kind: 'steering' | 'followUp', index: number) =>
    ipcRenderer.invoke('pi:revokeQueuedMessage', kind, index),
  /** 删除单条排队消息（只删这一条，不是清空队列） */
  removeQueuedMessage: (kind: 'steering' | 'followUp', index: number) =>
    ipcRenderer.invoke('pi:removeQueuedMessage', kind, index),
  /** 切换单条排队消息的投递方式（引导 ↔ 排队） */
  switchQueuedMessage: (kind: 'steering' | 'followUp', index: number) =>
    ipcRenderer.invoke('pi:switchQueuedMessage', kind, index),
  /** 同队列内拖拽排序：把第 from 条移到插入点 to */
  reorderQueuedMessage: (kind: 'steering' | 'followUp', from: number, to: number) =>
    ipcRenderer.invoke('pi:reorderQueuedMessage', kind, from, to),

  // === Session Management ===
  newSession: (cwd?: string) => ipcRenderer.invoke('pi:newSession', cwd),
  switchSession: (path: string) => ipcRenderer.invoke('pi:switchSession', path),
  fork: (entryId: string, pos?: string) => ipcRenderer.invoke('pi:fork', entryId, pos),
  forkByTimestamp: (timestamp: number, pos?: string) =>
    ipcRenderer.invoke('pi:forkByTimestamp', timestamp, pos),
  duplicateSession: (sessionPath: string) => ipcRenderer.invoke('pi:duplicateSession', sessionPath),
  renameSession: (sessionPath: string, name: string) =>
    ipcRenderer.invoke('pi:renameSession', sessionPath, name),
  exportSessionJsonl: (sessionPath: string, outputPath: string) =>
    ipcRenderer.invoke('pi:exportSessionJsonl', sessionPath, outputPath),
  exportSessionHtml: (sessionPath: string, outputPath: string) =>
    ipcRenderer.invoke('pi:exportSessionHtml', sessionPath, outputPath),
  deleteSession: (sessionPath: string) => ipcRenderer.invoke('pi:deleteSession', sessionPath),
  removeProject: (cwd: string) => ipcRenderer.invoke('pi:removeProject', cwd),
  listSessions: () => ipcRenderer.invoke('pi:listSessions'),
  /** 所有会话槽的状态投影（在跑/未读/等待审批）：侧栏徽标用 */
  getSessionSlots: () => ipcRenderer.invoke('pi:getSessionSlots'),
  /** 槽状态变化推送（主进程节流 ~120ms） */
  onSessionSlots: (cb: (payload: { focusedKey: string; slots: any[] }) => void) => {
    const handler = (_e: unknown, payload: { focusedKey: string; slots: any[] }) => cb(payload);
    ipcRenderer.on('pi:sessionSlots', handler);
    return () => {
      ipcRenderer.off('pi:sessionSlots', handler);
    };
  },
  getTree: () => ipcRenderer.invoke('pi:getTree'),
  getSessionEntry: (entryId: string) => ipcRenderer.invoke('pi:getSessionEntry', entryId),
  navigateTree: (id: string, summarize?: boolean) =>
    ipcRenderer.invoke('pi:navigateTree', id, summarize),
  setSessionName: (name: string) => ipcRenderer.invoke('pi:setSessionName', name),
  exportHtml: (path?: string) => ipcRenderer.invoke('pi:exportHtml', path),

  // === Model ===
  getAvailableModels: () => ipcRenderer.invoke('pi:getAvailableModels'),
  getAllModels: () => ipcRenderer.invoke('pi:getAllModels'),
  setModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke('pi:setModel', provider, modelId),
  cycleModel: () => ipcRenderer.invoke('pi:cycleModel'),
  setThinkingLevel: (level: string) => ipcRenderer.invoke('pi:setThinkingLevel', level),
  cycleThinkingLevel: () => ipcRenderer.invoke('pi:cycleThinkingLevel'),
  getThinkingLevels: () => ipcRenderer.invoke('pi:getThinkingLevels'),
  // 默认模型（~/.pi-desktop/settings.json 的 defaultProvider/defaultModel）
  getDefaultModel: () =>
    ipcRenderer.invoke('pi:getDefaultModel') as Promise<{
      provider: string;
      modelId: string;
    } | null>,
  setDefaultModel: (provider: string | null, modelId: string | null) =>
    ipcRenderer.invoke('pi:setDefaultModel', provider, modelId),

  // === State ===
  getState: () => ipcRenderer.invoke('pi:getState'),
  getMessages: (snapshotId: string, offset: number, limit: number) =>
    ipcRenderer.invoke('pi:getMessages', snapshotId, offset, limit),
  getMessageSnapshot: (identity: SessionIdentity) =>
    ipcRenderer.invoke('pi:getMessageSnapshot', identity),
  releaseMessageSnapshot: (snapshotId: string) =>
    ipcRenderer.invoke('pi:releaseMessageSnapshot', snapshotId),
  /** 从会话历史重建 todo 阶段（最后一条 update_plan 结果） */
  getTodoPhases: () => ipcRenderer.invoke('pi:getTodoPhases'),
  getCommands: () => ipcRenderer.invoke('pi:getCommands'),
  getSessionInfo: () => ipcRenderer.invoke('pi:getSessionInfo'),
  getSessionStats: () => ipcRenderer.invoke('pi:getSessionStats'),
  getUsageStatistics: (
    query: UsageStatisticsQuery,
    requestId: string
  ): Promise<UsageStatistics | null> =>
    ipcRenderer.invoke('pi:getUsageStatistics', query, requestId),
  cancelUsageStatistics: (requestId: string): void =>
    ipcRenderer.send('pi:cancelUsageStatistics', requestId),

  // === Compaction ===
  compact: (instructions?: string) => ipcRenderer.invoke('pi:compact', instructions),
  reloadSession: () => ipcRenderer.invoke('pi:reloadSession'),
  getContextDetail: () => ipcRenderer.invoke('pi:getContextDetail'),
  setAutoCompaction: (enabled: boolean) => ipcRenderer.invoke('pi:setAutoCompaction', enabled),
  getCompactionSettings: () => ipcRenderer.invoke('pi:getCompactionSettings'),
  /** 发送系统通知（kind: turnEnd 对话轮次完成 / ask 模型提问），是否弹出由主进程按设置裁决 */
  notify: (kind: 'turnEnd' | 'ask', title: string, body?: string) =>
    ipcRenderer.invoke('pi:notify', kind, title, body),
  getGlobalInstructions: () => ipcRenderer.invoke('pi:getGlobalInstructions'),
  setGlobalInstructions: (text: string) => ipcRenderer.invoke('pi:setGlobalInstructions', text),
  setCompactionEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('pi:setCompactionEnabled', enabled),
  setCompactionTokens: (reserveTokens?: number, keepRecentTokens?: number) =>
    ipcRenderer.invoke('pi:setCompactionTokens', reserveTokens, keepRecentTokens),

  // === Provider Config ===
  getProviders: () => ipcRenderer.invoke('pi:getProviders'),
  saveProvider: (config: any) => ipcRenderer.invoke('pi:saveProvider', config),
  removeProvider: (key: string) => ipcRenderer.invoke('pi:removeProvider', key),
  setApiKey: (provider: string, key: string) => ipcRenderer.invoke('pi:setApiKey', provider, key),
  checkAuth: (provider: string) => ipcRenderer.invoke('pi:checkAuth', provider),

  // === JD LLM Gateway（已移除，能力并入自定义 Provider 的 fetchModels） ===
  fetchModels: (baseUrl: string, apiKey?: string) =>
    ipcRenderer.invoke('pi:fetchModels', baseUrl, apiKey),
  /** SDK 内置模型目录（离线、无鉴权），用于自定义 Provider 的模型预设 */
  getModelPresets: () => ipcRenderer.invoke('pi:getModelPresets'),

  // === 内置供应商 ===
  getBuiltinProviders: () => ipcRenderer.invoke('pi:getBuiltinProviders'),
  /** 手动刷新供应商与模型清单（允许网络，重新拉取远端模型目录） */
  refreshProviders: () => ipcRenderer.invoke('pi:refreshProviders'),
  setProviderApiKey: (providerId: string, key: string) =>
    ipcRenderer.invoke('pi:setProviderApiKey', providerId, key),
  removeProviderApiKey: (providerId: string) =>
    ipcRenderer.invoke('pi:removeProviderApiKey', providerId),
  // 读取 auth.json 里已保存的内置供应商 Key（编辑表单回填；无则返回 ''）
  getProviderApiKey: (providerId: string) => ipcRenderer.invoke('pi:getProviderApiKey', providerId),

  // === 决策模型（classifier）===
  /** 全部决策模型（含未配置凭据的），带 available 标记 */
  getClassifierModels: () => ipcRenderer.invoke('pi:getClassifierModels'),
  getClassifierLogPath: () => ipcRenderer.invoke('pi:getClassifierLogPath'),
  /** 执行一次分类；classify 不 reject，错误在返回值的 stopReason/errorMessage 里 */
  classify: (request: any) => ipcRenderer.invoke('pi:classify', request),
  /** 自定义决策模型 provider 列表（~/.pi-desktop/classifiers.json） */
  getClassifierProviders: () => ipcRenderer.invoke('pi:getClassifierProviders'),
  saveClassifierProvider: (config: any) => ipcRenderer.invoke('pi:saveClassifierProvider', config),
  removeClassifierProvider: (key: string) => ipcRenderer.invoke('pi:removeClassifierProvider', key),
  /** 从端点探测模型列表（llama.cpp /v1/models） */
  fetchClassifierModels: (baseUrl: string, apiKey?: string) =>
    ipcRenderer.invoke('pi:fetchClassifierModels', baseUrl, apiKey),

  // === 日志（~/.pi-desktop/logs）===
  getLogConfig: () => ipcRenderer.invoke('pi:getLogConfig'),
  setLogConfig: (patch: any) => ipcRenderer.invoke('pi:setLogConfig', patch),
  listLogFiles: () => ipcRenderer.invoke('pi:listLogFiles'),
  readLogTail: (channel: string, maxLines?: number) =>
    ipcRenderer.invoke('pi:readLogTail', channel, maxLines),
  clearLogs: () => ipcRenderer.invoke('pi:clearLogs'),
  openLogFile: (name: string) => ipcRenderer.invoke('pi:openLogFile', name),
  deleteLogFile: (name: string) => ipcRenderer.invoke('pi:deleteLogFile', name),

  // === Skill 管理 ===
  getSkills: () => ipcRenderer.invoke('pi:getSkills'),
  getProjectSkills: (cwd?: string) => ipcRenderer.invoke('pi:getProjectSkills', cwd),
  reloadSkills: () => ipcRenderer.invoke('pi:reloadSkills'),
  readSkillFile: (skillName: string) => ipcRenderer.invoke('pi:readSkillFile', skillName),
  writeSkillFile: (skillName: string, content: string) =>
    ipcRenderer.invoke('pi:writeSkillFile', skillName, content),
  deleteSkill: (skillName: string) => ipcRenderer.invoke('pi:deleteSkill', skillName),
  toggleSkill: (skillName: string, disable: boolean) =>
    ipcRenderer.invoke('pi:toggleSkill', skillName, disable),
  importSkillFromDir: (sourceDir: string) => ipcRenderer.invoke('pi:importSkillFromDir', sourceDir),
  importSkillFromZip: (zipPath: string) => ipcRenderer.invoke('pi:importSkillFromZip', zipPath),
  /** 项目级导入：目标 <cwd>/.agents/skills 或 <cwd>/.pi-desktop/skills */
  importProjectSkillFromDir: (sourceDir: string, projectCwd: string) =>
    ipcRenderer.invoke('pi:importProjectSkillFromDir', sourceDir, projectCwd),
  importProjectSkillFromZip: (zipPath: string, projectCwd: string) =>
    ipcRenderer.invoke('pi:importProjectSkillFromZip', zipPath, projectCwd),

  // === File Operations (for Monaco Code Panel) ===
  readFile: (filePath: string) => ipcRenderer.invoke('pi:readFile', filePath),
  listFiles: (dir?: string) => ipcRenderer.invoke('pi:listFiles', dir),
  detectApps: (): Promise<ExternalApp[]> => ipcRenderer.invoke('pi:detectApps'),
  openWith: (filePath: string, appId: string) => ipcRenderer.invoke('pi:openWith', filePath, appId),
  showInFolder: (filePath: string) => ipcRenderer.invoke('pi:showInFolder', filePath),
  /** 主题明暗联动窗口材质（macOS vibrancy 刷新 / Windows overlay 符号色） */
  setThemeAppearance: (mode: 'dark' | 'light' | 'system') =>
    ipcRenderer.invoke('pi:setThemeAppearance', mode),
  /** 用系统默认浏览器打开外部 URL（markdown 链接点击等场景） */
  openExternal: (url: string) => ipcRenderer.invoke('pi:openExternal', url),

  // === Git ===
  gitStatus: (cwd?: string) => ipcRenderer.invoke('pi:gitStatus', cwd),
  gitBranches: (cwd?: string) => ipcRenderer.invoke('pi:gitBranches', cwd),
  gitSwitchBranch: (branch: string, cwd?: string) =>
    ipcRenderer.invoke('pi:gitSwitchBranch', branch, cwd),
  // 跨平台 basename（renderer 无法直接用 node path）
  baseName: (p: string) => ipcRenderer.invoke('pi:baseName', p),

  // === Misc ===
  getCwd: () => ipcRenderer.invoke('pi:getCwd'),
  setCwd: (cwd: string) => ipcRenderer.invoke('pi:setCwd', cwd),
  selectDirectory: () => ipcRenderer.invoke('pi:selectDirectory'),
  selectFile: (opts?: { title?: string; filters?: any[] }) =>
    ipcRenderer.invoke('pi:selectFile', opts),
  saveDialog: (opts: { title?: string; defaultPath?: string; filters?: any[] }) =>
    ipcRenderer.invoke('pi:saveDialog', opts),
  setPlanMode: (enabled: boolean) => ipcRenderer.invoke('pi:setPlanMode', enabled),
  getPendingInteractions: () => ipcRenderer.invoke('pi:getPendingInteractions'),
  askUserResponse: (sessionId: string, answers: any[] | null) =>
    ipcRenderer.invoke('pi:askUserResponse', sessionId, answers),

  // === 权限沙箱 ===
  getPermissionPolicy: () => ipcRenderer.invoke('pi:getPermissionPolicy'),
  setPermissionPolicy: (policy: string) => ipcRenderer.invoke('pi:setPermissionPolicy', policy),
  getAutoSafeConfig: () => ipcRenderer.invoke('pi:getAutoSafeConfig'),
  setAutoSafeConfig: (config: { safeTools?: string[]; safeBashCommands?: string[] }) =>
    ipcRenderer.invoke('pi:setAutoSafeConfig', config),
  getClassifierApprovalConfig: () => ipcRenderer.invoke('pi:getClassifierApprovalConfig'),
  setClassifierApprovalConfig: (config: {
    providerId?: string;
    modelId?: string;
    timeoutMs?: number;
    minConfidence?: number;
    allowWriteInCwd?: boolean;
  }) => ipcRenderer.invoke('pi:setClassifierApprovalConfig', config),
  permissionResponse: (id: string, decision: 'allow' | 'deny' | 'allow-session') =>
    ipcRenderer.invoke('pi:permissionResponse', { id, decision }),
  getSessionAllowedTools: (): Promise<string[]> => ipcRenderer.invoke('pi:getSessionAllowedTools'),
  clearSessionAllowedTools: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('pi:clearSessionAllowedTools'),
  onPermissionRequest: (cb: (request: any, identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, request: any, identity: SessionIdentity) => cb(request, identity);
    ipcRenderer.on('pi:permissionRequest', handler);
    return () => {
      ipcRenderer.off('pi:permissionRequest', handler);
    };
  },

  // === UI 设置（~/.pi-desktop/ui-config.json） ===
  getUiSettings: () => ipcRenderer.invoke('pi:getUiSettings'),
  setUiSettings: (patch: any) => ipcRenderer.invoke('pi:setUiSettings', patch),
  // === read_img 图片识别模型 ===
  getVisionModels: () =>
    ipcRenderer.invoke('pi:getVisionModels') as Promise<
      Array<{ provider: string; id: string; name: string }>
    >,
  setReadImgModel: (provider: string | null, modelId: string | null) =>
    ipcRenderer.invoke('pi:setReadImgModel', provider, modelId),
  // Windows/Linux 关于弹窗
  showAbout: () => ipcRenderer.invoke('pi:showAbout'),
  /** 开源许可清单窗口（清单构建期生成，随安装包分发） */
  openThirdPartyNotices: () => ipcRenderer.invoke('pi:openThirdPartyNotices'),
  onMenuOpenFolder: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('pi:menuOpenFolder', handler);
    return () => {
      ipcRenderer.off('pi:menuOpenFolder', handler);
    };
  },
  onMenuOpenSettings: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('pi:menuOpenSettings', handler);
    return () => {
      ipcRenderer.off('pi:menuOpenSettings', handler);
    };
  },
  onAskUser: (cb: (questions: any[], identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, questions: any[], identity: SessionIdentity) =>
      cb(questions, identity);
    ipcRenderer.on('pi:askUser', handler);
    return () => {
      ipcRenderer.off('pi:askUser', handler);
    };
  },
  onPlanProposal: (cb: (proposal: any, identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, proposal: any, identity: SessionIdentity) =>
      cb(proposal, identity);
    ipcRenderer.on('pi:planProposal', handler);
    return () => {
      ipcRenderer.off('pi:planProposal', handler);
    };
  },
  onPlanUpdate: (cb: (snapshot: any, identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, snapshot: any, identity: SessionIdentity) =>
      cb(snapshot, identity);
    ipcRenderer.on('pi:planUpdate', handler);
    return () => {
      ipcRenderer.off('pi:planUpdate', handler);
    };
  },
  // === Plan 模式 ===
  plan: {
    enter: () => ipcRenderer.invoke('pi:plan:enter'),
    exit: () => ipcRenderer.invoke('pi:plan:exit'),
    get: () => ipcRenderer.invoke('pi:plan:get'),
    submitResponse: (id: string, decision: any) =>
      ipcRenderer.invoke('pi:plan:submitResponse', id, decision)
  },

  platform: process.platform,

  /** 用户家目录（渲染层无 os 模块；面包屑缩写与 Git 家目录跳过探测用） */
  homeDir: HOME_DIR,

  // === 生命周期钩子（~/.pi-desktop/hooks.json） ===
  getHooks: () => ipcRenderer.invoke('pi:getHooks'),
  upsertHook: (hook: any) => ipcRenderer.invoke('pi:upsertHook', hook),
  deleteHook: (id: string) => ipcRenderer.invoke('pi:deleteHook', id),
  setHookEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('pi:setHookEnabled', id, enabled),

  // === MCP ===
  getMcpConfig: () => ipcRenderer.invoke('pi:getMcpConfig'),
  saveMcpConfig: (config: any) => ipcRenderer.invoke('pi:saveMcpConfig', config),
  getProjectMcpConfig: (cwd?: string) => ipcRenderer.invoke('pi:getProjectMcpConfig', cwd),
  saveProjectMcpConfig: (config: any, cwd?: string) =>
    ipcRenderer.invoke('pi:saveProjectMcpConfig', config, cwd),
  connectMcpServer: (name: string, entry: any) =>
    ipcRenderer.invoke('pi:connectMcpServer', name, entry),
  disconnectMcpServer: (name: string) => ipcRenderer.invoke('pi:disconnectMcpServer', name),
  getMcpStatus: () => ipcRenderer.invoke('pi:getMcpStatus'),
  getMcpTools: () => ipcRenderer.invoke('pi:getMcpTools'),
  getMcpAutoConnect: () => ipcRenderer.invoke('pi:getMcpAutoConnect'),
  setMcpAutoConnect: (v: boolean) => ipcRenderer.invoke('pi:setMcpAutoConnect', v),

  // === 内置浏览器 ===
  browser: {
    getState: () => ipcRenderer.invoke('pi:browser:getState'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('pi:browser:setEnabled', enabled),
    setDevtoolsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('pi:browser:setDevtoolsEnabled', enabled),
    open: (url?: string) => ipcRenderer.invoke('pi:browser:open', url),
    close: (tabId?: string) => ipcRenderer.invoke('pi:browser:close', tabId),
    activate: (tabId: string) => ipcRenderer.invoke('pi:browser:activate', tabId),
    navigate: (tabId: string | undefined, input: string) =>
      ipcRenderer.invoke('pi:browser:navigate', tabId, input),
    back: (tabId?: string) => ipcRenderer.invoke('pi:browser:back', tabId),
    forward: (tabId?: string) => ipcRenderer.invoke('pi:browser:forward', tabId),
    reload: (tabId?: string) => ipcRenderer.invoke('pi:browser:reload', tabId),
    stop: (tabId?: string) => ipcRenderer.invoke('pi:browser:stop', tabId),
    setViewport: (viewport: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('pi:browser:setViewport', viewport),
    setVisible: (visible: boolean) => ipcRenderer.invoke('pi:browser:setVisible', visible),
    clearData: () => ipcRenderer.invoke('pi:browser:clearData')
  },
  onBrowserStateChanged: (cb: (state: any) => void) => {
    const handler = (_e: unknown, state: any) => cb(state);
    ipcRenderer.on('pi:browserStateChanged', handler);
    return () => ipcRenderer.off('pi:browserStateChanged', handler);
  },
  onBrowserFocusRequested: (cb: (tabId: string) => void) => {
    const handler = (_e: unknown, tabId: string) => cb(tabId);
    ipcRenderer.on('pi:browserFocusRequested', handler);
    return () => ipcRenderer.off('pi:browserFocusRequested', handler);
  },

  // === Terminal (node-pty) ===
  terminalCreate: (opts?: { cwd?: string; cols?: number; rows?: number; shell?: string }) =>
    ipcRenderer.invoke('pi:terminal:create', opts),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('pi:terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pi:terminal:resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.invoke('pi:terminal:kill', id),
  terminalList: () => ipcRenderer.invoke('pi:terminal:list'),
  terminalDetectShells: () => ipcRenderer.invoke('pi:terminal:detectShells'),
  terminalTheme: (key: string) => ipcRenderer.invoke('pi:terminalTheme', key),
  onTerminalData: (id: string, cb: (data: string) => void) => {
    const channel = `pi:terminal:data:${id}`;
    const handler = (_e: unknown, data: string) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  },
  onTerminalExit: (id: string, cb: (exitCode: number) => void) => {
    const channel = `pi:terminal:exit:${id}`;
    const handler = (_e: unknown, code: number) => cb(code);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  },

  // === Goal Mode ===
  goal: {
    create: (text: string, tokenBudget?: number) =>
      ipcRenderer.invoke('pi:goal:create', text, tokenBudget),
    pause: () => ipcRenderer.invoke('pi:goal:pause'),
    resume: () => ipcRenderer.invoke('pi:goal:resume'),
    clear: () => ipcRenderer.invoke('pi:goal:clear'),
    edit: (text?: string, tokenBudget?: number | null) =>
      ipcRenderer.invoke('pi:goal:edit', text, tokenBudget),
    get: () => ipcRenderer.invoke('pi:goal:get')
  },
  onGoalUpdate: (cb: (snapshot: any, identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, snapshot: any, identity: SessionIdentity) =>
      cb(snapshot, identity);
    ipcRenderer.on('pi:goalUpdate', handler);
    return () => {
      ipcRenderer.off('pi:goalUpdate', handler);
    };
  },

  // === Subagent 系统 ===
  subagents: {
    getSnapshot: () => ipcRenderer.invoke('pi:subagent:getSnapshot'),
    stop: (runId: string) => ipcRenderer.invoke('pi:subagent:stop', runId),
    steer: (runId: string, text: string) => ipcRenderer.invoke('pi:subagent:steer', runId, text),
    reload: () => ipcRenderer.invoke('pi:subagent:reload'),
    getSession: (runId: string) => ipcRenderer.invoke('pi:subagent:getSession', runId),
    getConfig: () => ipcRenderer.invoke('pi:subagent:getConfig'),
    setConfig: (patch: any) => ipcRenderer.invoke('pi:subagent:setConfig', patch)
  },
  onSubagentUpdate: (cb: (snapshot: any, identity: SessionIdentity) => void) => {
    const handler = (_e: unknown, snapshot: any, identity: SessionIdentity) =>
      cb(snapshot, identity);
    ipcRenderer.on('pi:subagentUpdate', handler);
    return () => {
      ipcRenderer.off('pi:subagentUpdate', handler);
    };
  },

  // === 后台任务 ===
  backgroundTasks: {
    getSnapshot: () => ipcRenderer.invoke('pi:backgroundTasks:getSnapshot'),
    kill: (taskId: string) => ipcRenderer.invoke('pi:backgroundTasks:kill', taskId),
    remove: (taskIds: string[]) => ipcRenderer.invoke('pi:backgroundTasks:remove', taskIds),
    readLogs: (taskId: string, options?: { tail?: boolean; maxBytes?: number }) =>
      ipcRenderer.invoke('pi:backgroundTasks:readLogs', taskId, options)
  },
  onBackgroundTaskUpdate: (cb: (snapshot: any) => void) => {
    const handler = (_e: unknown, snapshot: any) => cb(snapshot);
    ipcRenderer.on('pi:backgroundTaskUpdate', handler);
    return () => {
      ipcRenderer.off('pi:backgroundTaskUpdate', handler);
    };
  },

  // === Event Stream ===
  onEvent: (callback: (event: any) => void) => {
    const handler = (_e: unknown, event: any) => callback(event);
    ipcRenderer.on('pi:event', handler);
    return () => {
      ipcRenderer.off('pi:event', handler);
    };
  },

  // === 退出/关窗确认（会话运行中时主进程会先问一次） ===
  onQuitConfirmRequest: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('pi:quitConfirmRequest', handler);
    return () => {
      ipcRenderer.off('pi:quitConfirmRequest', handler);
    };
  },
  /** 回答退出确认：true 主进程才真正退出（false 保持运行） */
  resolveQuitConfirm: (confirmed: boolean) =>
    ipcRenderer.invoke('pi:resolveQuitConfirm', confirmed),

  // === git-ai 改动溯源 ===
  gitAi: {
    getConfig: () => ipcRenderer.invoke('pi:gitAi:getConfig'),
    setConfig: (patch: any) => ipcRenderer.invoke('pi:gitAi:setConfig', patch),
    detect: () => ipcRenderer.invoke('pi:gitAi:detect')
  },

  // === 内置网络搜索（免 Key） ===
  webSearch: {
    getConfig: () => ipcRenderer.invoke('pi:webSearch:getConfig'),
    setConfig: (patch: any) => ipcRenderer.invoke('pi:webSearch:setConfig', patch),
    test: (options?: { query?: string }) => ipcRenderer.invoke('pi:webSearch:test', options)
  },

  // === Memory ===
  memory: {
    getConfig: () => ipcRenderer.invoke('pi:memory:getConfig'),
    setConfig: (patch: any) => ipcRenderer.invoke('pi:memory:setConfig', patch),
    readFile: (fileId: string, projectName?: string) =>
      ipcRenderer.invoke('pi:memory:readFile', fileId, projectName),
    writeFile: (
      fileId: string,
      content: string,
      projectName: string | undefined,
      baseRevision: string
    ) => ipcRenderer.invoke('pi:memory:writeFile', fileId, content, projectName, baseRevision),
    getDir: () => ipcRenderer.invoke('pi:memory:getDir'),
    getFilePath: (fileId: string, projectName?: string) =>
      ipcRenderer.invoke('pi:memory:getFilePath', fileId, projectName),
    extract: () => ipcRenderer.invoke('pi:memory:extract'),
    consolidate: () => ipcRenderer.invoke('pi:memory:consolidate'),
    getStatus: () => ipcRenderer.invoke('pi:memory:getStatus'),
    cancel: () => ipcRenderer.invoke('pi:memory:cancel'),
    review: (id: string, projectId: string, accept: boolean, edits?: Record<string, string>) =>
      ipcRenderer.invoke('pi:memory:review', id, projectId, accept, edits),
    rollback: (id: string, projectId: string) =>
      ipcRenderer.invoke('pi:memory:rollback', id, projectId),
    migrateLegacy: (name: string, projectId: string) =>
      ipcRenderer.invoke('pi:memory:migrateLegacy', name, projectId),
    readEntry: (id: string) => ipcRenderer.invoke('pi:memory:readEntry', id),
    search: (query: string) => ipcRenderer.invoke('pi:memory:search', query),
    readExtraction: (fileName: string) => ipcRenderer.invoke('pi:memory:readExtraction', fileName)
  },
  onMemoryProgress: (cb: (progress: any) => void) => {
    const handler = (_e: unknown, progress: any) => cb(progress);
    ipcRenderer.on('pi:memoryProgress', handler);
    return () => {
      ipcRenderer.off('pi:memoryProgress', handler);
    };
  }
};

contextBridge.exposeInMainWorld('pi', piAPI);

export type PiAPI = typeof piAPI;
