import { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type AgentSessionEvent
} from '@earendil-works/pi-coding-agent';
import { registerSessionIpc } from './ipc/session-ipc';
import { registerStatisticsIpc } from './ipc/statistics-ipc';
import { registerModelIpc } from './ipc/model-ipc';
import { registerClassifierIpc } from './ipc/classifier-ipc';
import { applyClassifierProviders } from './classifier/registry';
import { registerSkillIpc } from './ipc/skill-ipc';
import { registerMiscIpc } from './ipc/misc-ipc';
import { registerTerminalIpc, killAllTerminals } from './ipc/terminal-ipc';
import { registerMcpIpc } from './ipc/mcp-ipc';
import { registerGoalIpc } from './ipc/goal-ipc';
import { registerPlanIpc } from './ipc/plan-ipc';
import { registerSettingsIpc, readUiSettingsForMain } from './ipc/settings-ipc';
import { registerMemoryIpc } from './ipc/memory-ipc';
import { registerGitIpc } from './ipc/git-ipc';
import { registerGitAiIpc } from './ipc/git-ai-ipc';
import { registerPermissionIpc } from './ipc/permission-ipc';
import { registerSubagentIpc } from './ipc/subagent-ipc';
import { registerBackgroundTaskIpc } from './ipc/background-task-ipc';
import { registerHookIpc } from './ipc/hook-ipc';
import { registerBrowserIpc } from './ipc/browser-ipc';
import { registerLogsIpc } from './ipc/logs-ipc';
import { logAgentEvent } from './logs/agent-events';
import { logAppEvent } from './logs/channel-logs';
import { normalizeLogConfig, setLogConfig } from './logs/logger';
import { updatePlanTool, askTool, setAskNotifier, resolveAsk } from './tools';
import {
  readImgTool,
  setReadImgModelConfig,
  getReadImgModelConfig,
  setModelRuntimeAccessor,
  type ReadImgModelConfig
} from './tools';
import { mcpManager } from './mcp/manager';
import { mcpProxyTool } from './mcp/proxy-tool';
import { GoalController } from './goal/controller';
import { goalExtensionFactory } from './goal/extension';
import { PlanController } from './plan/controller';
import { planExtensionFactory } from './plan/extension';
import { MemoryController } from './memory/controller';
import { memoryExtensionFactory } from './memory/extension';
import { PermissionController } from './permission/controller';
import { DEFAULT_PERMISSION_POLICY } from './permission/policy';
import { SubagentController } from './subagents/controller';
import { subagentExtensionFactory } from './subagents/extension';
import { BackgroundTaskController } from './background-tasks/controller';
import { backgroundTaskExtensionFactory } from './background-tasks/extension';
import { hookExtensionFactory } from './hooks/extension';
import { gitAiExtensionFactory } from './git-ai/extension';
import { app } from 'electron';
import { getAgentDir, getSessionDir } from './provider-config';
import { BrowserController } from './browser/controller';
import { SessionAccess } from './session-access';
import { disposeRuntime } from './runtime-lifecycle';
import type { SessionIdentity } from '../src/types/session';
import { t } from '../src/i18n/zh';

// pi-desktop 独立配置目录 ~/.pi-desktop（不再与 pi CLI 共享 ~/.pi/agent）
// 所有 SDK 路径（models/auth/sessions/skills/settings 等）显式指向该目录。
const AGENT_DIR = getAgentDir();

/**
 * 内置技能目录：随安装包发布的只读技能（如 skill-creator）。
 * - 打包后：electron-builder extraResources 把 resources/skills 拷到 process.resourcesPath/skills
 * - 开发模式：使用项目源码目录 resources/skills
 * 通过 SDK 的 additionalSkillPaths 注入，不落入用户可写的 ~/.pi-desktop/skills，
 *   因此设置页的删除/写入操作对内置技能无效（前端据此隐藏删除按钮）。
 */
function getBuiltinSkillsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.resolve(__dirname, '..', 'resources', 'skills');
}

/**
 * 内置说明文档目录：随安装包发布的「pi-desktop 向模型说明」文档。
 * - 打包后：electron-builder extraResources 把 resources/docs 拷到 process.resourcesPath/docs
 * - 开发模式：使用项目源码目录 resources/docs
 * 其中 pi-desktop-system-prompt.md 注入系统提示词，pi-desktop.md 是完整说明（模型按需 read）。
 */
function getBuiltinDocsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'docs')
    : path.resolve(__dirname, '..', 'resources', 'docs');
}

/**
 * 系统提示词追加段：告诉模型它跑在 pi-desktop（GUI 宿主）里、有哪些 GUI 专有工具与约定。
 * 读不到资源文件时返回 null（静默跳过注入，不影响主流程）。
 */
function getDesktopPromptAddendum(): string | null {
  try {
    const docsDir = getBuiltinDocsDir();
    const promptFile = path.join(docsDir, 'pi-desktop-system-prompt.md');
    if (!fs.existsSync(promptFile)) return null;
    const body = fs.readFileSync(promptFile, 'utf8').trim();
    const guideFile = path.join(docsDir, 'pi-desktop.md');
    const guideLine = fs.existsSync(guideFile)
      ? `\n\n完整说明（架构、GUI 工具面、权限、路径约定）：${guideFile}`
      : '';
    return body + guideLine;
  } catch {
    return null;
  }
}

export class PiBridge {
  win: BrowserWindow | null = null;
  runtime: any = null;
  session: any = null;
  modelRuntime: ModelRuntime | null = null;
  cwd: string = '';
  agentDir: string = AGENT_DIR;
  /** 内置只读技能目录（随安装包发布），供 SkillContext 使用 */
  get builtinSkillsDir(): string {
    return getBuiltinSkillsDir();
  }
  goalController: GoalController | null = null;
  planController: PlanController | null = null;
  memoryController: MemoryController | null = null;
  subagentController: SubagentController | null = null;
  backgroundTaskController!: BackgroundTaskController;
  permissionController!: PermissionController;
  browserController!: BrowserController;
  private unsubscribe: (() => void) | null = null;
  private sessionManager: any = null;
  /** IPC handler 只注册一次，避免重开窗口时 'second handler' 报错 */
  private handlersRegistered = false;
  /** runtime 是否已初始化（首次启动），重开窗口时复用 */
  private runtimeReady = false;
  readonly sessionAccess = new SessionAccess();
  private disposePromise: Promise<void> | null = null;

  getSessionIdentity(): SessionIdentity {
    return { sessionId: this.getSession().sessionId, sessionRevision: this.sessionAccess.revision };
  }

  /** 所有会话级推送带同一身份；切换中的过渡状态由完成后的快照重建。 */
  sendSessionEvent(channel: string, payload: unknown): boolean {
    if (
      !this.session ||
      this.sessionAccess.changing ||
      !this.win ||
      this.win.isDestroyed() ||
      this.win.webContents.isDestroyed()
    )
      return false;
    this.win.webContents.send(channel, payload, this.getSessionIdentity());
    return true;
  }

  /** 所有替换入口共用一把锁，失败后仍可继续切换。 */
  runSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposePromise) return Promise.reject(new Error('Application is closing'));
    return this.sessionAccess.run(async () => {
      if (this.disposePromise) throw new Error('Application is closing');
      const previousCwd = this.cwd;
      const previousManager = this.session?.sessionManager;
      this.permissionController?.clearPending();
      resolveAsk(null);
      this.planController?.cancelPending({ approved: false, feedback: t.sessionSwitchCancelled });
      try {
        await Promise.allSettled([this.subagentController?.dispose(), this.session?.abort()]);
        return await operation();
      } catch (error) {
        // SDK 在创建新会话前已销毁旧 session。创建失败时用旧 manager 恢复会话，
        // 不把 disposed session 暴露给后续 IPC，也不让切换队列永久失效。
        if (!this.session) {
          this.runtime = null;
          try {
            await this.createRuntimeFor(previousCwd, previousManager);
          } catch (recoveryError) {
            console.error('Failed to recover session:', recoveryError);
          }
        }
        throw error;
      } finally {
        if (this.runtime && this.session) await this.syncSession();
      }
    });
  }

  async init(win: BrowserWindow, cwd: string) {
    this.win = win;
    if (!this.browserController) this.browserController = new BrowserController();
    this.browserController.attachWindow(win);
    // runtime 已就绪时（macOS 关窗后重开）：保留原项目 cwd，不要用 home 覆盖——
    // runtime/session 仍在原项目的会话上，覆盖会导致 getState/getCwd/git 探测全部失真
    if (!this.runtimeReady) {
      this.cwd = cwd;
    }

    fs.mkdirSync(path.join(AGENT_DIR, 'sessions'), { recursive: true });

    // 首次启动才创建 ModelRuntime / runtime；macOS 关窗后重开时复用已有实例
    if (!this.runtimeReady) {
      // 显式指定 auth/models 路径，确保配置落在 ~/.pi-desktop（models-store.json 跟随 modelsPath 所在目录）
      this.modelRuntime = await ModelRuntime.create({
        authPath: path.join(AGENT_DIR, 'auth.json'),
        modelsPath: path.join(AGENT_DIR, 'models.json')
      });

      // 自定义决策模型（~/.pi-desktop/classifiers.json）注册进 runtime。
      // 必须在 ModelRuntime.create 之后：registerProvider 是 runtime 实例方法。
      // SDK 的 models.json schema 不支持 classifier（无 type 字段/无 classifiers），
      // 所以决策模型走独立配置文件 + 直接调用公开的 ModelRuntime.registerProvider。
      try {
        const classifierResult = applyClassifierProviders(this.modelRuntime);
        if (classifierResult.applied.length > 0) {
          console.log('[pi-bridge] 已注册决策模型 provider:', classifierResult.applied.join(', '));
        }
        for (const err of classifierResult.errors) {
          console.warn(`[pi-bridge] 决策模型 provider 「${err.key}」注册失败: ${err.message}`);
        }
      } catch (err) {
        console.warn('[pi-bridge] 决策模型 provider 注册异常:', err);
      }

      // Goal/Plan/Memory controller 需在 createRuntimeFor 之前创建(extensionFactories 引用)
      if (!this.goalController) this.goalController = new GoalController(this);
      if (!this.planController) this.planController = new PlanController(this);
      if (!this.memoryController) this.memoryController = new MemoryController(this);
      if (!this.subagentController) this.subagentController = new SubagentController(this);
      if (!this.permissionController) this.permissionController = new PermissionController(this);
      if (!this.backgroundTaskController) {
        this.backgroundTaskController = new BackgroundTaskController(this);
        await this.backgroundTaskController.initialize();
      }

      // 权限策略从 ui-config.json 恢复（主进程侧权威副本，渲染进程 store 另行恢复）
      try {
        const ui = readUiSettingsForMain();
        this.permissionController.restorePolicy(ui.permissionPolicy ?? DEFAULT_PERMISSION_POLICY);
        this.permissionController.restoreAutoSafeConfig(ui.permissionAutoSafeConfig);
        // classifier-auto 决策模型配置（providerId/modelId/超时/置信度阈值）
        this.permissionController.restoreClassifierConfig(ui.permissionClassifierConfig);
        // read_img 图片识别模型配置恢复
        setReadImgModelConfig(this.normalizeReadImgConfig(ui.readImgModel));
        // 日志配置（总开关 / 等级 / 各功能开关 / 保留天数），必须在任何 logEvent 之前生效
        setLogConfig(normalizeLogConfig(ui.logConfig));
        await this.browserController.setEnabled(ui.browserEnabled === true);
        await this.browserController.setDevtoolsEnabled(ui.browserDevtoolsEnabled === true);
      } catch {}

      // read_img 工具的 modelRuntime 访问器（懒取，避免初始化顺序问题）
      setModelRuntimeAccessor(() => this.modelRuntime);

      // 启动记录：日志开关已就绪（上面 setLogConfig 之后），版本/路径写一行方便对齐时间线
      logAppEvent({
        phase: 'start',
        version: app.getVersion(),
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        node: process.versions.node ?? null,
        platform: `${process.platform} ${process.arch}`,
        packaged: app.isPackaged,
        pid: process.pid,
        cwd,
        agentDir: AGENT_DIR
      });

      await this.createRuntimeFor(cwd);
      this.runtimeReady = true;
    } else {
      // runtime 已存在，只需把新窗口绑定回去并重订阅事件
      this.rebind();
      // 窗口重开时重置 MCP cwd 为当前 cwd（home），避免残留上一个项目的 currentCwd
      mcpManager.setCwd(this.cwd);
    }
  }

  /** 重开窗口时仅解绑窗口引用，不要销毁 runtime，避免下次 init 重建 */
  detachWindow() {
    this.browserController?.detachWindow();
    this.win = null;
  }

  /**
   * 当前会话是否有一轮正在执行（关窗/退出确认用）。
   * 用主进程侧 session 的真实状态，而不是渲染进程可能滞后的 isStreaming。
   */
  isSessionRunning(): boolean {
    try {
      return this.session?.isStreaming === true;
    } catch {
      return false;
    }
  }

  /**
   * 中止当前回合并等待其落盘（abort 内部 waitForIdle 后才返回）。
   * 退出前调用：否则在途的部分回复会随进程消失，而不像切换会话那样被持久化。
   */
  async abortSession(): Promise<void> {
    try {
      if (!this.session) return;
      await this.session.abort();
    } catch {
      // 中止失败不阻断退出
    }
  }

  /** (Re)create the AgentSessionRuntime for a given cwd. */
  async createRuntimeFor(cwd: string, sessionManager?: SessionManager) {
    // shutdown 扩展仍需访问旧 session，必须等它结束后再切换 cwd/controller。
    if (this.runtime) await this.releaseRuntime();
    // 切换项目前断开所有 MCP 服务器，避免同名服务器复用旧会话
    await mcpManager.disconnectAll();
    this.cwd = cwd;
    // 会话目录显式指向 ~/.pi-desktop/sessions/<encoded-cwd>/，避免 SDK 默认落回 ~/.pi/agent
    this.sessionManager = sessionManager ?? SessionManager.create(cwd, getSessionDir(cwd));

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: rtCwd,
      sessionManager: rtSm,
      sessionStartEvent
    }) => {
      const services = await createAgentSessionServices({
        cwd: rtCwd,
        // 复用主进程已创建的统一 ModelRuntime（避免 services 内部再建一个实例，
        // 否则 setProviderApiKey 只作用于 ctx.modelRuntime，而 AgentSession.setModel
        // 的 checkAuth 走另一个实例的陈旧 auth.json 缓存，导致 “No API key” 且重启后才恢复）
        modelRuntime: this.modelRuntime!,
        // agentDir 驱动 SDK 内部 skills/prompts/themes/settings/trust 等路径
        agentDir: AGENT_DIR,
        // pi-desktop 是 GUI 宿主，不加载 pi CLI 的扩展（extensions）。
        // 扩展是给 TUI 模式的 pi CLI 设计的，其 handler（如 pi-rewind 的
        // message_start checkpoint）在 pi-desktop 环境下会卡死 agent 循环。
        // skills/prompts/themes 是纯数据资源，保留加载（pi-desktop 有对应 UI）。
        // 注意:noExtensions 只关闭用户/CLI 扩展;goal 内联扩展经 extensionFactories
        // 注入,始终加载(见 SDK resource-loader.js:loadExtensionFactories 无条件调用)。
        resourceLoaderOptions: {
          noExtensions: true,
          // pi-desktop 自身说明：SDK 会把它渲染进 <addendum> 段
          // （完整段序：preamble/tools/rules/docs/addendum/project_context/skills/cwd，
          //  各扩展在 before_agent_start 里继续往后追加）。宿主环境认知由它提供。
          // 用 appendSystemPromptOverride 而非 appendSystemPrompt：显式传 appendSystemPrompt 会让
          // SDK 跳过对用户 APPEND_SYSTEM.md / 项目 .pi-desktop/APPEND_SYSTEM.md 的发现
          // （等于把用户自己的追加段整体顶掉）；override 只是在 base 之后追加，既不破坏发现也不改写用户文件。
          appendSystemPromptOverride: (base: string[]) => {
            const addendum = getDesktopPromptAddendum();
            return addendum ? [...base, addendum] : base;
          },
          // 内置只读技能（skill-creator 等），随安装包发布，经 additionalSkillPaths 注入。
          // 不放入用户可写的 ~/.pi-desktop/skills，避免被设置页删除。
          additionalSkillPaths: (() => {
            const paths = [getBuiltinSkillsDir()];
            // 项目级技能：用 <cwd>/.pi-desktop/skills 而非 SDK 默认的 <cwd>/.pi/skills，
            // 保持与 pi-desktop 的配置目录命名一致。.agents/skills 已由 SDK 自动加载。
            const projSkillDir = path.join(rtCwd, '.pi-desktop', 'skills');
            if (fs.existsSync(projSkillDir)) paths.push(projSkillDir);
            return paths;
          })(),
          // 屏蔽 SDK 默认加载的 <cwd>/.pi/skills：pi-desktop 项目级技能改用 .pi-desktop/skills。
          skillsOverride: (base) => {
            const piSkillsDir = path.resolve(rtCwd, '.pi', 'skills') + path.sep;
            const filtered = base.skills.filter(
              (s) => !path.resolve(s.filePath).startsWith(piSkillsDir)
            );
            return { skills: filtered, diagnostics: base.diagnostics };
          },
          extensionFactories: [
            goalExtensionFactory(this.goalController!),
            planExtensionFactory(this.planController!),
            memoryExtensionFactory(this.memoryController!),
            subagentExtensionFactory(this.subagentController!),
            backgroundTaskExtensionFactory(this.backgroundTaskController),
            // 用户生命周期钩子（~/.pi-desktop/hooks.json）：PreToolUse/PostToolUse/SessionStart/Stop
            hookExtensionFactory(),
            // git-ai 改动溯源：edit/write/bash 的 checkpoint 上报（git-ai log/blame 归属 AI 改动）
            gitAiExtensionFactory()
          ]
        }
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: rtSm,
          sessionStartEvent,
          customTools: [updatePlanTool, askTool, mcpProxyTool, readImgTool]
        })),
        services,
        diagnostics: services.diagnostics
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: AGENT_DIR,
      sessionManager: this.sessionManager
    });

    this.runtime.setBeforeSessionInvalidate(() => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.session = null;
    });
    this.runtime.setRebindSession(async () => {
      this.session = this.runtime.session;
    });

    this.session = this.runtime.session;
    this.rebind();
    // read_img 工具可见性：按当前模型是否支持视觉注入/移除
    this.syncReadImgTool();
    // 权限闸门：链式包装 agent.beforeToolCall（切换 cwd 重建 runtime 后重新安装）
    this.permissionController.install(this.session);
    // 切换会话前若有挂起审批，按拒绝结算
    this.permissionController.clearPending();
    // Goal/Plan/Memory 模式:从 session 恢复状态(controller 已在 init/createRuntimeFor 入口创建)
    this.goalController?.onSessionSwitch();
    this.planController?.onSessionSwitch();
    this.memoryController?.onSessionSwitch();
    this.subagentController?.onSessionSwitch();
    // MCP：设置当前 cwd 以便 loadMcpConfig 合并项目级 <cwd>/.mcp.json；
    // 会话创建时按配置决定是否自动连接服务器（懒加载默认不开）
    mcpManager.setCwd(cwd);
    await mcpManager.onSessionCreate().catch(() => {});
    this.runtimeReady = true;
  }

  /** runtime 切换 session 后同步 this.session 并 rebind 事件订阅 */
  async syncSession() {
    const nextCwd = this.runtime.cwd;
    if (nextCwd !== this.cwd) {
      await mcpManager.disconnectAll();
      this.cwd = nextCwd;
      mcpManager.setCwd(nextCwd);
      await mcpManager.onSessionCreate().catch(() => {});
    }
    this.session = this.runtime.session;
    this.rebind();
    // read_img：会话切换后按新会话模型重新同步可见性
    this.syncReadImgTool();
    // 权限闸门：新 session 对象需重新安装（WeakSet 防重复包装）
    this.permissionController.install(this.session);
    this.permissionController.clearPending();
    // 会话切换后恢复 goal/plan/memory 状态(session_start 扩展钩子也会调,这里作幂等保底)
    this.goalController?.onSessionSwitch();
    this.planController?.onSessionSwitch();
    this.memoryController?.onSessionSwitch();
    this.subagentController?.onSessionSwitch();
  }

  private rebind() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (!this.session) return;
    const session = this.session;
    const identity = this.getSessionIdentity();
    this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      // 日志先记：与窗口状态无关（窗口关掉后仍能落盘）
      logAgentEvent(event);
      if (this.session !== session || this.sessionAccess.changing) return;
      if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
      this.win.webContents.send('pi:event', { ...event, ...identity });
    });
    // ask 工具：工具 execute 发起提问时，转发给渲染进程展示 UI
    setAskNotifier((questions) => {
      if (!this.sendSessionEvent('pi:askUser', questions)) resolveAsk(null);
    });
  }

  getSession() {
    if (!this.session) throw new Error('Session not initialized');
    return this.session;
  }

  /**
   * 切换 plan 模式:委托给 PlanController 的阶段状态机。
   * 工具裁剪 + 阶段切换由 controller 管;plan 提示词注入改走 before_agent_start
   * 扩展钩子(避免旧实现被 SDK 每轮 refresh 覆盖,导致 plan 指令到不了模型)。
   */
  setPlanMode(enabled: boolean) {
    if (enabled) {
      this.planController?.enterPlanning();
    } else {
      this.planController?.exitToIdle();
    }
    // 退出 plan 后同步 goal 工具可见性(无 active goal 时移除 goal_complete/goal_blocked)
    if (!enabled) {
      this.goalController?.refreshGoalToolVisibility();
    }
  }

  /**
   * read_img：归一化设置页保存的视觉模型配置（非法/不完整 → null = 不启用）
   */
  normalizeReadImgConfig(v: unknown): ReadImgModelConfig | null {
    if (!v || typeof v !== 'object') return null;
    const c = v as { provider?: unknown; modelId?: unknown };
    if (typeof c.provider !== 'string' || typeof c.modelId !== 'string') return null;
    if (!c.provider || !c.modelId) return null;
    return { provider: c.provider, modelId: c.modelId };
  }

  /**
   * read_img：按当前模型是否支持视觉同步工具可见性。
   * - 未配置视觉模型 → 移除（任何情况不提供）
   * - 当前模型支持视觉（input 含 'image'）→ 移除（agent 直接可看图）
   * - 当前模型不支持视觉且已配置 → 注入
   * 在 createRuntimeFor 后与 pi:setModel 时调用。
   */
  syncReadImgTool(): void {
    try {
      const session = this.session;
      if (!session?.setActiveToolsByName) return;
      const config = getReadImgModelConfig();
      const model = session.model ?? session.agent?.state?.model;
      const currentSupportsVision = Array.isArray(model?.input) && model.input.includes('image');
      const shouldHave = !!config && !currentSupportsVision;

      const active: string[] = session.getActiveToolNames();
      const has = active.includes('read_img');
      if (shouldHave && !has) {
        session.setActiveToolsByName([...active, 'read_img']);
      } else if (!shouldHave && has) {
        session.setActiveToolsByName(active.filter((n) => n !== 'read_img'));
      }
    } catch {
      // 同步失败不阻塞会话（read_img 仅是能力增强）
    }
  }

  /**
   * 设置页更新 read_img 视觉模型配置（立即生效）：更新工具内配置并同步可见性
   */
  setReadImgModel(provider: string | null, modelId: string | null): void {
    const config = provider && modelId ? { provider, modelId } : null;
    setReadImgModelConfig(this.normalizeReadImgConfig(config));
    this.syncReadImgTool();
  }

  registerHandlers() {
    if (this.handlersRegistered) return;
    registerSessionIpc(this);
    registerModelIpc(this);
    registerClassifierIpc(this);
    registerSkillIpc(this);
    registerMiscIpc(this);
    registerTerminalIpc(this);
    registerMcpIpc(this);
    registerGoalIpc(this);
    registerPlanIpc(this);
    registerSettingsIpc(this);
    registerStatisticsIpc();
    registerMemoryIpc(this);
    registerGitIpc(this);
    registerGitAiIpc();
    registerPermissionIpc(this);
    registerSubagentIpc(this);
    registerBackgroundTaskIpc(this);
    registerHookIpc(this);
    registerBrowserIpc(this.browserController);
    registerLogsIpc();
    this.handlersRegistered = true;
  }

  private async releaseRuntime(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.permissionController?.clearPending();
    resolveAsk(null);
    this.planController?.cancelPending({ approved: false, feedback: t.sessionSwitchCancelled });
    try {
      const childrenStopped = this.subagentController?.dispose();
      try {
        await disposeRuntime(runtime);
      } finally {
        await childrenStopped;
      }
    } catch (error) {
      console.error('Failed to dispose runtime:', error);
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.session = null;
      this.runtime = null;
      this.runtimeReady = false;
    }
  }

  /** 等待 SDK shutdown 和所有异步清理；重复退出共享同一个 Promise。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.sessionAccess.run(async () => {
      try {
        await this.memoryController?.dispose();
      } catch (error) {
        console.error('Memory cleanup failed:', error);
      }
      await this.releaseRuntime();
      setAskNotifier(null);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => killAllTerminals()),
        Promise.resolve().then(() => this.subagentController?.dispose()),
        Promise.resolve().then(() => this.backgroundTaskController?.dispose()),
        Promise.resolve().then(() => this.browserController?.setEnabled(false))
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.error('Cleanup failed:', result.reason);
      }
      await mcpManager.disconnectAll();
    });
    return this.disposePromise;
  }
}
