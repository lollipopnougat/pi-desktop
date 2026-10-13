# Pi Desktop

基于 [pi agent SDK](https://github.com/earendil-works/pi-coding-agent) 构建的 Electron 桌面端 AI 编码助手：把 pi 的 agent 能力（工具调用、技能、子 agent、MCP、长任务）放进一个图形化工作台 —— 对话、会话树、代码 / diff 面板、内置终端与浏览器、多供应商模型管理。

- **配置目录完全独立**：使用 `~/.pi-desktop/`，与 pi CLI 的 `~/.pi/agent/` 互不影响，不做迁移
- **SDK 进程内集成**：主进程直接创建 pi 的 `AgentSession` / `ModelRuntime`，不依赖外部 `pi` 可执行文件
- **跨平台**：macOS（主目标）、Windows、Linux

## 功能特性

### 对话与输入

- 流式输出、Markdown 渲染（highlight.js 语法高亮）、思考块折叠、工具调用卡片（展开查看参数与结果，一键在面板打开文件 / diff）
- 连续工具活动自动折叠成组；消息操作栏（复制 / 从此处分叉 / 时间戳）
- 输入框：自动增高、图片粘贴 / 拖拽 / 上传、文本文件追加、`@文件` `$技能` `/命令` 提及补全、模式切换（标准 / Plan / Goal）、权限策略与模型选择、上下文占用圆环
- 待发送队列：steer / followUp 分区，拖拽排序、跨区切换、撤回回输入框
- 用户消息书签栏：按比例定位、悬停预览、点击跳转
- 交互面板：`ask` 提问、权限审批（含危险命令标记与决策模型判定）、Plan 审批、TODO 面板与悬浮进度胶囊

### 会话管理

- 按项目分组的会话列表：搜索、排序、重命名、复制、删除、导出，右键菜单操作
- 全屏会话树：覆盖所有 entry 类型（消息 / 工具 / 分支摘要 / 压缩 / 模型切换 / 计划 / 目标 / 子 agent / 自定义），支持选中导航、分叉、摘要
- 分叉（按 entry 或按时间点）、跨项目会话全文搜索
- 会话属性弹窗（系统提示词 / 工具 / 技能 / MCP）与项目属性弹窗（项目级技能 / MCP）
- 导出 JSONL 与 HTML（HTML 由 SDK 模板渲染成可分享的单文件报告）

### 模型与供应商

- 内置供应商 42 个（Anthropic / OpenAI / Google / DeepSeek / xAI / Mistral / Groq / Bedrock / Vertex / OpenRouter 等），填入 API Key 即用其内置模型清单
- 自定义 OpenAI 兼容 / Anthropic Messages 供应商，可从 `/v1/models` 拉取模型列表
- 模型预设：按模型 ID 自动带出上下文窗口、最大输出、价格、视觉 / 推理能力与思考等级（数据来自 SDK 内置目录，离线可用）
- 思考等级切换、默认模型设置、可搜索的模型选择器

### 上下文与压缩

- 上下文占用圆环 + 明细弹窗（按角色拆分 token、近期消息估算）
- 手动压缩、自动压缩开关、`reserveTokens` / `keepRecentTokens` 配置
- 全局自定义指令（`~/.pi-desktop/AGENTS.md`）

### 长任务：Goal / Plan / TODO

- **Goal 模式**：带 token 预算的长期目标，agent 自主推进直至完成或受阻，可暂停 / 恢复 / 编辑 / 清除，状态条展示预算消耗
- **Plan 模式**：只读探索 → `propose_plan` → 审批面板逐条批注（评论 / 删除）+ 全局备注 → 批准后执行
- **TODO 面板**：分阶段任务清单（待办 / 进行中 / 已完成 / 已放弃）与悬浮进度胶囊

### 子 Agent 与后台任务

- 子 agent 委派（扁平 / 批量 / 异步），可查看运行状态、当前工具、轮次与 token 消耗，支持停止与引导
- 运行详情弹窗：对话 / 结果 / 工具调用三个视图，运行中实时刷新，结束后可回放子会话
- 内置 4 个 agent 定义（generalist / reviewer / scout / worker），支持用户级（`~/.pi-desktop/agents/`）与项目级（`<cwd>/.pi-desktop/agents/`）自定义
- 后台任务：`bg_run` 启动长命令，面板查看状态 / 时长 / 输出字节 / 退出码，可停止与删除；完成通知会自动唤醒 agent 继续处理

### 代码工作区

- 右侧工作区：代码 tab + 浏览器 tab 统一管理，读取 / 编辑自动路由到文件或 diff，可拖拽宽度与最大化
- Monaco 编辑器：文件树（懒加载、过滤）、面包屑（可展开目录树）、Markdown 源码 / 预览切换、用外部应用打开
- Diff 查看器：从 unified patch 重建原文 / 修改后，双栏对比
- **内置浏览器**：WebContentsView 标签页，地址栏与导航控制；agent 通过内置 `pi-browser` MCP 工具操作页面（打开 / 导航 / 点击 / 输入 / 截图 / 网络与控制台捕获，默认关闭）

### 终端

- node-pty + xterm.js 底部面板：多标签、新建 / 关闭 / 清屏、高度拖拽
- Shell 自动探测（Windows 优先 PowerShell）、字体 / 字号 / 主题跟随设置

### MCP / 技能 / 钩子

- **MCP**：stdio / HTTP / SSE 三种传输，全局（`~/.pi-desktop/mcp.json`）与项目（`<cwd>/.mcp.json`）两级配置，连接状态与工具列表可视化，可设置自动连接；agent 通过单个 `mcp` 代理工具按需连接调用
- **技能**：内置 / 用户 / 项目 / 插件 / 临时五种来源，启用禁用、编辑、删除、从目录或 zip 导入，支持禁用模型自动调用
- **钩子**：18 个 SDK 事件（输入 / 智能体 / 工具 / 会话 / 供应商），执行 shell 命令，可阻断或改写输入

### 记忆系统

- 跨会话长期记忆：`USER.md` / `MEMORY.md` / `LESSONS.md` / `STANDING.md` + 项目记忆
- 自动 / 审核 / 显式三种写入策略，提取与合并流水线，候选审核、历史回滚与旧数据迁移

### 权限与安全

- 四种审批策略：全部询问 / 自动放行安全操作（默认）/ 决策模型判定 / 全部放行
- 安全工具与 Bash 命令白名单、危险命令检测、按会话放行、异常时失败即拒绝
- 决策模型（classifier）：自定义端点、注册表管理、试跑面板（可改状态 / 问题 JSON 并查看判定概率），可为自动审批提供置信度阈值
- renderer 禁用 `nodeIntegration`，所有 Node 能力经 IPC 暴露；项目文件读取以真实路径校验边界，凭证文件禁止通用读取

### Git 与改动溯源

- 分支显示与切换（聊天区与状态栏）
- **git-ai 改动溯源**：把 edit / write / bash 的 checkpoint 上报给 `git-ai`，使 `git-ai log` / `blame` 能区分 AI 与人工改动；设置页可开关、指定二进制路径、限定上报范围（全部 / 仅文件 / 仅 shell）

### 视觉能力

- `read_img` 工具：当前模型不支持图片输入时，用设置页指定的视觉模型"看图"，结果回填给主模型

### 统计与日志

- **用量统计**：按日期区间 / 模型统计 token、缓存命中率与成本，趋势图、模型占比、逐模型明细表（worker 线程扫描会话 JSONL，可取消）
- **日志**：按通道（classifier / model / tools / permission / app）开关、级别、保留天数，JSONL 落盘并可预览与清理（默认关闭，不阻塞主流程）

### 界面与个性化

- 10 套主题族（Atom One / VS Code Modern / GitHub / JetBrains / Monokai / Material / Night Owl / Solarized / Xcode / Claude）× 系统 / 深色 / 浅色
- 全局字号（rem 基准）、界面字体、面板宽度、聊天区显示项（书签 / 思考块 / 工具折叠）
- Monaco：54 套社区主题 + 内置主题，字体 / 字号 / 行高 / Tab 宽度 / 连字 / 换行 / 小地图 / 行号 / 粘性滚动 / 缩进参考线，带实时预览
- 终端字体与字号；原生系统通知（总是 / 仅失焦 / 从不，可分别控制轮次完成与 ask 提问）
- 全中文界面，文案集中在 `src/i18n/zh.ts`

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Electron 44.5（macOS 使用 `hiddenInset` 标题栏 + vibrancy，Windows 使用 acrylic 材质） |
| 界面 | React 18.3 + TypeScript 5.9 |
| 构建 | Vite 6.4 + vite-plugin-electron |
| 状态 | Zustand 4.5（单一 store） |
| 样式 | Tailwind CSS 3.4 + @tailwindcss/typography（`od-*` CSS 变量色板） |
| 编辑器 | Monaco Editor 0.52 |
| 终端 | @xterm/xterm 6 + node-pty 1.1 |
| Markdown | marked 18 + DOMPurify + highlight.js 11 |
| Agent SDK | @earendil-works/pi-coding-agent 1.0.1（+ pi-ai 1.1.0） |
| MCP | @modelcontextprotocol/sdk 1.30 |
| 测试 | Vitest 4（77 个测试文件） |
| 打包 | electron-builder 26 |

## 快速开始

### 环境要求

- Node.js ≥ 20（推荐 v24）
- npm
- macOS 13+（构建 dmg）；Linux / Windows 亦可运行

### 安装与运行

```bash
npm install     # postinstall 会修复 node-pty 权限并为 pi SDK 打补丁
npm run dev     # 启动 Vite dev server + Electron 主进程（自动开窗口与 DevTools）
```

`postinstall` 做两件事：`scripts/fix-pty-perm.js` 给 node-pty 的 `spawn-helper` / `.node` 文件补执行权限；`scripts/patch-pi-loader.js` 修补 pi SDK 的扩展加载器（`dist/core/extensions/loader.js`），让打包后的 bundle 能正常解析扩展与 SDK 内部包（SDK 若存在嵌套依赖，会尝试在项目 `node_modules` 补软链，源不存在则跳过）。若 node-pty 缺少预编译产物，还需要本机 C++ 构建工具链（Xcode Command Line Tools / build-essential）。

### 打包

```bash
npm run electron:build          # 当前平台安装包：mac dmg / win nsis / linux AppImage
npm run electron:build:win      # Windows x64 便携版（portable）
npm run electron:build:win:dir  # Windows x64 免安装目录
```

打包产物在 `release/`。macOS 构建为**未签名**（`identity: null`），首次打开需右键「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"`；未签名状态下系统通知会走 AppleScript 兜底。

## 常用脚本

| 脚本 | 说明 |
|---|---|
| `npm run dev` | 开发模式（Vite + Electron，自动打开窗口与 DevTools） |
| `npm run build` | `tsc -b` 类型检查 + Vite 生产构建 |
| `npm run electron:build` | 生成图标 + 构建 + electron-builder 打包当前平台 |
| `npm run electron:build:win` / `:win:dir` | Windows x64 便携版 / 免安装目录 |
| `npm run icons` | 由 SVG 生成 `icon.png` / `.ico` / `.icns` |
| `npm run lint` / `lint:fix` | ESLint 检查 / 自动修复（应保持 0 error） |
| `npm run format` / `format:check` | Prettier 格式化 / 检查 |
| `npm test` / `test:watch` / `test:coverage` | Vitest 单次 / watch / 覆盖率 |
| `npx tsc -b` | 单独跑类型检查（无输出即通过） |

## 目录结构

```
piui/
├── electron/                     # Electron 主进程
│   ├── main.ts                   # 入口：窗口、菜单、单实例锁、退出确认
│   ├── config-dir.ts             # ~/.pi-desktop 配置目录（重定向 SDK 默认路径）
│   ├── pi-bridge.ts              # 核心：封装 AgentSession/ModelRuntime，注册全部 IPC
│   ├── provider-config.ts        # 内置/自定义供应商与凭证读写
│   ├── model-presets.ts          # 由 SDK 目录构建的模型预设索引
│   ├── ipc/                      # 按功能拆分的 IPC handler（20 个注册器）
│   ├── goal/ plan/ subagents/    # 长任务：目标、计划、子 agent
│   ├── background-tasks/         # 后台任务（bg_run）
│   ├── memory/ hooks/ mcp/       # 记忆系统、生命周期钩子、MCP 客户端
│   ├── permission/ classifier/   # 权限沙箱与决策模型
│   ├── browser/                  # 内置浏览器 + pi-browser MCP 服务
│   ├── statistics/ logs/ git-ai/ # 用量统计（worker）、日志、改动溯源
│   └── tools/                    # 注入给模型的自定义工具（plan/ask/mcp/read_img）
├── preload.ts                    # contextBridge 暴露 window.pi.*
├── src/                          # 渲染进程（React）
│   ├── App.tsx                   # 布局 + 全局浮层 + 标题栏按钮
│   ├── components/
│   │   ├── chat/                 # 对话流、输入框、队列、工具卡片、各交互面板
│   │   ├── session/              # 会话侧栏、会话树、搜索、属性弹窗
│   │   ├── workspace/ code/      # 右侧工作区、Monaco、文件树、diff
│   │   ├── terminal/             # xterm 终端面板
│   │   ├── settings/             # 设置页 11 个 tab
│   │   ├── subagents/ background-tasks/ goal/ plan/
│   │   └── common/               # Icon / Dropdown / Toast / Markdown / 弹窗等
│   ├── hooks/                    # SDK 事件分发、会话加载、mention、Monaco
│   ├── lib/                      # Monaco 主题与选项、模型预设、会话中断门
│   ├── store/pi-store.ts         # 单一 Zustand store
│   ├── theme/                    # 10 套主题族 + 终端配色
│   ├── i18n/zh.ts                # 全部中文文案
│   └── types/pi.d.ts             # window.pi 类型声明
├── resources/                    # 随包发布的只读资源（skills / agents / terminal-themes / docs）
├── tests/                        # Vitest 测试（按领域分目录）
├── docs/                         # 设计文档（架构、Goal、记忆）
└── AGENTS.md                     # AI 助手在本仓库工作的上下文与约定
```

## 架构

三进程结构，IPC 是唯一的跨进程通信方式：

```
Electron 主进程 (electron/)
   ├── PiBridge 进程内创建 pi SDK 的 AgentSession / ModelRuntime
   └── ipcMain.handle("pi:*") 注册各功能 handler
        ↓ contextBridge（preload.ts）
预加载脚本
   └── 暴露 window.pi.* API
        ↓
渲染进程 (src/)
   └── React 应用，经 window.pi.* 调用，绝不直接 require electron
```

几个关键设计：

- **会话身份**：`sessionId + sessionRevision` 标识当前会话实例，A→B→A 也会产生新版本；异步结果写回前用 `captureSessionGuard` 校验，避免旧请求污染新会话
- **完整历史**：`agent_end` 事件只带本轮新增消息，UI 增量合并；重载完整历史走消息快照分页（`getMessageSnapshot` → `getMessages` → `releaseMessageSnapshot`），统一由 `src/hooks/loadSession.ts` 的 `transitionSession()` 管理
- **替换操作串行化**：会话切换 / 新建 / 分叉在主进程经 `runSessionOperation()` 串行执行，重建 runtime 前等待旧实例 abort 与 SDK 释放
- **新增 IPC 三处同步**：`electron/ipc/*.ts` handler + `preload.ts` 暴露 + `src/types/pi.d.ts` 类型

### 数据目录

所有配置与数据都在 `~/.pi-desktop/`（与 pi CLI 完全隔离）：

| 文件 / 目录 | 用途 |
|---|---|
| `ui-config.json` | UI 偏好（字号、面板宽度、主题、Monaco、终端、通知、浏览器开关等） |
| `settings.json` | SDK 配置（上下文压缩等） |
| `models.json` / `auth.json` | 自定义供应商配置 / 内置供应商凭证 |
| `classifiers.json` | 决策模型端点配置 |
| `mcp.json` / `mcp-cache.json` | MCP 服务器配置与缓存 |
| `hooks.json` | 生命周期钩子 |
| `git-ai.json` | git-ai 改动溯源（启用 / 路径 / 上报范围） |
| `memory/` | 长期记忆 Markdown 与项目记忆 |
| `logs/` | 分通道 JSONL 日志 |
| `sessions/` | 会话持久化（JSONL） |
| `skills/` `prompts/` `themes/` `agents/` | 用户级技能、Prompt 模板、主题、子 agent 定义 |
| `models-store.json` / `trust.json` | SDK 模型清单缓存 / 项目信任状态 |
| `AGENTS.md` | 全局自定义指令 |

项目级配置放在项目内：`<cwd>/.mcp.json`、`<cwd>/.pi-desktop/{skills,agents}`。

### 随包资源

源码在 `resources/`，打包时经 `extraResources` 复制到 `process.resourcesPath/`：

| 资源 | 内容 |
|---|---|
| `skills/` | 内置技能（`skill-creator`，含技能格式参考与校验脚本） |
| `agents/` | 内置子 agent 定义（generalist / reviewer / scout / worker） |
| `terminal-themes/` | 20 套终端配色 |
| `docs/` | `pi-desktop-system-prompt.md`（注入系统提示词）、`pi-desktop.md`（给模型的完整说明） |

## 开发

编码约定、模块地图与踩坑清单见 [AGENTS.md](./AGENTS.md)，要点：

- TypeScript 严格模式，禁用 `any`（对接 SDK 动态结构除外）；改动后跑 `npx tsc -b`
- 样式用 Tailwind `od-*` 色板，字号一律用 rem 阶梯（全局字号可调）
- 图标一律用 FontAwesome（`src/components/Icon.tsx` + `icons.ts` 注册），**禁止 emoji**
- 用户可见文案集中在 `src/i18n/zh.ts`
- 新增 IPC 三处同步；新增 UI 偏好字段需在 store / 类型 / 校验 / 默认值 / 设置页多处同步

### 测试

```bash
npm test                      # 全量（Vitest，node 环境）
npx vitest run tests/git-ai   # 只跑某个领域
npm run test:coverage         # 覆盖率
```

测试位于 `tests/`，按领域分目录：会话与生命周期、记忆流水线、子 agent、权限与决策模型、Goal / Plan 状态机、后台任务、浏览器、日志、统计、MCP 配置、git-ai、模型预设、聊天渲染辅助与纯工具函数等。

## 相关文档

- [AGENTS.md](./AGENTS.md) —— 本仓库的编码约定、模块地图与重要注意事项
- `docs/ARCH-PLAN.md` —— 整体架构设计（进程模型、技术选型、安全模型）
- `docs/GOAL-DESIGN.md` —— Goal 模式设计（预算、自动续跑、状态机）
- `docs/MEMORY-PLAN.md` —— 记忆系统设计（提取与合并流水线、注入策略）
- `resources/docs/pi-desktop.md` —— 面向模型的宿主环境说明（按需 read）

## 平台支持与已知限制

- **macOS** 为主目标平台（`hiddenInset` 标题栏 + vibrancy），Windows / Linux 可用但打磨程度较低
- macOS 安装包未签名、未公证；Windows 未签名；暂无自动更新
- 内置浏览器、DevTools 捕获（CDP 与任意 JS 执行）、日志默认关闭，需在设置页显式开启
- `electron/sandbox-extension.ts` 为占位实现，沙箱扩展尚未启用
- 界面仅中文（`src/i18n/zh.ts` 单语言表）

### 多会话并发（后台运行）的取舍

会话可以同时后台运行（默认最多 3 个在跑，超出的排队，侧栏用「运行中 / 有新内容 / 等待审批」徽标提示）。以下是已知边界：

- **MCP 服务器只服务当前前台项目**：后台会话若属于另一个项目，在其中调用 MCP 工具会失败（MCP 客户端集合只有一份，切前台时会重指到前台项目）。终端、内置浏览器、统计、日志等非会话级能力则是全进程共享。
- **同一项目的多个会话之间没有文件锁**：两个会话可以同时改同一个文件或同时跑 git 命令，结果是「后写覆盖」，桌面端不做拦截也不做提示，请自行避免。
- **记忆整理是串行 + 乐观版本校验**：多个会话同时触发记忆提取/合并时，后一个会以「记忆版本冲突」干净放弃（不会写坏文件），稍后重试即可。另外，记忆与状态文件在配置目录里是全局单份且没有跨进程锁——**同时开两个 Pi Desktop 实例会互相覆盖**。
- **Goal 模式的续跑不受「同时 3 个」限制**：带目标的会话会自主推进到完成或受阻，可能与其他会话并行运行。
- **后台会话的流式文字不会实时推到界面**：切回该会话时，正在生成的那段文字会在下一个增量（约 30ms）补齐。
- **导出没有加载过的旧会话**：不会切换会话、也不会中止当前轮，但导出页不含「系统提示词 / 工具」附录段（SDK 从文件导出时拿不到这两项）。

## License

本项目以 [MIT 协议](LICENSE) 开源，Copyright (c) 2026 lollipopnougat。

### 第三方署名

- [pi agent SDK](https://github.com/earendil-works/pi-coding-agent)（`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`）：MIT
- [FontAwesome Free](https://fontawesome.com)（`free-solid-svg-icons` / `free-regular-svg-icons`）：图标为 CC BY 4.0、字体为 SIL OFL 1.1、代码为 MIT。本项目界面图标均来自 FontAwesome Free，版权归 Font Awesome 所有
- 其余依赖（Electron、React、Monaco Editor、xterm.js、node-pty、Tailwind CSS、highlight.js、marked、Zustand 等）为 MIT / Apache-2.0 / BSD / ISC 等宽松许可，完整依赖与许可清单见 `package-lock.json`
