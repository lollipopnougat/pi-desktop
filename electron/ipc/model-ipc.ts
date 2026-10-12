import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { getAgentDir } from '../provider-config';
import { buildModelPresets } from '../model-presets';
import type { ModelPreset } from '../../src/types/model-preset';
import type { PiBridgeContext } from './types';

/**
 * 注册模型/供应商相关 IPC：
 * getAvailableModels / getAllModels / setModel / cycleModel /
 * setThinkingLevel / cycleThinkingLevel / getThinkingLevels /
 * getDefaultModel / setDefaultModel /
 * getBuiltinProviders / setProviderApiKey / removeProviderApiKey / getProviderApiKey /
 * fetchModels / getProviders / saveProvider / removeProvider / getModelPresets
 */
export function registerModelIpc(ctx: PiBridgeContext & { modelRuntime: any }) {
  /**
   * models.json（自定义 chat provider）与 classifiers.json（自定义决策端点）里的
   * provider 都是运行时注册的，不算内置：内置供应商列表与模型预设都要把它们排除。
   */
  const getCustomProviderIds = async (): Promise<Set<string>> => {
    const ids = new Set<string>();
    try {
      const { readProviderConfig } = await import('../provider-config');
      for (const key of Object.keys(readProviderConfig().providers || {})) ids.add(key);
    } catch {}
    try {
      const { readClassifierConfig } = await import('../classifier-config');
      for (const key of Object.keys(readClassifierConfig().providers || {})) ids.add(key);
    } catch {}
    return ids;
  };

  /** SDK 内置模型目录（离线、无鉴权），构建一次后全进程复用（pi:refreshProviders 时作废） */
  let presetCache: ModelPreset[] | null = null;

  // === Model ===
  ipcMain.handle('pi:getAvailableModels', async () => {
    if (!ctx.modelRuntime) return [];
    return await ctx.modelRuntime.getAvailable();
  });

  ipcMain.handle('pi:getAllModels', async () => {
    if (!ctx.modelRuntime) return [];
    const providers = ctx.modelRuntime.getProviders();
    const models: any[] = [];
    for (const p of providers) {
      const pms = ctx.modelRuntime.getModels(p.id);
      if (pms) models.push(...pms);
    }
    return models;
  });

  ipcMain.handle('pi:setModel', async (_e, provider: string, modelId: string) => {
    if (!ctx.modelRuntime) return null;
    const model = ctx.modelRuntime.getModel(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }
    const slot = ctx.sessionFor();
    const session = slot.requireSession();
    await session.setModel(model);
    if (slot.session !== session) throw new Error('SESSION_CHANGED');
    // 模型切换后同步 read_img 工具可见性（新模型支持视觉则移除，不支持且已配置则注入）
    try {
      (ctx as any).syncReadImgTool?.();
    } catch {}
    // 模型级默认思考等级：models.json 中为该模型配置的 defaultThinkingLevel
    // 优先于会话继承的等级。SDK setThinkingLevel 会自动 clamp 到模型支持的等级，
    // 无效值不会报错。仅自定义 provider 的模型带此字段。
    try {
      const { readProviderConfig } = await import('../provider-config');
      const configured = readProviderConfig().providers?.[provider];
      const modelCfg = configured?.models?.find((m: any) => m.id === modelId);
      const defaultLevel = modelCfg?.defaultThinkingLevel;
      if (typeof defaultLevel === 'string' && defaultLevel) {
        if (slot.session !== session) throw new Error('SESSION_CHANGED');
        session.setThinkingLevel(defaultLevel);
      }
    } catch {
      // models.json 读取失败时不阻塞模型切换，沿用 SDK 默认行为
    }
    // 返回切换后的最新模型与 thinkingLevel，renderer 据此同步 UI（SDK 的
    // model_select 是扩展事件，AgentSessionEvent 不含它，无法经 onEvent 通知）
    const s = session;
    return { model: s.model, thinkingLevel: s.thinkingLevel };
  });

  ipcMain.handle('pi:cycleModel', async () => {
    // 与 pi:setModel 保持一致：切换后同步 read_img 可见性（模型是否支持视觉会变）
    const result = await ctx.sessionFor().requireSession().cycleModel();
    try {
      (ctx as any).syncReadImgTool?.();
    } catch {}
    return result;
  });

  ipcMain.handle('pi:setThinkingLevel', async (_e, level: string) => {
    ctx.sessionFor().requireSession().setThinkingLevel(level);
  });

  ipcMain.handle('pi:cycleThinkingLevel', async () => {
    return ctx.sessionFor().requireSession().cycleThinkingLevel();
  });

  ipcMain.handle('pi:getThinkingLevels', async () => {
    // 用 SDK 的 getAvailableThinkingLevels：按当前模型 thinkingLevelMap 过滤掉
    // 不支持的等级（如 deepseek 只支持 off/high/max，点 low 会被 clamp 回 high）
    const session = ctx.sessionFor().requireSession();
    const levels = session.getAvailableThinkingLevels?.();
    if (Array.isArray(levels) && levels.length > 0) return levels;
    // 兜底：SDK 方法不可用时退回原逻辑
    const model = session.model;
    if (!model) return ['off'];
    if (!model.reasoning) return ['off'];
    return ['off', 'minimal', 'low', 'medium', 'high'];
  });

  // === 默认模型（~/.pi-desktop/settings.json 的 defaultProvider / defaultModel） ===
  // SDK 在新建会话时按 model-resolver 的优先级读取这两个字段（要求该 provider 已配鉴权）：
  // 会话无历史 → 默认模型 → 内置 provider 默认表 → 第一个可用模型。
  // 恢复已有会话时按会话自身记录的 model_change 还原，不受此设置影响。
  const settingsPath = () => path.join(getAgentDir(), 'settings.json');

  const readDefaultModel = (): { provider: string; modelId: string } | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      const provider = typeof raw?.defaultProvider === 'string' ? raw.defaultProvider : '';
      const modelId = typeof raw?.defaultModel === 'string' ? raw.defaultModel : '';
      return provider && modelId ? { provider, modelId } : null;
    } catch {
      return null;
    }
  };

  /** 只改 defaultProvider/defaultModel 两个键，其余字段（compaction 等）原样保留，原子写 */
  const writeDefaultModel = (value: { provider: string; modelId: string } | null) => {
    const fullPath = settingsPath();
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch {
      /* 无则新建 */
    }
    if (value) {
      existing.defaultProvider = value.provider;
      existing.defaultModel = value.modelId;
    } else {
      delete existing.defaultProvider;
      delete existing.defaultModel;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const tmp = `${fullPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf-8');
    fs.renameSync(tmp, fullPath);
  };

  ipcMain.handle('pi:getDefaultModel', async () => {
    return readDefaultModel();
  });

  // 设置/清除默认模型（null = 清除，回落到 SDK 的内置 provider 默认表）
  ipcMain.handle(
    'pi:setDefaultModel',
    async (_e, provider: string | null, modelId: string | null) => {
      try {
        const next = provider && modelId ? { provider, modelId } : null;
        if (next) {
          // 模型必须真实存在；provider 未配鉴权时 SDK 会静默忽略该默认值，直接报错更清楚
          const model = ctx.modelRuntime?.getModel?.(provider, modelId);
          if (!model) return { ok: false, error: `model not found: ${provider}/${modelId}` };
          const status = ctx.modelRuntime?.getProviderAuthStatus?.(provider);
          if (status && status.configured === false) {
            return { ok: false, error: `provider auth not configured: ${provider}` };
          }
        }
        writeDefaultModel(next);
        // 让 SDK 的 SettingsManager 立即读到新值（新建会话按新默认值选模型）
        const sm = ctx.sessionFor().session?.settingsManager ?? ctx.runtime?.settingsManager;
        await sm?.reload?.().catch?.(() => {});
        return { ok: true, config: next };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  // === 自定义 Provider：从 OpenAI 兼容端点拉取模型列表 ===
  ipcMain.handle('pi:fetchModels', async (_e, baseUrl: string, apiKey?: string) => {
    const { fetchOpenAiModels } = await import('../provider-config');
    return await fetchOpenAiModels(baseUrl, apiKey);
  });

  // === 内置供应商（SDK 自带 provider，排除 models.json 中的自定义 provider，避免重复展示） ===
  ipcMain.handle('pi:getBuiltinProviders', async () => {
    if (!ctx.modelRuntime) return [];
    // 排除 models.json / classifiers.json 里的自定义 provider（见 getCustomProviderIds 注释）
    const customProviderIds = await getCustomProviderIds();
    const providers = ctx.modelRuntime.getProviders();
    const result: any[] = [];
    for (const p of providers) {
      // 仅展示真内置 provider，排除 models.json 自定义
      if (customProviderIds.has(p.id)) continue;
      const models = ctx.modelRuntime.getModels(p.id) ?? [];
      // 决策模型数：chat 与 classifier 的模型清单在 SDK 里是分开的（getModels 只回 chat），
      // 设置页「决策模型」tab 用它区分「内置决策模型供应商」与普通聊天供应商。
      let classifierCount = 0;
      try {
        classifierCount = (ctx.modelRuntime.getModelsOfType?.('classifier', p.id) ?? []).length;
      } catch {
        classifierCount = 0;
      }
      let authStatus: any = { configured: false };
      try {
        authStatus = ctx.modelRuntime.getProviderAuthStatus(p.id);
      } catch {}
      result.push({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl ?? '',
        modelCount: models.length,
        classifierCount,
        authConfigured: !!authStatus?.configured,
        authSource: authStatus?.source,
        authLabel: authStatus?.label
      });
    }
    return result;
  });

  ipcMain.handle('pi:setProviderApiKey', async (_e, providerId: string, key: string) => {
    if (!ctx.modelRuntime) return;
    // SDK 的 setRuntimeApiKey 仅写内存覆盖层（重启丢失），这里同步落盘 auth.json
    const { persistBuiltinApiKey } = await import('../provider-config');
    persistBuiltinApiKey(providerId, key);
    await ctx.modelRuntime.setRuntimeApiKey(providerId, key, { allowNetwork: false });
    return { ok: true };
  });

  ipcMain.handle('pi:removeProviderApiKey', async (_e, providerId: string) => {
    if (!ctx.modelRuntime) return;
    // 同步删除 auth.json 中的持久化条目，避免重启后残留
    const { deleteBuiltinApiKey } = await import('../provider-config');
    deleteBuiltinApiKey(providerId);
    await ctx.modelRuntime.removeRuntimeApiKey(providerId);
    return { ok: true };
  });

  // === 读取已保存的内置供应商 Key（设置页「编辑」表单回填用） ===
  // 只读 auth.json（主进程），renderer 拿不到任意文件读能力；不做环境变量兜底。
  ipcMain.handle('pi:getProviderApiKey', async (_e, providerId: string) => {
    if (typeof providerId !== 'string' || !providerId) return '';
    const { readBuiltinApiKey } = await import('../provider-config');
    return readBuiltinApiKey(providerId);
  });

  // === Provider Config（自定义 provider，写入 models.json） ===
  ipcMain.handle('pi:getProviders', async () => {
    const { readProviderConfig } = await import('../provider-config');
    return readProviderConfig();
  });

  // 手动刷新供应商与模型清单：允许网络（重新拉取远端模型目录）+ 重建鉴权快照。
  // 用于「内置供应商」区的刷新按钮（key 在外部变更/模型目录更新后手动同步）。
  ipcMain.handle('pi:refreshProviders', async () => {
    try {
      await ctx.modelRuntime?.refresh({ allowNetwork: true });
      // 模型目录可能更新，预设缓存作废
      presetCache = null;
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('pi:saveProvider', async (_e, config: any) => {
    const { saveProviderConfig } = await import('../provider-config');
    await saveProviderConfig(config);
    // 重新读取 models.json，刷新 provider/model 列表
    await ctx.modelRuntime?.refresh({ allowNetwork: false });
  });

  ipcMain.handle('pi:removeProvider', async (_e, key: string) => {
    const { removeProviderConfig } = await import('../provider-config');
    await removeProviderConfig(key);
    await ctx.modelRuntime?.refresh({ allowNetwork: false });
  });

  // === 模型预设（SDK 内置模型目录，供自定义 Provider 的模型表单一键带出参数） ===
  ipcMain.handle('pi:getModelPresets', async () => {
    if (presetCache) return presetCache;
    if (!ctx.modelRuntime) return [];
    const customProviderIds = await getCustomProviderIds();
    const raw: any[] = [];
    const providerNames = new Map<string, string>();
    for (const p of ctx.modelRuntime.getProviders()) {
      if (customProviderIds.has(p.id)) continue;
      providerNames.set(p.id, p.name || p.id);
      const models = ctx.modelRuntime.getModels(p.id);
      if (Array.isArray(models)) raw.push(...models);
    }
    presetCache = buildModelPresets(raw, providerNames);
    return presetCache;
  });

  ipcMain.handle('pi:setApiKey', async (_e, provider: string, key: string) => {
    // setRuntimeApiKey 默认 refresh 会走网络（allowNetwork: true），
    // 对内网网关（如 JD LLM Gateway）网络请求会失败，这里禁止网络刷新
    ctx.modelRuntime?.setRuntimeApiKey(provider, key, { allowNetwork: false });
  });

  ipcMain.handle('pi:checkAuth', async (_e, provider: string) => {
    if (!ctx.modelRuntime) return { status: 'unknown' };
    return await ctx.modelRuntime.checkAuth(provider);
  });
}
