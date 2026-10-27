import { ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  TERMINAL_THEME_FILE,
  TERMINAL_VARS_FALLBACK,
  parseITermTheme
} from '../../src/theme/terminalThemes';
import type { PiBridgeContext } from './types';
import { resolveAsk, saveImagesToTempFiles } from '../tools';
import { getAgentDir } from '../provider-config';
import { showSystemNotification } from '../notifications';
import { resolveReadablePath, isInsideProject } from '../project-path';
import { sameSession, type SessionIdentity } from '../../src/types/session';
import { detectExternalApps, openExternalApp } from '../external-apps';
import { removeQueuedAt, moveQueuedAt } from '../queued-messages';
import { openThirdPartyNoticesWindow } from '../third-party-notices';

/** 判断 skill 是否为内置只读技能（位于 builtinSkillsDir 之下，与 skill-ipc 同一判定） */
function isBuiltinSkill(builtinSkillsDir: string, skill: any): boolean {
  const root = path.resolve(builtinSkillsDir);
  const base = path.resolve(skill.baseDir);
  return base === root || base.startsWith(root + path.sep);
}

/**
 * 只读白名单里额外放行的技能目录：内置只读技能目录 + SkillLoader 实际报告的技能目录。
 * 技能文件不在项目目录内（~/.agents/skills、~/.pi-desktop/skills、内置目录），
 * 点击技能 chip 在代码面板打开时需要放行；写路径不受影响。
 */
function skillReadableRoots(ctx: MiscContext, session: any): string[] {
  const roots: string[] = [];
  try {
    if (ctx.builtinSkillsDir) roots.push(ctx.builtinSkillsDir);
  } catch {}
  try {
    const loader = session?.resourceLoader || session?.agent?.state?.resourceLoader;
    for (const s of loader?.getSkills?.()?.skills ?? []) {
      if (typeof s?.baseDir === 'string' && s.baseDir) roots.push(s.baseDir);
    }
  } catch {
    // loader 不可用（会话未就绪）：退回默认白名单（~/.pi-desktop、~/.agents）
  }
  return roots;
}

/** Misc IPC 需要的额外上下文 */
export interface MiscContext extends PiBridgeContext {
  readonly win: any;
  /** 重建 runtime（切换 cwd） */
  createRuntimeFor(cwd: string): Promise<void>;
  /** 内置只读技能目录（PiBridge getter）：会话属性面板据此标记 builtin */
  readonly builtinSkillsDir: string;
}

/**
 * 非视觉模型的图片降级处理（发送带图片消息时）：
 * pi-ai transform-messages 会把 image 块替换成无信息量占位符
 * "(image omitted: model does not support images)"，模型完全看不到图片。
 * 此处把图片落盘为临时文件，在文本末尾注入路径说明，并剥离 images
 * （反正发送也只会被降级为占位符，且部分供应商会直接报错）。
 * - 模型支持视觉：原样透传（image 块正常送达模型）
 * - 不支持视觉：文本注入路径提示（配合 read_img 工具使用）
 */
function normalizePromptImages(session: any, text: string, opts?: any): [string, any | undefined] {
  const images = opts?.images;
  if (!Array.isArray(images) || images.length === 0) {
    return [text, opts];
  }
  try {
    const model = session?.model ?? session?.agent?.state?.model;
    const supportsVision = Array.isArray(model?.input) && model.input.includes('image');
    if (supportsVision) {
      return [text, opts];
    }
    // 非视觉模型：落盘 + 注入路径提示 + 剥离 images
    const savedPaths = saveImagesToTempFiles(images);
    let nextText = text;
    if (savedPaths.length > 0) {
      const lines = savedPaths.map((p, i) => `  ${i + 1}. ${p}`);
      nextText =
        `${text}\n\n[用户随消息发送了 ${savedPaths.length} 张图片，已保存为以下文件：\n${lines.join('\n')}\n]` +
        `\n当前模型不支持直接查看图片；如需理解图片内容，请使用 read_img 工具识别上述文件。`;
    } else {
      // 落盘失败：至少告知模型图片存在（优于无声丢弃）
      nextText = `${text}\n\n[用户随消息发送了 ${images.length} 张图片，但当前模型不支持图片输入且保存失败。]`;
    }
    const { images: _stripped, ...restOpts } = opts ?? {};
    return [nextText, restOpts];
  } catch {
    return [text, opts]; // 处理异常不阻塞消息发送
  }
}

/**
 * 注册杂项 IPC：prompting / state / commands / compaction / sessionStats / file ops / cwd / dialog
 */
export function registerMiscIpc(ctx: MiscContext) {
  /**
   * 清空后重新入队（保持各队列内部的原顺序）。
   * 失败时队列已由 queue_update 事件同步，UI 会反映真实状态。
   */
  const reenqueuePending = async (
    session: {
      steer: (text: string) => Promise<unknown>;
      followUp: (text: string) => Promise<unknown>;
    },
    steering: string[],
    followUp: string[]
  ): Promise<void> => {
    try {
      for (const s of steering) await session.steer(s);
      for (const f of followUp) await session.followUp(f);
    } catch {
      /* 重新入队失败时队列已被事件同步，UI 会反映真实状态 */
    }
  };

  // === Prompting ===
  // 会话句柄在入口解析一次：一个请求只作用于它开始时的那个会话
  ipcMain.handle('pi:prompt', async (_e, text: string, opts?: any) => {
    const slot = ctx.sessionFor();
    const session = slot.requireSession();
    const [normalized, promptOpts] = normalizePromptImages(session, text, opts);
    return ctx.submitPrompt(normalized, promptOpts, slot.key);
  });
  ipcMain.handle('pi:steer', async (_e, text: string) => {
    await ctx.sessionFor().requireSession().steer(text);
  });
  ipcMain.handle('pi:followUp', async (_e, text: string) => {
    await ctx.sessionFor().requireSession().followUp(text);
  });
  // 可按会话键停止：侧栏能停后台会话，而不必先切过去（不传 = 焦点会话）
  ipcMain.handle('pi:abort', async (_e, sessionKey?: string | null) => {
    await ctx.abortSlot(sessionKey ?? null);
  });
  ipcMain.handle('pi:clearQueue', async () => {
    return ctx.sessionFor().requireSession().clearQueue();
  });

  // 撤回单条排队消息：clearQueue 后把其余消息按原顺序重新入队，返回被撤回的文本
  ipcMain.handle(
    'pi:revokeQueuedMessage',
    async (_e, kind: 'steering' | 'followUp', index: number) => {
      const session = ctx.sessionFor().requireSession();
      const { steering, followUp, removed } = removeQueuedAt(session.clearQueue(), kind, index);
      // 重新入队（保持顺序；steer/followUp 在 streaming 时入队，idle 时直接发送）
      await reenqueuePending(session, steering, followUp);
      return { ok: removed !== null, revoked: removed ?? '' };
    }
  );

  // 删除单条排队消息：与 revoke 同为「只摘掉一条」，差别只在调用方语义（删除 vs 撤回编辑）
  ipcMain.handle(
    'pi:removeQueuedMessage',
    async (_e, kind: 'steering' | 'followUp', index: number) => {
      const session = ctx.sessionFor().requireSession();
      const { steering, followUp, removed } = removeQueuedAt(session.clearQueue(), kind, index);
      await reenqueuePending(session, steering, followUp);
      return { ok: removed !== null, removed: removed ?? '' };
    }
  );

  // 同队列内拖拽排序：把第 from 条移到插入点 to（to 语义 = 插到第 to 条之前，to === length 即队尾）
  ipcMain.handle(
    'pi:reorderQueuedMessage',
    async (_e, kind: 'steering' | 'followUp', from: number, to: number) => {
      const session = ctx.sessionFor().requireSession();
      const { steering, followUp, moved } = moveQueuedAt(session.clearQueue(), kind, from, to);
      await reenqueuePending(session, steering, followUp);
      return { ok: moved !== null, moved: moved ?? '' };
    }
  );

  // 切换单条排队消息的投递方式（引导 ↔ 排队）：clearQueue 后把该条移入另一队列，其余按原顺序重新入队
  ipcMain.handle(
    'pi:switchQueuedMessage',
    async (_e, kind: 'steering' | 'followUp', index: number) => {
      const session = ctx.sessionFor().requireSession();
      const { steering, followUp } = session.clearQueue();
      const steerRest = [...steering];
      const followRest = [...followUp];
      const from = kind === 'steering' ? steerRest : followRest;
      const to = kind === 'steering' ? followRest : steerRest;
      // 索引失效（队列已被推进/清空）：原样恢复，不抛错
      if (index < 0 || index >= from.length) {
        await reenqueuePending(session, steerRest, followRest);
        return { ok: false };
      }
      // 移到目标队列末尾（两个队列之间不存在跨队列排序，追加即可）
      const [text] = from.splice(index, 1);
      to.push(text);
      await reenqueuePending(session, steerRest, followRest);
      return { ok: true, text };
    }
  );

  // === State ===
  ipcMain.handle('pi:getState', () => {
    const slot = ctx.sessionFor();
    return slot.access.read(() => {
      const s = slot.requireSession();
      // messages 传输量太大（含完整 tool result/bash output），启动时返回骨架避免 contextBridge 崩溃
      // 需要完整 messages 的调用方请用 pi:getMessages（按需主动拉）
      return {
        model: s.model,
        thinkingLevel: s.thinkingLevel,
        isStreaming: s.isStreaming,
        messages: [],
        sessionId: s.sessionId,
        sessionRevision: slot.identity().sessionRevision,
        sessionFile: s.sessionFile,
        sessionName: s.sessionName,
        cwd: ctx.cwd
      };
    });
  });

  // 分块拉取消息：避免一次性返回全部 messages 导致 contextBridge 崩溃
  // offset/limit 都按消息 index计
  ipcMain.handle('pi:getMessages', (_e, snapshotId: string, offset: number, limit: number) => {
    const slot = ctx.sessionFor();
    return slot.access.page(slot.identity(), snapshotId, offset, limit);
  });

  ipcMain.handle('pi:getMessageSnapshot', (_e, expected: SessionIdentity) => {
    // 按 renderer 指定的会话解析槽：拿到的不是它要的那个会话就直接拒掉
    const slot = ctx.sessionFor(expected.sessionId);
    const identity = slot.identity();
    if (!sameSession(identity, expected)) throw new Error('SESSION_CHANGED');
    return slot.access.capture(identity, slot.requireSession().messages ?? []);
  });
  ipcMain.handle('pi:releaseMessageSnapshot', (_e, snapshotId: string) => {
    ctx.sessionFor().access.release(snapshotId);
  });

  ipcMain.handle('pi:getCommands', async () => {
    const session = ctx.sessionFor().requireSession();
    const loader = session.resourceLoader || session.agent?.state?.resourceLoader;
    if (!loader) return [];
    const commands: any[] = [];
    try {
      const extResult = loader.getExtensions();
      if (extResult?.runtime) {
        const extCommands = extResult.runtime.getCommands?.() ?? [];
        for (const c of extCommands) {
          commands.push({ name: c.name, description: c.description || '', source: 'extension' });
        }
      }
    } catch {}
    try {
      const { prompts } = loader.getPrompts();
      for (const p of prompts) {
        commands.push({ name: p.name, description: p.description || '', source: 'prompt' });
      }
    } catch {}
    try {
      const { skills } = loader.getSkills();
      for (const s of skills) {
        commands.push({
          name: `skill:${s.name}`,
          description: s.description || '',
          source: 'skill'
        });
      }
    } catch {}
    return commands;
  });

  /** 当前会话属性：系统提示词 + 注入的工具 / skill / 命令等 */
  ipcMain.handle('pi:getSessionInfo', async () => {
    const session = ctx.sessionFor().requireSession();
    const loader = session.resourceLoader || session.agent?.state?.resourceLoader;
    let systemPrompt = '';
    const systemPromptSources: { path: string }[] = [];
    let skills: any[] = [];
    let prompts: any[] = [];
    let extCommands: any[] = [];
    try {
      systemPrompt = session.systemPrompt || '';
      const src = loader?.getSystemPromptSource?.();
      if (src?.path) systemPromptSources.push(src);
      for (const p of loader?.getAppendSystemPromptSources?.() ?? []) {
        if (p?.path) systemPromptSources.push(p);
      }
    } catch {}
    try {
      skills = (loader?.getSkills?.().skills ?? []).map((s: any) => ({
        name: s.name,
        description: s.description || '',
        filePath: s.filePath,
        baseDir: s.baseDir,
        scope: s.sourceInfo?.scope,
        origin: s.sourceInfo?.origin,
        disableModelInvocation: !!s.disableModelInvocation,
        // 内置技能：scope 会被 SDK 标为 temporary（additionalSkillPaths 注入），
        // 不标 builtin 的话会话属性面板会把 tag 展示成「临时」
        builtin: isBuiltinSkill(ctx.builtinSkillsDir, s)
      }));
    } catch {}
    try {
      prompts = (loader?.getPrompts?.().prompts ?? []).map((p: any) => ({
        name: p.name,
        description: p.description || '',
        argumentHint: p.argumentHint || '',
        filePath: p.filePath
      }));
    } catch {}
    try {
      const extResult = loader?.getExtensions?.();
      if (extResult?.runtime) {
        extCommands = (extResult.runtime.getCommands?.() ?? []).map((c: any) => ({
          name: c.name,
          description: c.description || ''
        }));
      }
    } catch {}

    // 注入的工具：全部注册工具 + 激活标记（未激活的折叠展示）
    let tools: any[] = [];
    try {
      const allTools = session.getAllTools?.() ?? [];
      const activeNames = new Set(session.getActiveToolNames?.() ?? []);
      tools = allTools.map((t: any) => ({
        name: t.name,
        label: t.label || '',
        description: t.description || '',
        promptSnippet: t.promptSnippet || '',
        promptGuidelines: t.promptGuidelines || [],
        active: activeNames.has(t.name),
        source: t.sourceInfo?.path || ''
      }));
    } catch {}

    return {
      systemPrompt,
      systemPromptSources,
      tools,
      skills,
      prompts,
      extCommands,
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      thinkingLevel: session.thinkingLevel,
      cwd: ctx.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      sessionName: session.sessionName
    };
  });

  ipcMain.handle('pi:getSessionStats', async () => {
    try {
      return await ctx.sessionFor().requireSession().getSessionStats();
    } catch {
      return null;
    }
  });

  // === Compaction ===
  const settingsPath = () => path.join(getAgentDir(), 'settings.json');

  interface CompactionFile {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  }

  const readSettingsFile = (): CompactionFile => {
    try {
      const raw = fs.readFileSync(settingsPath(), 'utf-8');
      return JSON.parse(raw).compaction ?? {};
    } catch {
      return {};
    }
  };

  const writeCompactionFile = (compaction: CompactionFile) => {
    const fullPath = settingsPath();
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch {
      /* 无则新建 */
    }
    const prevCompaction = (
      existing.compaction && typeof existing.compaction === 'object' ? existing.compaction : {}
    ) as Record<string, unknown>;
    const merged: Record<string, unknown> & { compaction: Record<string, unknown> } = {
      ...existing,
      compaction: { ...prevCompaction, ...(compaction as Record<string, unknown>) }
    };
    // 若为 undefined 字段则删掉该键，保持文件干净
    for (const k of Object.keys(compaction) as (keyof CompactionFile)[]) {
      if (compaction[k] === undefined) delete merged.compaction[k];
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const tmp = `${fullPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, fullPath);
  };

  ipcMain.handle('pi:compact', async (_e, instructions?: string) => {
    return await ctx.sessionFor().requireSession().compact(instructions);
  });

  // === 全局自定义指令（~/.pi-desktop/AGENTS.md） ===
  // SDK 在 session 创建时加载 agentDir 下的 AGENTS.md 作为全局 context 文件
  // （resource-loader loadProjectContextFiles 会优先加载 agentDir 的 AGENTS.md/CLAUDE.md），
  // 保存后需 reload 资源加载器才能在当前会话生效。
  const globalAgentsPath = () => path.join(getAgentDir(), 'AGENTS.md');

  ipcMain.handle('pi:getGlobalInstructions', async () => {
    try {
      return fs.readFileSync(globalAgentsPath(), 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('pi:setGlobalInstructions', async (_e, text: string) => {
    const p = globalAgentsPath();
    if (!text.trim()) {
      // 清空则删除文件，避免残留空 AGENTS.md 被 SDK 加载为空 context
      try {
        fs.unlinkSync(p);
      } catch {}
      return;
    }
    fs.writeFileSync(p, text, 'utf-8');
    // 重载资源：让当前会话的 context 文件立即生效（新建会话自然生效）
    const session = ctx.sessionFor().session;
    const loader = session?.resourceLoader || session?.agent?.state?.resourceLoader;
    await loader?.reload?.().catch?.(() => {});
  });

  ipcMain.handle('pi:getCompactionSettings', async () => {
    return readSettingsFile();
  });

  // === 系统通知 ===
  // 渲染进程在 agent_settled（对话轮次完成）/ pi:askUser（模型提问）时触发。
  // 设置存 ui-config.json（readNotifyConfig），是否弹出由主进程统一裁决（含窗口聚焦判断）。
  ipcMain.handle('pi:notify', (_e, kind: 'turnEnd' | 'ask', title: string, body: string) => {
    showSystemNotification(ctx.win, kind, title, body);
  });

  const reloadSettings = async () => {
    const sm = ctx.sessionFor().session?.settingsManager ?? ctx.runtime?.settingsManager;
    await sm?.reload?.().catch(() => {});
  };

  ipcMain.handle('pi:setCompactionEnabled', async (_e, enabled: boolean) => {
    const curr = readSettingsFile();
    writeCompactionFile({ ...curr, enabled });
    await reloadSettings();
  });

  ipcMain.handle(
    'pi:setCompactionTokens',
    async (_e, reserveTokens?: number, keepRecentTokens?: number) => {
      const curr = readSettingsFile();
      const next: CompactionFile = { ...curr };
      if (reserveTokens !== undefined) next.reserveTokens = reserveTokens;
      if (keepRecentTokens !== undefined) next.keepRecentTokens = keepRecentTokens;
      writeCompactionFile(next);
      await reloadSettings();
    }
  );

  ipcMain.handle('pi:setAutoCompaction', async (_e, enabled: boolean) => {
    const curr = readSettingsFile();
    writeCompactionFile({ ...curr, enabled });
    await reloadSettings();
  });

  // === Reload session ===
  // 对齐 pi CLI `/reload`：重载扩展/配置/系统提示词，重置 pending 状态
  ipcMain.handle('pi:reloadSession', async () => {
    const slot = ctx.sessionFor();
    await slot.requireSession().reload();
    // reload 会按「注即激活」重建扩展工具（task 会冒回来）：重新收一次可见性
    ctx.resyncToolVisibility(slot);
  });

  // === Context detail（上下文详情面板数据） ===
  // 组合 messages + systemPrompt + stats + compaction 配置，供渲染进程一次拉取
  ipcMain.handle('pi:getContextDetail', async () => {
    const session = ctx.sessionFor().requireSession();
    const stats = session.getSessionStats();
    return {
      messages: session.messages ?? [],
      systemPrompt: session.systemPrompt ?? '',
      contextUsage: stats?.contextUsage ?? null,
      tokens: stats?.tokens ?? null,
      cost: stats?.cost ?? null,
      totalMessages: stats?.totalMessages ?? 0,
      userMessages: stats?.userMessages ?? 0,
      assistantMessages: stats?.assistantMessages ?? 0,
      toolCalls: stats?.toolCalls ?? 0,
      toolResults: stats?.toolResults ?? 0,
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      contextWindow: session.model?.contextWindow ?? null
    };
  });

  // === File operations (for Monaco Code Panel) ===
  // 读路径放行项目目录 + 只读白名单（~/.pi-desktop、~/.agents、技能目录），写路径仍严格限项目内
  ipcMain.handle('pi:readFile', async (_e, filePath: string) => {
    const roots = skillReadableRoots(ctx, ctx.sessionFor().session);
    const fullPath = resolveReadablePath(ctx.cwd, filePath, { extra: roots });
    return fs.readFileSync(fullPath, 'utf-8');
  });

  ipcMain.handle('pi:listFiles', async (_e, dir?: string) => {
    const roots = skillReadableRoots(ctx, ctx.sessionFor().session);
    const targetDir = resolveReadablePath(ctx.cwd, dir, { extra: roots });
    // 项目外目录（技能等）返回绝对路径：FileTree 以该绝对目录为根，逐级拼接才能与子项对得上
    const insideProject = isInsideProject(ctx.cwd, targetDir);
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      path: insideProject
        ? path.relative(ctx.cwd, path.resolve(ctx.cwd, dir || '.', e.name))
        : path.join(targetDir, e.name),
      isDirectory: e.isDirectory()
    }));
  });

  ipcMain.handle('pi:getCwd', async () => ctx.cwd);

  // Windows/Linux 关于弹窗（第二个按钮打开开源许可清单）
  ipcMain.handle('pi:showAbout', async () => {
    const { app } = await import('electron');
    const result = await dialog.showMessageBox(ctx.win, {
      type: 'info',
      title: `关于 ${app.name}`,
      message: app.name,
      detail: `版本 ${app.getVersion()}\n基于 pi agent SDK 的桌面端 AI 编码助手`,
      buttons: ['确定', '开源许可'],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response === 1) await openThirdPartyNoticesWindow(ctx.win);
    return { ok: true };
  });

  // 开源许可清单窗口（清单由构建期的 npm run notices 生成，随安装包分发）
  ipcMain.handle('pi:openThirdPartyNotices', async () => openThirdPartyNoticesWindow(ctx.win));

  ipcMain.handle('pi:selectDirectory', async () => {
    if (!ctx.win) return null;
    const result = await dialog.showOpenDialog(ctx.win, {
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 选择单个文件（可选过滤器，用于技能 zip 导入等场景）
  ipcMain.handle('pi:selectFile', async (_e, opts: { title?: string; filters?: any[] }) => {
    if (!ctx.win) return null;
    const result = await dialog.showOpenDialog(ctx.win, {
      title: opts?.title || '选择文件',
      properties: ['openFile'],
      filters: opts?.filters || []
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    'pi:saveDialog',
    async (_e, opts: { title?: string; defaultPath?: string; filters?: any[] }) => {
      if (!ctx.win) return null;
      const result = await dialog.showSaveDialog(ctx.win, {
        title: opts.title,
        defaultPath: opts.defaultPath,
        filters: opts.filters || [{ name: 'All Files', extensions: ['*'] }]
      });
      if (result.canceled || !result.filePath) return null;
      return result.filePath;
    }
  );

  ipcMain.handle('pi:setCwd', (_e, newCwd: string) =>
    ctx.runSessionOperation(async () => {
      await ctx.createRuntimeFor(newCwd);
    })
  );

  // === Plan Mode ===
  ipcMain.handle('pi:setPlanMode', async (_e, enabled: boolean) => {
    ctx.setPlanMode(enabled);
    return { ok: true };
  });

  // === Ask User ===
  // 渲染进程提交用户对 ask 工具的回答（answers=null 表示用户取消）
  ipcMain.handle('pi:getPendingInteractions', async () => ctx.pendingInteractions());

  ipcMain.handle('pi:askUserResponse', async (_e, sessionId: unknown, answers: any[] | null) => {
    // 按会话回传（多会话下可能同时挂着多个提问）；兼容老渲染端把 answers 放在第 1 参
    const legacy = Array.isArray(sessionId) || sessionId === null;
    let key = typeof sessionId === 'string' ? sessionId : '';
    if (!key) {
      try {
        key = ctx.sessionFor().session?.sessionId ?? '';
      } catch {
        key = '';
      }
    }
    resolveAsk(key, (legacy ? (sessionId as any[] | null) : answers) ?? null);
    return { ok: true };
  });

  // 用系统默认浏览器打开外部链接（markdown 链接等场景），仅放行 http(s)
  ipcMain.handle('pi:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { ok: true };
  });

  // === 外部打开文件（代码面板"打开"下拉） ===
  // 返回已安装程序及系统图标，检测与图标读取在主进程缓存。
  ipcMain.handle('pi:detectApps', () => detectExternalApps());

  // 用指定 app 打开文件（appId 来自 detectApps；'default' 表示系统默认程序）
  // 仅启动外部程序、不回传文件内容，无需 cwd 沙箱限制；支持绝对路径与相对 cwd 的路径
  ipcMain.handle('pi:openWith', async (_e, filePath: string, appId: string) => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    await openExternalApp(fullPath, appId);
    return { ok: true };
  });

  // 在系统文件管理器中定位显示该文件
  // 仅调用 OS 的"在文件夹中显示"、不回传任何内容，无需 cwd 沙箱限制；
  // 支持绝对路径（侧边栏跨项目操作）与相对 cwd 的路径（代码面板面包屑）
  ipcMain.handle('pi:showInFolder', async (_e, filePath: string) => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    shell.showItemInFolder(fullPath);
    return { ok: true };
  });

  // 跨平台取路径最后一段（项目名/目录名）。renderer 禁用 nodeIntegration 无法直接用
  // node 的 path.basename，统一由主进程计算，避免 Windows 上 split('/') 对 `D:\work\piui`
  // 整串返回导致会话列表项目名显示成完整路径。
  ipcMain.handle('pi:baseName', (_e, p: string) => {
    if (!p) return '';
    return path.basename(p) || p;
  });

  // 读取 iTerm2-Color-Schemes 官方终端色表。返回 xterm ITheme 结构，
  // key 为 '<family>-<variant>'（如 'github-dark'）；找不到映射时返回 fallback 或 null。
  // 路径：打包后在 process.resourcesPath/terminal-themes，开发在 <cwd>/resources/terminal-themes。
  ipcMain.handle('pi:terminalTheme', async (_e, key: string) => {
    const fallback = TERMINAL_VARS_FALLBACK[key];
    const file = TERMINAL_THEME_FILE[key];
    if (!file) return fallback ?? null;
    const root = (process as any).resourcesPath
      ? path.join((process as any).resourcesPath, 'terminal-themes')
      : path.join(process.cwd(), 'resources/terminal-themes');
    try {
      const p = path.join(root, file);
      const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return parseITermTheme(json['workbench.colorCustomizations'] ?? json);
    } catch {
      return fallback ?? null;
    }
  });
}
