# AGENTS.md

本文件为 AI 编码助手（pi / Claude / Codex 等）在本仓库工作时提供项目上下文与约定。

## 项目概述

**pi-desktop** —— 基于 pi agent SDK（`@earendil-works/pi-coding-agent`）构建的 Electron 桌面端 AI 编码助手。提供对话、会话树、代码/diff 工作区、内置终端与浏览器、MCP、技能与钩子、记忆、Goal/Plan 长任务、子 agent 与后台任务、多供应商模型管理等能力。

- 技术栈：Electron 44 + React 18 + TypeScript 5 + Vite 6 + Zustand 4（单一 store）+ Tailwind CSS 3 + Monaco Editor + xterm.js/node-pty
- pi SDK 版本：`@earendil-works/pi-coding-agent@1.0.1`（底层依赖 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`），**进程内**使用，不 spawn `pi` CLI
- 配置目录：`~/.pi-desktop/`，与 pi CLI 的 `~/.pi/agent/` 完全隔离（无迁移）
- UI 色板：One Dark Pro（Tailwind 自定义 `od-*` 色系，见 `tailwind.config.ts`）
- 语言：界面文案为中文，集中管理在 `src/i18n/zh.ts`
- 面向用户的完整功能说明见 `README.md`

## 常用命令

```bash
npm run dev          # 启动开发（Vite dev server + Electron 主进程，自动打开窗口与 DevTools）
npm run build        # tsc -b 类型检查 + vite build 生产构建
npm run electron:build  # 打包当前平台安装包（mac dmg / win nsis / linux AppImage）
npm run electron:build:win      # Windows x64 便携版（portable）
npm run electron:build:win:dir  # Windows x64 免安装目录
npm run icons        # 由 SVG 生成 icon.png/.ico/.icns
npm run notices      # 生成第三方许可清单 resources/THIRD-PARTY-NOTICES.txt（electron:build* 前自动跑）
npm run lint         # ESLint 检查（0 error，warning 为未使用变量等非阻断项）
npm run lint:fix     # ESLint 自动修复
npm run format       # Prettier 格式化所有源码
npm run format:check # Prettier 格式检查
npm test            # 运行 Vitest 测试套件（单次）
npm run test:watch  # Vitest watch 模式
npm run test:coverage  # Vitest + 覆盖率报告
```

- 类型检查：`npx tsc -b`（无输出即通过）
- Lint：`npm run lint`（应保持 0 error）
- 格式：`npm run format` 提交前统一格式
- 测试：`npm test`（Vitest，`tests/` 按领域分目录，共 77 个测试文件；单领域用 `npx vitest run tests/<领域>`）。覆盖会话加载与生命周期、记忆流水线、子 agent、权限与决策模型、Goal/Plan 状态机与持久化、后台任务、浏览器、日志、统计、MCP 配置、git-ai、模型预设、聊天辅助与纯工具函数
- 首次 `npm install` 会跑 `postinstall`：`scripts/fix-pty-perm.js`（node-pty 权限）+ `scripts/patch-pi-loader.js`（SDK 扩展加载器补丁）

## 架构与进程模型

三进程结构，IPC 是唯一的跨进程通信方式：

```
Electron 主进程 (electron/)
   ├── main.ts            入口，创建 BrowserWindow、菜单、单实例锁、退出确认（最先导入 config-dir 设置配置目录）
   ├── config-dir.ts      定义 ~/.pi-desktop 配置目录（设置 PI_CODING_AGENT_DIR 环境变量重定向 SDK 默认路径）
   ├── pi-bridge.ts       核心：封装 pi SDK 的 AgentSession/ModelRuntime，注册全部 IPC handler
   ├── ipc/               按功能拆分的 IPC handler（20 个 registerXxxIpc，注册顺序见 pi-bridge.ts）
   ├── provider-config.ts 读写 ~/.pi-desktop/models.json（自定义 provider 配置）+ 通用 /v1/models 拉取
   ├── model-presets.ts   由 SDK 内置模型目录构建的预设索引（IPC pi:getModelPresets）
   ├── goal/ plan/        长任务：目标状态机与计划模式（controller/extension/tools/persistence）
   ├── subagents/         子 agent 委派（registry/controller/persistence/子会话文件）
   ├── background-tasks/  后台任务 bg_run（registry/persistence，输出与保留上限）
   ├── memory/            长期记忆（提取/合并流水线、store、注入、审核）
   ├── hooks/             生命周期钩子（config/extension/runner）
   ├── mcp/               MCP 客户端（manager/config/proxy-tool，stdio/HTTP/SSE）
   ├── permission/        权限沙箱（controller/policy/classifier-gate）
   ├── classifier/ + classifier-config.ts  决策模型注册表与配置
   ├── browser/           内置浏览器 + pi-browser MCP 服务（controller/mcp-server/evaluate/traffic）
   ├── statistics/        用量统计（worker 线程扫描会话 JSONL，usage-worker.ts 是独立构建入口）
   ├── logs/              分通道 JSONL 日志（logger/channel-logs/agent-events/classifier-log）
   ├── git-ai/            改动溯源（config/paths/status/extension）
   ├── tools/             注入给模型的自定义工具（todo/ask/mcp/read_img）
   ├── session-access.ts  会话替换锁与消息快照；runtime-lifecycle.ts 负责 runtime 释放
   └── sandbox-extension.ts 沙箱扩展（占位，未接入 pi-bridge）

预加载脚本 (preload.ts)
   └── contextBridge 暴露 window.pi API（renderer 唯一访问主进程的入口）

渲染进程 (src/)
   └── React 应用，通过 window.pi.* 调 IPC，绝不直接 require electron
```

### 关键路径与目录

- **配置数据目录：`~/.pi-desktop/`**（桌面端独立目录，与 pi CLI 的 `~/.pi/agent` 完全隔离，不做任何迁移）
  - `ui-config.json` —— UI 偏好（字号/面板宽度/终端字体/模式等，渲染进程经 `pi:getUiSettings` / `pi:setUiSettings` IPC 读写，见 `electron/ipc/settings-ipc.ts`）
  - `settings.json` —— SDK 配置（上下文压缩 compaction 等）
  - `models.json` —— 自定义 provider 配置（设置页增删）
  - `auth.json` —— 内置供应商凭证存储
  - `classifiers.json` —— 决策模型端点配置（`electron/classifier-config.ts`）
  - `hooks.json` —— 生命周期钩子（`electron/hooks/config.ts`）
  - `git-ai.json` —— git-ai 改动溯源（启用/路径/上报范围）
  - `mcp.json` / `mcp-cache.json` —— MCP 服务器配置与缓存
  - `models-store.json` —— SDK 模型清单缓存
  - `trust.json` —— 项目信任状态
  - `sessions/` —— 会话持久化（JSONL）
  - `skills/` / `prompts/` / `themes/` / `agents/` —— 用户级技能/prompt 模板/主题/子 agent 定义
  - `memory/` —— 长期记忆（USER.md / MEMORY.md / LESSONS.md / STANDING.md + 项目记忆）
  - `logs/` —— 分通道 JSONL 日志（默认关闭）
  - `AGENTS.md` —— 全局自定义指令（设置页「智能体配置」可编辑）
  - 项目级配置在项目内：`<cwd>/.mcp.json`、`<cwd>/.pi-desktop/{skills,agents}`
- 随安装包发布的只读资源（源码在 `resources/`，electron-builder `extraResources` 拷到 `process.resourcesPath/`）：
  - `resources/skills` → `skills`（内置技能 `skill-creator`，经 `additionalSkillPaths` 注入）、`resources/agents` → `agents`（内置子 agent：generalist/reviewer/scout/worker）、`resources/terminal-themes` → `terminal-themes`（20 套终端配色）
  - `resources/docs` → `docs`：`pi-desktop-system-prompt.md` 注入系统提示词，`pi-desktop.md` 是给模型的完整说明（按需 read）
- pi SDK 内置 provider 目录：`node_modules/@earendil-works/pi-ai/dist/providers/`（42 个内置供应商，每个含 `xxx.models.js` 模型清单）。注意 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-tui` 等都是**顶层依赖**（`node_modules/@earendil-works/`），不在 pi-coding-agent 的嵌套 node_modules 里
- pi SDK 事件类型：`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` 的 `AgentEvent`

## 数据流与状态管理

### 状态层（`src/store/pi-store.ts`）

- 单一 Zustand store `usePiStore`，含 messages / model / availableModels / session 信息 / 会话槽投影（`sessionSlots`）/ UI 偏好等
- **流式消息不在 store 里**：`src/lib/streaming-message.ts` 是模块级单槽（`setStreamingMessage` / `getStreamingMessage` / `subscribeStreamingMessage`，rAF 合帧 + `startTransition` 提交，清空时同步提交），组件用 `src/hooks/useStreamingMessage.ts` 订阅。**禁止把流式消息放回 store**（逐 token 全量 set 会让所有订阅者重渲染，这是 P1 优化前的性能根因）；`setSessionInfo` 会清空它
- UI 偏好（fontSize、sidebarWidth、rightPanelWidth、themeFamily、monaco*/terminal*/notify* 等）持久化到 `~/.pi-desktop/ui-config.json`（经 `pi:setUiSettings` IPC），带 clamp 边界；启动时先用默认值，App 挂载后 `loadUiSettings()` 异步覆盖
- 历史字段：`codePanelWidth` 已迁移为 `rightPanelWidth`；`fileTreeWidth` 仍持久化但由 `src/components/code/CodePanel.tsx` / `src/components/workspace/RightWorkspace.tsx` 直接读，不在 store 的 PiState 里
- 常量：`FONT_SIZE_MIN=12`、`FONT_SIZE_MAX=999`（不限制上限）

### 事件订阅（`src/hooks/usePiEvent.ts`）

- `usePiEventSubscription()` 在 App 根挂载一次，订阅 `window.pi.onEvent` 把 SDK 事件分发到 store
- **重要陷阱**：`agent_end` 事件的 `event.messages` 只是**本轮新增消息**（prompts + 本次 assistant 回复），不含历史。UI 使用增量合并，不能用它覆盖历史。重载完整历史走 `getMessageSnapshot(identity)` → `getMessages(snapshotId, offset, limit)` → `releaseMessageSnapshot`，统一由 `src/hooks/loadSession.ts` 管理
- 用户消息在 `message_end`（role=user）时立即追加到 store；`agent_end` 按稳定键增量合并，不全量传输消息。

### 会话槽与多会话后台运行

- 主进程用「会话槽」承载会话：`electron/session-slot.ts` 的 `SessionSlot`（runtime / session / cwd / sessionManager / 独立 `SessionAccess` / 事件订阅 / `pendingPrompts`），`PiBridge` 持 `slots: Map<槽键, SessionSlot>` + `focusedKey`。**`PiBridge.sessionFor(key?)` 是会话解析的唯一入口**（不传 = 焦点槽；也接受 sessionId / 会话文件路径，见 `findSessionSlot`）。`getSession()` 已删除，新代码禁止再引入隐式「当前会话」。
- 两条公理：**① 存在 ≠ 焦点**——切焦点不销毁旧槽，后台槽继续跑完当前轮（`runFocusOperation` 不中止任何槽；只有 `runSessionOperation`（fork / navigateTree / 导出临时切换）会中止焦点槽）。**② 同一会话文件只能有一个槽**——SDK `SessionManager` 的 `_rewriteFile` 用 `"w"` 截断重写，两个 AgentSession 写同一文件会互相覆盖（槽查重见 `findSlotBySessionFile`）。
- 后台槽的事件**不推渲染进程**：焦点门闩在 `createSlot()` 的 `sendEvent` 闭包里（`focusedKey !== key` 直接 return）；侧栏靠 `pi:sessionSlots`（120ms 节流投影：running / unread / pendingApprovals / pendingAsks / queuedPrompts）与 `pi:getSessionSlots` 展示，切会话必须走 `openSessionInSlot` / `newSessionInSlot`（不要自己组合 runtime.switchSession）。
- 并发闸门：`PiBridge.MAX_RUNNING_SESSIONS = 3`，入口 `submitPrompt()`（`pi:prompt` 与 goal 首条 prompt 都走它），超限进 `slot.pendingPrompts`，`agent_end` 时 `drainPendingPrompts()` 放行；`abortSlot(key)` 可停后台会话（连排队一起清）。
- 控制器按槽实例化：`createSlotControllers(slot)` 注入该槽的 `SessionHost`（`current()` / `cwd()` / `sendSessionEvent()` / `setPlanMode()`）；`PiBridge` 上的 `goalController` / `planController` / `permissionController` / … 字段是**焦点槽镜像**（`focusSlot` 时重指），历史 IPC 调用点仍可用，但控制器内部一律走 `host`，异步回调用捕获的槽、禁止重新解析「当前会话」。测试用 `new PiBridge({ factories })` 注入替身（`SlotControllerFactories`）。
- 交互按会话路由：ask 工具用 `ctx.sessionManager.getSessionId()` 分键（`electron/tools/ask-tool.ts` 的 `pendingAsks`）；权限审批按请求 id 记槽（`permissionRequestSlots` + `resolvePermissionRequest`），切回会话时 `replayPending()` 重推；渲染端刷新会话状态后用 `pi:getPendingInteractions` **主动拉一次**（重推会在切换过程中被「焦点会话」过滤丢掉）。
- MCP 只有一份客户端集合（`mcpManager.currentCwd` 单值）：切焦点时按焦点项目重指（`mcpProjectCwd`）；**取舍**是后台会话在别的项目里调 MCP 工具会失败。
- 会话列表：`pi:listSessions` 返回「扫描结果 + 槽里已有但扫描不到的会话」（`PiBridge.mergeSessionList`，只补**已经有消息**的槽）；SDK 在首条 user/assistant 消息时才创建会话文件，所以新建会话在发出第一条消息时由渲染端 `bumpSessionVersion()` 立刻刷新列表。
- 渲染端：所有会话替换入口统一 `transitionSession()`（`src/hooks/loadSession.ts`）。`sessionId + sessionRevision` 标识会话实例（A→B→A 也产生新版本）；`sessionRevision` / `sessionLoadVersion` / `isSessionLoading` 仅为内存状态，不持久化为 UI 偏好。异步刷新结果用 `captureSessionGuard` 校验后再写 store。
- `PiBridge.dispose()` 为异步且幂等，必须 await；Monaco 文件读取/目录列表统一使用 `resolveProjectPath`（真实路径校验项目边界，禁止字符串前缀校验）。
- 会话槽生命周期日志走 app 日志通道的 `slots` phase（默认关闭）：`electron/pi-bridge.ts` 的 `logSlots()`，排查「后台会话为什么停了」时开日志（app 通道 + debug 级）即可。

**多会话并发的已知取舍（改这块前先读）**

- MCP 只有一份客户端集合（`mcpProjectCwd` 单值）：后台会话在**非焦点项目**里调 MCP 工具会失败；终端 / 浏览器 / 统计 / 日志等非会话级能力是进程单例，天然共享。
- 同一会话文件只能有一个槽（`findSlotBySessionFile` / `findSessionSlot`）：SDK `SessionManager` 的 `_rewriteFile` 用 `"w"` 截断重写，两个 AgentSession 写同一文件会互相覆盖。
- **文件写入无锁**：同项目两个会话可以同时改同一文件 / 跑 git 命令，只有 `resolveProjectPath` 的项目边界校验，没有文件级互斥（产品取舍，UI 也未提示）。
- 记忆是「读-改-写 + 乐观版本校验」（`electron/memory/persistence.ts` 的 `commitMemoryChanges` 比对 `revisionOf(readRaw(file))`）：并发时后者抛「记忆版本冲突」并干净放弃（不写坏文件），需重试；`~/.pi-desktop/memory/` 的 `state.json` / `tombstones.json` / 管道文件是全局单份、**无跨进程锁** → 两个 Pi Desktop 实例（即使 user-data-dir 不同，配置目录相同）会互相覆盖。
- 并发闸门只拦 `submitPrompt()`：goal 的 `agent_end` 续跑走 SDK 内部 `agent.continue()`，不受 `MAX_RUNNING_SESSIONS` 限制，多个 goal 会话可同时跑。
- 后台槽不推事件 ⇒ 在途流式文本要等下一个 delta（~30ms）才出现在界面上（`src/lib/streaming-message.ts` 仍是模块级单槽，按会话分键未做）。
- `pi:exportSessionHtml` 对未加载的旧会话走 SDK `exportFromFile`：免切换但导出页不含 systemPrompt / tools 附录段（只有 `exportSessionToHtml` 有，而它没从包根导出）。

### 流式渲染

- 流式消息：`src/lib/streaming-message.ts` 模块级单槽 + `useStreamingMessage()`（rAF 合帧、`startTransition` 提交、清空时同步提交），**不要放回 store**。
- 流式 Markdown：`src/components/common/Markdown.tsx` 的 `streaming` prop → `src/utils/markdown-blocks.ts` 的 `splitMarkdownBlocks()` 按「安全块边界」分块，已闭合块的解析结果进模块级缓存（`RENDER_CACHE`），最后一块跳过 hljs 高亮。切点规则是**宁可不切、不可切错**：只切「紧跟空白行 + 顶格 + 不是列表标记 / 引用 / 表格 / 分隔线 + 不在围栅内部」；内容含参考式链接定义（文档级作用域）时退化为整篇解析。
- `marked` 的 `MarkedOptions` 用 `Omit` 排除了 `renderer`：自定义 renderer 只能 `new Marked()` 实例 + `use({ renderer })`，不能 `marked.parse(src, { renderer })`。
- 长会话渲染：ChatStream 拆成 `MessageList` / `StreamingTail` / `ChatItemView` / `ChatTurnView` 四层 memo；改这些组件时记住「订阅面 ≫ 渲染面」是卡顿根因——禁止 `usePiStore()` 全量订阅，多字段用 `useShallow`，模块级常量替代内联对象/空数组（内联会废掉 memo）。

### IPC API 三层约定

1. 主进程 `ipcMain.handle("pi:xxx", ...)` 注册（`pi-bridge.ts`）
2. `preload.ts` 通过 `contextBridge.exposeInMainWorld("pi", ...)` 暴露
3. `src/types/pi.d.ts` 声明类型，renderer 经 `window.pi.xxx()` 调用

- 新增 IPC 必须三处同步更新

### 模型供应商体系

- **内置供应商**：SDK 自带 ~38 个（anthropic/openai/google/deepseek/xai/mistral/groq 等），`ModelRuntime` 启动自动加载，只需配 API Key 即可用其内置模型清单，无需手填模型 ID
  - 配 Key：`window.pi.setProviderApiKey(providerId, key)` → `modelRuntime.setRuntimeApiKey`
  - 清 Key：`window.pi.removeProviderApiKey(providerId)`
  - 状态查询：`window.pi.getBuiltinProviders()` 返回每个 provider 的鉴权状态/模型数
  - 编辑回填：`window.pi.getProviderApiKey(providerId)` 读取 auth.json 中 `type: 'api_key'` 的凭证（`electron/provider-config.ts` 的 `readBuiltinApiKey`）供「编辑」表单回填；**只读 auth.json、不做环境变量兜底**（环境变量来源已由列表徽标标明，回填 env 值会诱使用户原样保存把它写进 auth.json），oauth 凭证也一律不回填（避免把 access token 当 API Key 覆盖保存）。`auth.json` 被 `pi:readFile` 的 `isSecretInConfigDir` 拒绝读取，renderer 要读凭证只能走这类专用 IPC，不要放开通用文件读
- **自定义 provider**：设置页手填 key/名称/baseUrl/api 协议/apiKey 写入 `models.json`；模型列表可手动添加，或填好 baseUrl 后点「从 /v1/models 拉取」按钮自动拉取 OpenAI 兼容端点的模型列表（api 为 anthropic-messages 时可勾选 Bearer 认证 `authHeader`，适配 OpenAI 兼容代理转发）
- **模型预设**：新增/编辑自定义模型时可从「模型预设」下拉选择，或按模型 ID 自动匹配建议（≥ 2 字符），一键带出上下文窗口/视觉/推理/价格/思考等级，带出后仍可手改；「从 /v1/models 拉取」与编辑面板的「按 ID 应用预设」也会按内置目录补齐参数
  - 数据源：SDK 内置模型目录（`ctx.modelRuntime.getProviders()` + `getModels(providerId)`，离线无鉴权，随 SDK 升级更新），**不是** models.dev 在线拉取；构建在 `electron/model-presets.ts`（1563 条 → 去重后 1103 条、~340KB），IPC `pi:getModelPresets` 全进程缓存一次，`pi:refreshProviders` 后作废
  - 去重规则：规范化 id（小写 + 去 `vendor/` 前缀）+ 上下文窗口 + 最大输出 相同者只留 provider 优先级最高的一条（openai/anthropic/google > openrouter > azure/bedrock 等镜像）
  - 匹配与字段映射在 `src/lib/model-presets.ts`（纯函数，模块级缓存索引）：只写基础字段 + `thinkingLevelMap` + `cost`，**不写 compat/api**（内置条目的 api 协议与用户自定义端点无关）
  - 长列表下拉用 `Dropdown` 的 `maxVisibleOptions`（只截断渲染、过滤仍在全量选项上做）
- 模型选择器（`src/components/chat/ModelSelector.tsx`）显示 `getAvailable()` 返回的**已鉴权可用**模型

## 功能模块地图

新增功能前先看这张表定位落点（主进程实现 / IPC / 渲染进程 / 设置页 tab）：

| 功能 | 主进程 | IPC handler | 渲染进程 | 设置页 |
|---|---|---|---|---|
| 会话/分支/导出/会话槽 | `electron/session-slot.ts`、`electron/pi-bridge.ts`（槽容器）、`electron/ipc/session-ipc.ts`、`electron/session-access.ts` | `session-ipc.ts` | `src/components/session/**` | — |
| 模型与供应商 | `electron/provider-config.ts`、`electron/model-presets.ts` | `model-ipc.ts` | `settings/ModelsTab.tsx`、`chat/ModelSelector.tsx` | 模型配置 |
| 决策模型 | `electron/classifier-config.ts`、`electron/classifier/` | `classifier-ipc.ts` | `settings/ClassifierTab.tsx` | 决策模型 |
| 权限沙箱 | `electron/permission/` | `permission-ipc.ts` | `chat/PermissionApprovalPanel.tsx` | 智能体配置 |
| Goal / Plan | `electron/goal/`、`electron/plan/` | `goal-ipc.ts`、`plan-ipc.ts` | `components/goal/**`、`components/plan/**` | — |
| 子 agent | `electron/subagents/` | `subagent-ipc.ts` | `components/subagents/**` | — |
| 后台任务 | `electron/background-tasks/` | `background-task-ipc.ts` | `components/background-tasks/**` | — |
| 记忆 | `electron/memory/` | `memory-ipc.ts` | `settings/MemoryTab.tsx` | 记忆系统 |
| 钩子 | `electron/hooks/` | `hook-ipc.ts` | `settings/HooksTab.tsx` | 钩子 |
| MCP | `electron/mcp/` | `mcp-ipc.ts` | `settings/McpTab.tsx` | MCP 服务器 |
| 内置浏览器 | `electron/browser/` | `browser-ipc.ts` | `workspace/BrowserContent.tsx` | 浏览器 |
| 终端 | `electron/ipc/terminal-ipc.ts` | `terminal-ipc.ts` | `components/terminal/**` | 界面（字体/shell） |
| 技能 | `electron/ipc/skill-ipc.ts` | `skill-ipc.ts` | `settings/SkillsTab.tsx` | Skill 管理 |
| 统计 / 日志 | `electron/statistics/`、`electron/logs/` | `statistics-ipc.ts`、`logs-ipc.ts` | `settings/StatisticsTab.tsx`、`settings/LogsTab.tsx` | 数据统计 / 日志 |
| git-ai 溯源 | `electron/git-ai/` | `git-ai-ipc.ts` | `settings/GitAiSection.tsx` | 智能体配置 |
| git 分支 | `electron/ipc/git-ipc.ts` | `git-ipc.ts` | `GitBranchButton.tsx` | — |
| UI 偏好 | `electron/ipc/settings-ipc.ts` | `settings-ipc.ts` | 各处 | 界面 |
| 文件与外部应用 | `electron/project-path.ts`、`electron/external-apps.ts` | `misc-ipc.ts` | `components/code/**` | — |
| 注入模型的自定义工具 | `electron/tools/` | —（随会话注入） | 各面板 | — |

## 设置页结构与新增配置项

### 设置页（`src/components/SettingsPage.tsx`）

全屏浮层（`fixed inset-0 z-50`，必须让开标题栏 drag 区），左栏 tab 导航 + 右栏内容；11 个 tab 组件都在 `src/components/settings/`：

`界面 AppearanceTab` / `模型配置 ModelsTab` / `决策模型 ClassifierTab` / `智能体配置 AgentTab` / `浏览器 BrowserTab` / `记忆系统 MemoryTab` / `钩子 HooksTab` / `Skill 管理 SkillsTab` / `MCP 服务器 McpTab` / `数据统计 StatisticsTab` / `日志 LogsTab`

`AgentTab.tsx` 由若干 `XxxSection` 组成（默认模型 / 待发送消息 / 图片识别 / 权限沙箱 / 全局自定义指令 / 上下文压缩 / git-ai 改动溯源），**新增分区就在 `AgentTab()` 里挂一个 `<XxxSection />`**。分区外壳照抄现有写法：

- 标题块：`<div className="mb-2"><h3 className="text-xs font-semibold text-od-text">{t.x}</h3><div className="text-xs text-od-text-dim">{t.xDesc}</div></div>`
- 卡片：`<div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">`，行用 `flex items-center justify-between gap-3`
- 公共组件在 `src/components/common/`：`Switch`（`{checked,onChange,ariaLabel,disabled}`）、`Dropdown`（`options[{value,label,hint?}]`）、`Radio`、`Checkbox`、`JsonEditor`；提交成功后 `showToast(t.xSaved, { variant: 'success' })`，失败 toast error，保存中显示 `<Icon name="spinner" spin />`

### 新增配置项的两种落点

1. **UI 偏好**（外观类，只有渲染进程用）→ `~/.pi-desktop/ui-config.json`，必须同步 `src/store/pi-store.ts` 五处 + `src/types/pi.d.ts`（详见「重要注意事项」）
2. **域配置**（功能行为，主进程也要读）→ 独立 JSON 文件，**不要塞进 ui-config.json**。范式照抄 `electron/git-ai/config.ts` / `electron/memory/config.ts`：
   - `getXConfigPath()`：`process.env.PI_X_CONFIG || path.join(DESKTOP_AGENT_DIR, 'x.json')`（env 可重定向，便于测试）
   - `interface XConfig` + `DEFAULT_X_CONFIG` + `normalizeXConfig(value)`（容错，坏值回退默认）+ `readXConfig()`（try/catch 回退默认）+ `writeXConfig(patch)`（`pick(patch, Object.keys(DEFAULT))` 白名单 + 写 `.tmp` + `renameSync` 原子替换 + 重新读出返回）
   - IPC：`electron/ipc/x-ipc.ts` 的 `registerXIpc()`，set 返回 `{ ok: true, config }` / `{ ok: false, error }`；在 `electron/pi-bridge.ts` 的注册链里加一行；`preload.ts` 暴露；`src/types/pi.d.ts` 声明接口
   - 设置页分区 + `src/i18n/zh.ts` 文案 + `tests/<域>/config.test.ts`（归一化/容错/往返）
   - 主进程侧**每次使用前读一次配置**（如 git-ai 扩展在事件回调里读），这样设置页改动即时生效、无需重启

## 编码约定

### 通用

- TypeScript 严格模式，禁用 `any` 除非对接 SDK 动态结构（如 tree 节点 entry union）
- 改动多文件时，单个 `edit` 调用里用多个 `edits[]` 处理同文件多处修改
- 改完必须 `npx tsc -b` 验证

### 样式

- 用 Tailwind class，颜色用 `od-*` 色板（`text-od-text-bright`、`bg-od-bg-alt` 等），不要硬编码 hex
- **禁用任意值固定字号类名**（如 `text-[10px]`、`text-[11px]`）：设置页提供全局字号调节（改写 `html { font-size }`，rem 基准），固定 px 字号不随设置缩放，会导致 UI 尺度不一致。一律用 Tailwind 字号阶梯（`text-xs`、`text-sm` 等，均为 rem 单位）；确需更小字号时用 `text-[0.7rem]` 这类 rem 任意值
- 弹窗避开 macOS 标题栏（38px）/其他平台（32px）：`fixed inset-0` 容器加 `paddingTop` + `flex flex-col`，子元素 `flex-1 min-h-0`。**这不只是视觉约定**：标题栏是 40px 的 `-webkit-app-region: drag` 区，落在带内的可点控件会被吞掉点击、光标也不显示小手（详见「重要注意事项」末条）

### 图标

- **严禁使用任何 emoji（包括系统 emoji、Unicode 符号表情）**作为图标或视觉标记，无论功能场景还是装饰场景。所有需要图标的地方必须使用 FontAwesome 图标(软件logo类除外)。
- **不要自己绘制 SVG**（手写 path、内联自定义 SVG）。优先使用 FontAwesome 图标，从 `@fortawesome/free-solid-svg-icons` 导入。
- 统一通过 `src/components/common/Icon.tsx` + `src/components/common/icons.ts` 使用，从 `@fortawesome/free-solid-svg-icons` 导入并注册到 `icons` 映射。
- 新增图标先在 `icons.ts` 注册 `IconName`，再用 `<Icon name="xxx" />` 引用，不要内联 emoji 字符。
- 若需在非 React 上下文（如 `dangerouslySetInnerHTML` 后的 DOM 操作）中使用图标，可取 FontAwesome 图标的官方 SVG path 数据（`faXxx.icon[4]`）构造 `<svg>`，不要自行编写 path。

### 文案

- 所有用户可见文案走 `src/i18n/zh.ts` 的 `t` 对象，函数式文案用工厂（如 `t.retrying(attempt, max)`）
- 新增功能同步补充文案

### 会话树（`src/components/session/TreeView.tsx`）

- 节点 preview 必须覆盖所有 `SessionEntry` 类型（message/compaction/branch_summary/model_change/thinking_level_change/label/session_info/custom 等），不能回退显示 `entry.id` 的 hash
- 工具调用格式化对齐 pi TUI 风格：`[bash: ls -la]` / `[read: ~/src/foo.ts]` / `[edit: path]`
- 每个节点显示：类型图标（FontAwesome）+ 类型标签（user/assistant/bash/...）+ 正文
- 构建 `toolCallMap`（toolCallId → {name, arguments}）用于 toolResult 节点反查

## 环境与平台

- 开发环境假设为 macOS（titleBarStyle: "hiddenInset"，带红绿灯），但代码需兼容 Windows/Linux
- 平台判断：`window.pi.platform === "darwin"`
- Node 版本：v24（参考当前 nvm 路径）
- 窗口：1400×900（最小 900×600）；mac `hiddenInset` + `vibrancy: under-window`，Windows `acrylic`，非 mac 用 `titleBarOverlay` + 自绘 `TitleMenuBar`；单实例锁 + 运行中退出确认
- 打包目标：mac `dmg`（`identity: null`，未签名未公证，`minimumSystemVersion: 13.0`）/ win `nsis` + portable x64 / linux `AppImage`；`electronLanguages` 仅 `zh-CN`/`en-US`
- `index.html` 里有防闪屏的内联主题脚本，会读 `localStorage` 里的主题变量（这是唯一允许读写 localStorage 的场景，UI 配置一律走 ui-config.json）

## 开发流程备忘

1. 启动：`npm run dev`，日志在 `/tmp/piui-dev.log`（后台运行时）
2. renderer（`src/**`）改动走 HMR；改 `src/types/pi.d.ts` 只是一次 page reload。**主进程（`electron/**`、`preload.ts`）改动会触发 vite-plugin-electron 重建，旧 Electron 被 SIGTERM 后不会自动重启**（重建开始时会清空 `dist-electron/`，构建失败则整个 `npm run dev` 直接退出）——改完主进程必须手动重启 dev。dev 在跑时**不要**跑 `npm run build`：它改写 `dist-electron/`，会被 watcher 当成变更，同样把实例杀掉
   - 反例：`npx tsc -b`（输出到 `node_modules/.tmp/`）、`npm run lint`、`npx vitest run`、`git status`、`git commit` 都不会触发重建，dev 实例可以一直在跑
   - **注意「只改 renderer」不等于安全**：只要文件同时也在主进程/预加载的模块图里，改它就会触发主进程重建。已知两处：`src/i18n/zh.ts`（被 `electron/pi-bridge.ts`、`electron/ipc/session-ipc.ts`、`electron/subagents/controller.ts` 等大量引用）与 `src/types/{shared,session,usage-statistics}.ts`（被 `preload.ts` 引用）。改这几个文件后要手动重启 dev
3. dev server 易退出，重启前先 `pgrep -f "piui.*vite|electron"` 检查，或 `lsof -ti :5173`
4. 停止：关闭 Electron 窗口或 `kill <pid>`

## 重要注意事项

- **`highlight.js` 的 `highlightAuto` 必须限定候选语言子集**：不给第二参数时它会拿全部 ~190 种语言逐个试。实测（对全量历史会话跑一遍）431 个代码块里只有 10 个没有语言标注，却占掉 86% 的高亮耗时——最坏一个 239 字符的目录树 187ms、一个 14 字符的中文片段 27ms；限定成 `src/components/common/Markdown.tsx` 里的 `AUTO_LANGS` 子集后总耗时 281ms → 32ms（省 89%，未命中的按纯文本渲染）。同时超过 `MAX_HIGHLIGHT_CHARS`（30k 字符）的块不做高亮。

- **需要 SDK 未从包根导出的 API 时，用 vite alias + wrapper 打进 bundle**：SDK 的 `exports` 地图只开放 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，深路径 import（如 `dist/core/export-html/index.js` 的 `exportFromFile`）会被 exports 校验拒绍（构建期即报错）。做法见 `electron/sdk-export-html.ts` + `vite.config.ts` 主进程块的 `resolve.alias['@pi-export-html']`：alias 指到 dist 里的真实文件，随主进程一起 bundle（打包后不依赖运行时动态 import）。**`tsconfig.json` 的 `paths` 也要加同名映射，且不能带 `.js` 扩展名**（带了 TS 只解析到 `.js`、找不到同名 `.d.ts`，报 TS7016）。这类模块若在运行时读盘（如导出用的 `dist/core/export-html/template.*`），`asarUnpack` 必须覆盖那些文件。

- **多会话与流式渲染的约定见「会话槽与多会话后台运行」「流式渲染」两节**：隐式当前会话已删除（一律用 `sessionFor` / `SessionHost`）、流式消息不要放回 store、切会话必须走 `openSessionInSlot` / `newSessionInSlot`（`runFocusOperation`，不中止后台会话）。

- **系统提示词里的 pi-desktop 说明**：`resources/docs/pi-desktop-system-prompt.md`（打包后 `process.resourcesPath/docs/`）由 `electron/pi-bridge.ts` 的 `getDesktopPromptAddendum()` 读出，经 `resourceLoaderOptions.appendSystemPromptOverride: (base) => [...base, 文本]` 注入，渲染进 SDK 提示词的 `<addendum>` 段（顺序：preamble/tools/rules/docs/addendum/skills/cwd）。**不要改用 `appendSystemPrompt`**：显式传它会让 SDK 跳过对用户 `~/.pi-desktop/APPEND_SYSTEM.md` 与项目 `.pi-desktop/APPEND_SYSTEM.md` 的发现（等于把用户自己的追加段整体顶掉，且 `resolvePromptInput` 会把不存在的路径当字面文本塞进提示词）；override 只追加、不改写用户文件。回归测试：`tests/prompt/desktop-prompt.test.ts`
- **每个会话建槽/换会话后必须调 `session.bindExtensions()`**（`electron/pi-bridge.ts` 的 `bindSessionExtensions`，两个调用点：`setRebindSession` 回调 + 初始创建后；`createAgentSessionRuntime` 初始建会话不会回调 `rebindSession`）：SDK 只在 `bindExtensions()` 里 emit `session_start`（TUI / print / RPC 这些官方入口都会调），不调则**所有内联扩展的 `session_start` 处理器静默不执行**——后台任务完成通知回灌模型（`electron/background-tasks/extension.ts` 的投递通道只在 `session_start` 里 `bindSession`）、hooks 的 SessionStart、memory 快照冻结等全会失效（用户现象：bg_run 完成后模型收不到提醒，只剩系统通知）。传 `onError` 不只是记日志：`AgentSession.reload()` 只在宿主绑定过 uiContext / commandContextActions / shutdownHandler / onError 之一时才重发 `session_start(reason:'reload')`，而本宿主只绑了 onError，少了它用户点「重新加载会话」（`electron/ipc/misc-ipc.ts` 的 `pi:reloadSession`）后扩展实例是新建的、投递通道再也绑不上。每个 session 实例只能调一次（bindExtensions 每次都会重发 session_start）。回归测试：`tests/session/pi-bridge.test.ts`
- **`PI_PACKAGE_DIR` ↔ `asarUnpack` 清单的耦合（改打包配置必看）**：打包版 `electron/main.ts` 把 `PI_PACKAGE_DIR` 指向 `app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent`，使 `getReadmePath()/getDocsPath()/getExamplesPath()`（提示词 `<docs>` 段）与 `getExportTemplateDir()`（HTML 导出，`electron/ipc/session-ipc.ts` 在用）落在**真实文件**上——SDK 的 `grep`/`find` 工具 spawn 的是真实进程（rg/fd），`bash` 同理，**读不了 asar 内文件**。因此 `package.json` 的 `asarUnpack` 必须覆盖 `getPackageDir()` 的全部消费者：`docs/**`、`examples/**`、`README.md`、`CHANGELOG.md`、`package.json`、`dist/core/export-html/**`、`dist/modes/interactive/theme/**`。SDK 升级若新增 `getPackageDir()` 消费者（如 `getInteractiveAssetPath`），需同步该清单；`main.ts` 有 `package.json` 存在性回退检查，缺失时会退回 asar 内路径（只读工具仍可用，shell 工具不可）
- **`files` 负规则无法用后置正规则撤回**：electron-builder 对 node_modules 只收集 `!` 开头的模式（`getNodeModuleFileMatcher` 会 prepend `**/*`，正规则被忽略），且 `minimatchAll` 是「命中后只再测排除项」——被 `!**/node_modules/**/{docs,examples}/**`、`!**/node_modules/**/*.{md,ts,tsx...}`、`!.../{README,CHANGELOG}*` 排除掉的 SDK `docs/examples/README.md` 只能靠 `files` 的**对象形式**（`{from,to,filter}`，走独立 matcher）单独复制回原路径；追加正规则或只加 `asarUnpack` 都无效（asarUnpack 只能解包已进入文件集合的文件）。**对象条目的 `from` 必须是目录**：`AppFileWalker` 用 `builder-util.walk(from)` 遍历，`from` 写成单个文件时 `filter` 会被自动 prepend 成 `**/*` 而 walk 一个文件返回空 → 静默复制不到（README.md / CHANGELOG.md 踩过此坑，改用 `from` = 包目录 + `filter: ["README.md","CHANGELOG.md"]` 才生效）。**唯一例外是「不带 `from` 的对象条目」**：`getNodeModuleFileMatcher` 的 `addPatterns` 对 `fileSet.from == null || fileSet.from === '.'` 会把 `filter` 逐条当模式加进 node_modules matcher（**不筛 `!` 前缀**），而 `minimatchAll` 在负规则命中后会重新测试正规则 —— 所以理论上补一条排在负规则之后的 `{ "filter": ["**/node_modules/**/{LICENSE,LICENCE}.{md,markdown,MD}"] }` 能把被 `!**/node_modules/**/*.{md,...}` 排除掉的 `LICENSE.md` 收回包里（仅用 electron-builder 26.15.3 的 `Minimatch` 单测过该顺序语义：正规则在负规则之前 = EXCLUDE，之后 = INCLUDE；未做端到端打包验证）。**这条没有采用**：`LICENSE.md` 类文件的覆盖改由 `npm run notices` 生成的清单承担（见下一条），不要再往 `files` 里加这条规则
- **依赖的许可文本必须随包分发（改动 `files` 负规则前必看）**：`!**/node_modules/**/{CHANGELOG,CHANGES,HISTORY,NOTICE,README,readme}*` 里**故意不含 `LICENSE` / `LICENCE`** —— MIT / Apache-2.0 / BSD 都要求分发时保留版权与许可声明，去掉这两个词后依赖包根的 LICENSE / LICENSE.txt / LICENCE 才进包（实测 962 个包中 857 个有包根许可文件；剩下的是只有 `LICENSE.md` 的（56 个，被 `*.{md,...}` 排除）和包根根本没有许可文件的（49 个，多数只在 `package.json` 的 `license` 字段里声明）；没有包带 `NOTICE` 文件，故该负规则保留 `NOTICE` 不影响合规）。
  - 这两个洞由 `npm run notices`（`scripts/generate-third-party-notices.mjs`）堵上：把**整棵依赖树的许可原文**（含 `.md` / `COPYING` / 无后缀等全部形态）汇总成 `resources/THIRD-PARTY-NOTICES.txt`（实测约 2.3 MB），经 `extraResources` 落到安装目录 `resourcesPath` 根部（`process.resourcesPath/THIRD-PARTY-NOTICES.txt`）—— 不依赖 node_modules 里的文件在打包后是否还在（asar / 负规则都拦不住它）。没有许可文件的包（如 `@earendil-works/pi-*` 全系列）在清单第 2 部分列出并带 `package.json` 的 `author` 与 SPDX 链接，第 3 部分附上「同许可证其他包随附的原文」并标注来源包（**不手写 / 不臆造许可文本**；树里确实没有对应文本时只给 SPDX 链接）。产物是生成物，已进 `.gitignore`，`electron:build*` 前自动重跑；依赖没装好时（缺目录过半 / 没有 node_modules）脚本直接失败，不会静默写出一份声称“共 0 个包”的假清单。纯函数与端到端行为由 `tests/packaging/third-party-notices.test.ts` 覆盖（临时目录搭假依赖树跑真 CLI）
  - `extraResources` 的对象条目走的是 `copyFiles`（`getExtraFileMatchers` → `copyFiles` 的 `fromStat.isFile()` 直接拷文件），**与 `files` 的 `AppFileWalker` 不同**——`files` 里的对象条目 `from` 必须是目录（否则静默拷不到），而 `extraResources` 里 `from` 写成单个文件是合法且推荐的（本项目的许可清单就是这么放的）
- **不要从记忆回答 pi SDK 的 API 细节**：SDK 版本可能滞后，查 `pi-worker-docs` 或直接读 `node_modules/@earendil-works/pi-coding-agent/dist/` 下的 `.d.ts`
- **配置目录必须保持 `~/.pi-desktop`**：`electron/config-dir.ts` 在模块加载时设置 `PI_CODING_AGENT_DIR` 环境变量（SDK 内部 getAgentDir/getSessionsDir 等默认路径的来源），它必须是 `main.ts` 的第一个 import。SDK 关键路径也显式传参（双保险）：`ModelRuntime.create({authPath, modelsPath})`、`SessionManager.create(cwd, getSessionDir(cwd))`、`createAgentSessionServices({agentDir})`。注意 `SessionManager.listAll()` 不传参，走 SDK 默认 getSessionsDir()（已被 env var 重定向）。新增 SDK 调用时优先显式传参，避免静默落回 `~/.pi/agent`
- **UI 偏好持久化走 `~/.pi-desktop/ui-config.json`**（`pi:getUiSettings` / `pi:setUiSettings` IPC），严禁再往 localStorage 写 UI 配置
- **新增 UI 偏好字段必须多处同步**（漏一处即出隐蔽 bug）：`src/store/pi-store.ts` 五处（`PiState` 字段 + action 类型声明、`UiSettings` 接口、`normalizeUiSettings` 校验、`initialPreferences` 默认值、action 实现）、`src/types/pi.d.ts` 的 `UiSettings` 第二份接口声明、设置页组件 + `src/i18n/zh.ts` 文案。**漏掉 `normalizeUiSettings` 校验会静默丢弃磁盘值、每次启动回退默认值**（布尔字段加 `typeof value === 'boolean'` 分支）。`preload.ts` / `electron/ipc/settings-ipc.ts` 通用透传，无需改动
- **严禁使用 emoji 作为图标**：所有图标一律用 FontAwesome（经 `src/components/common/icons.ts` 注册），不要在代码里出现 emoji 字符
- **`agent_end.messages` 不是完整历史**：只允许增量合并；完整加载必须使用绑定会话版本的消息快照分页。
- **全屏浮层必须让开标题栏的 drag 区，否则顶部 40px 内的控件静默失效**：标题栏（`src/App.tsx` 里 `WebkitAppRegion: 'drag'` 的 40px 条）是 `-webkit-app-region: drag` 区域，而 **drag 区域会吞掉所有指针事件**（Electron 官方文档：与 drag 区重叠的按钮不触发 click / mouseenter，光标也不走 CSS），表现为「控件点不动 + 光标显示为系统箭头」，不报错也极难排查。两条修法二选一：① `fixed inset-0` 容器加 `paddingTop: darwin ? 38 : 32`，把内容压到带下方（`src/components/SettingsPage.tsx`、`src/components/background-tasks/BackgroundTaskPanel.tsx`、`src/components/subagents/SubagentRunDetailModal.tsx` 用的是这个）；② 浮层根节点加 `style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}`，把整层矩形从 drag 区里挖出来（`src/components/chat/ImageLightbox.tsx` 用的是这个；副作用是浮层打开期间无法拖动窗口，macOS 红绿灯不受影响）。**已验证：`no-drag` 是几何减法而非只管子元素，盖在 drag 区上方的更高 z-index 兄弟节点同样能把那块矩形挖掉**
- **新增 IPC 必须三处同步**：`pi-bridge.ts` handler + `preload.ts` 暴露 + `pi.d.ts` 类型
- **git-ai 是可选的外部依赖，路径解析禁用 `process.env.HOME`**：`electron/git-ai/extension.ts` 经 `resolveGitAiBin()`（`electron/git-ai/paths.ts`）按 设置页 `binPath` → `PI_DESKTOP_GIT_AI_BIN` → `os.homedir()/.git-ai/bin/git-ai(.exe)` → PATH 的顺序解析。Windows GUI 进程没有 `HOME` 环境变量（只有 `USERPROFILE`），用 `process.env.HOME` 会拼出 `undefined/.git-ai/bin/git-ai` 并静默 ENOENT（`docs/report.md` 记录过这个线上问题）。只有「本应可用」时（配置/环境变量显式指定，或默认安装位置存在）才 `console.warn` 一次，避免没装 git-ai 的用户被刷屏。扩展每次事件读一次 `~/.pi-desktop/git-ai.json`，所以设置页改动即时生效。回归测试：`tests/git-ai/*`
- **默认关闭的能力**：内置浏览器 `browserEnabled`、DevTools 捕获 `browserDevtoolsEnabled`（含任意 JS 执行与 CDP 抓包）、日志 `logConfig.enabled` 默认关；记忆、git-ai、通知默认开（通知默认仅失焦）。改默认值要同步 README 与设置页文案
- **`electron/sandbox-extension.ts` 是占位实现**，未接入 `pi-bridge.ts`，不要以为沙箱已经生效
- **统计扫描跑在 worker 线程**：`electron/statistics/usage-worker.ts` 是 `vite.config.ts` 里的额外构建入口，增删主进程入口时要同步 `vite.config.ts` 与打包 `files`/`asarUnpack`
- **SDK 补丁由 postinstall 施加**：`scripts/patch-pi-loader.js` 会改写 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`（幂等，写入 marker 注释）。升级 SDK 或重新 `npm install` 后会自动重打；若手工动过 SDK 文件或怀疑补丁丢失，重跑 `node scripts/patch-pi-loader.js`
- **文档同步**：新增用户可见功能时同步 `README.md` 的功能特性与本文件的「功能模块地图」；新增设置项时同步「设置页结构与新增配置项」
- Electron renderer 禁用 nodeIntegration，所有 Node 能力经 IPC 暴露，不要在 renderer 里 `require`
