import { ipcMain } from 'electron';
import {
  getClassifierConfigPath,
  readClassifierConfig,
  removeClassifierProvider as removeClassifierProviderFromDisk,
  saveClassifierProvider as saveClassifierProviderToDisk,
  DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
  CLASSIFIER_API_KINDS,
  type ClassifierProviderConfig
} from '../classifier-config';
import {
  applyClassifierProviders,
  registerClassifierProvider,
  unregisterClassifierProvider,
  type ClassifierRegistrationError
} from '../classifier/registry';
import type { PiBridgeContext } from './types';
import { logClassifierCall, CLASSIFIER_LOG_CHANNEL } from '../logs/classifier-log';
import { getLogConfig, getLogsDir, getLogFilePath, isChannelEnabled } from '../logs/logger';

/**
 * 注册决策模型（classifier）相关 IPC：
 * getClassifierModels / classify /
 * getClassifierProviders / saveClassifierProvider / removeClassifierProvider / fetchClassifierModels
 *
 * 决策模型与 chat 模型的区别（见 resources/docs 与 SDK docs/models.md）：
 * 输入是一段 JSON `state`（可选图片），输出是若干带概率的结构化答案（choice / score / bool）。
 * 它们不出现在 `/model` 列表，也不能 stream()，只能通过 `classify()` 调用。
 */

/** 决策模型协议名（用于 UI 展示） */
const API_LABELS: Record<string, string> = {
  'typesafe-system-one': 'System One',
  'llama-cpp-classify': 'llama.cpp chat 模型'
};

export interface ClassifierModelInfo {
  provider: string;
  id: string;
  name: string;
  providerName: string;
  api: string;
  apiLabel: string;
  contextWindow?: number;
  supportsImage: boolean;
  /** 凭据是否已就绪（未就绪的模型不出现在可用列表里） */
  available: boolean;
  /** 该 provider 是否来自 classifiers.json（自定义端点） */
  custom: boolean;
}

export interface ClassifierRequest {
  provider: string;
  id: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  /** 单次尝试的 HTTP 超时 */
  timeoutMs?: number;
  /** 答案 logits 缩放（仅 llama-cpp-classify 生效，>1 更平缓，<1 更锐利） */
  temperature?: number;
}

/** 与 SDK ClassifierResult 同构；错误也走这个形状（classify 不 reject） */
export interface ClassifierResponse {
  api?: string;
  provider: string;
  model: string;
  answers: Record<string, unknown>;
  usage?: unknown;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResponse(
  provider: string,
  id: string,
  message: string,
  stopReason: 'error' | 'aborted' = 'error'
): ClassifierResponse {
  return {
    provider,
    model: id,
    answers: {},
    stopReason,
    errorMessage: message,
    timestamp: Date.now()
  };
}

/**
 * 校验 questions 结构。
 * SDK 只在**响应解析**阶段反查答案（system-one-shared.js:51 parseAnswers），请求发出去之前
 * 不会校验问题定义。这里在 IPC 边界先挡一道，避免白跑一次请求、也让报错更直白。
 */
export function validateQuestions(questions: Record<string, unknown>): string | null {
  const entries = Object.entries(questions ?? {});
  if (entries.length === 0) return '至少需要定义一个问题（questions 不能为空）';

  for (const [id, raw] of entries) {
    if (!isRecord(raw)) return `问题「${id}」必须是对象`;
    const type = raw.type;
    if (type === 'choice') {
      if (!isRecord(raw.criteria)) return `问题「${id}」(choice) 缺少 criteria 对象`;
      const labels = Object.keys(raw.criteria);
      if (labels.length < 2) return `问题「${id}」(choice) 至少需要 2 个候选标签`;
    } else if (type === 'score') {
      if (!Array.isArray(raw.criteria)) return `问题「${id}」(score) 缺少 criteria 数组`;
      if (raw.criteria.length < 2) return `问题「${id}」(score) 至少需要 2 档`;
    } else if (type === 'bool') {
      if (
        !isRecord(raw.criteria) ||
        typeof raw.criteria.true !== 'string' ||
        typeof raw.criteria.false !== 'string'
      ) {
        return `问题「${id}」(bool) 的 criteria 需要 { true, false } 两个字符串`;
      }
    } else {
      return `问题「${id}」的 type 非法（只支持 choice / score / bool）`;
    }
    if (typeof raw.instructions !== 'string' || !raw.instructions.trim()) {
      return `问题「${id}」缺少 instructions`;
    }
  }
  return null;
}

/** 探测端点模型列表（llama.cpp `GET /v1/models`，兼容纯 OpenAI 形状） */
interface DiscoveredClassifierModel {
  id: string;
  contextWindow?: number;
  /** 服务端是否声明原生 decisions 输出（llama.cpp `architecture.output_modalities`） */
  nativeDecisions?: boolean;
  supportsImage?: boolean;
}

async function fetchClassifierModels(
  baseUrl: string,
  apiKey?: string
): Promise<{ ok: boolean; models: DiscoveredClassifierModel[]; error?: string }> {
  try {
    let url = baseUrl.replace(/\/+$/, '');
    if (!url.endsWith('/models')) {
      url = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
    }
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(url, { headers });
    if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` };

    const payload = (await response.json()) as Record<string, unknown>;
    // llama.cpp 同时返回 Ollama 风格 `models` 与 OpenAI 风格 `data`；优先 `data`（信息更全）
    const raw = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];

    const models: DiscoveredClassifierModel[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      // OpenAI 风格用 id，Ollama 风格用 model/name
      const id =
        (typeof entry.id === 'string' && entry.id) ||
        (typeof entry.model === 'string' && entry.model) ||
        (typeof entry.name === 'string' && entry.name) ||
        '';
      if (!id) continue;

      const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
      const meta = isRecord(entry.meta) ? entry.meta : undefined;
      const outputModalities = Array.isArray(architecture?.output_modalities)
        ? architecture.output_modalities.filter((m): m is string => typeof m === 'string')
        : undefined;
      const inputModalities = Array.isArray(architecture?.input_modalities)
        ? architecture.input_modalities.filter((m): m is string => typeof m === 'string')
        : undefined;
      const nCtx = typeof meta?.n_ctx === 'number' && meta.n_ctx > 0 ? meta.n_ctx : undefined;

      models.push({
        id,
        ...(nCtx !== undefined ? { contextWindow: nCtx } : {}),
        ...(outputModalities ? { nativeDecisions: outputModalities.includes('decisions') } : {}),
        ...(inputModalities ? { supportsImage: inputModalities.includes('image') } : {})
      });
    }

    return { ok: true, models };
  } catch (err: any) {
    return { ok: false, models: [], error: String(err?.message ?? err) };
  }
}

export function registerClassifierIpc(ctx: PiBridgeContext & { modelRuntime: any }) {
  // === 决策模型清单 ===
  // 决策模型调用日志位置（~/.pi-desktop/logs/classifier-YYYY-MM-DD.log）：设置页展示 + 一键打开
  // 每次判定（含权限闸门自动调用与试跑）都会把请求参数与返回写成一行 JSON，排查"未判定"类问题靠它
  // enabled = 总开关 + classifier 通道都打开；否则文件根本不会产生，设置页要提醒用户去「日志」页打开
  ipcMain.handle('pi:getClassifierLogPath', () => ({
    dir: getLogsDir(),
    file: getLogFilePath(CLASSIFIER_LOG_CHANNEL),
    enabled: getLogConfig().enabled && isChannelEnabled(CLASSIFIER_LOG_CHANNEL)
  }));

  ipcMain.handle('pi:getClassifierModels', async () => {
    const runtime = ctx.modelRuntime;
    if (!runtime) return { models: [], errors: [] };

    const customKeys = new Set(Object.keys(readClassifierConfig().providers));

    // 已鉴权可用的模型集合（异步：需要解析凭据）
    const availableKeys = new Set<string>();
    try {
      const available = await runtime.getAvailableOfType('classifier');
      for (const model of available ?? []) {
        if (model?.provider && model?.id) availableKeys.add(`${model.provider}\u0000${model.id}`);
      }
    } catch {
      /* 凭据解析失败时全部标为不可用，不阻塞清单展示 */
    }

    let all: any[] = [];
    try {
      all = [...(runtime.getModelsOfType('classifier') ?? [])];
    } catch {
      all = [];
    }

    const models: ClassifierModelInfo[] = all.map((model) => {
      const provider = String(model?.provider ?? '');
      const id = String(model?.id ?? '');
      const api = String(model?.api ?? '');
      return {
        provider,
        id,
        name: String(model?.name ?? id),
        providerName: String(runtime.getProvider?.(provider)?.name ?? provider),
        api,
        apiLabel: API_LABELS[api] ?? api,
        ...(typeof model?.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        supportsImage: Array.isArray(model?.input) && model.input.includes('image'),
        available: availableKeys.has(`${provider}\u0000${id}`),
        custom: customKeys.has(provider)
      };
    });

    return { models, errors: [] };
  });

  // === 执行分类 ===
  ipcMain.handle('pi:classify', async (_e, request: ClassifierRequest) => {
    const runtime = ctx.modelRuntime;
    const provider = String(request?.provider ?? '');
    const id = String(request?.id ?? '');
    const startedAt = Date.now();
    /** 试跑调用也落盘（~/.pi-desktop/logs/classifier-*.log），与权限闸门共用同一份日志 */
    const logPlay = (entry: Record<string, unknown>) =>
      logClassifierCall('playground', {
        providerId: provider || null,
        modelId: id || null,
        elapsedMs: Date.now() - startedAt,
        ...entry
      });
    /** 参数/前置校验失败：落盘后返回统一错误形状 */
    const fail = (message: string) => {
      logPlay({ phase: 'error', note: message });
      return errorResponse(provider, id, message);
    };

    if (!runtime) return fail('模型运行时尚未就绪');
    if (!provider || !id) return fail('缺少 provider 或模型 id');
    if (!isRecord(request?.state)) return fail('state 必须是 JSON 对象');

    const questionError = validateQuestions(request?.questions);
    if (questionError) return fail(questionError);

    // 必须用 getModelOfType 取决策模型那一份：同一个 provider + id 可能同时存在 chat 条目
    const model = runtime.getModelOfType?.('classifier', provider, id);
    if (!model) {
      return fail(`未找到决策模型：${provider}/${id}`);
    }
    logPlay({
      phase: 'request',
      model: { api: model.api ?? null, baseUrl: model.baseUrl ?? null },
      state: request.state,
      questions: request.questions,
      ...(typeof request.timeoutMs === 'number' ? { timeoutMs: request.timeoutMs } : {}),
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {})
    });

    try {
      // classify() 不 reject，错误在结果的 stopReason / errorMessage 里
      // 注：pi-ai 1.0.1 的 ClassifierContext 只有 { state, questions }（无 images）
      const result = await runtime.classify(
        model,
        { state: request.state, questions: request.questions },
        {
          ...(typeof request.timeoutMs === 'number' && request.timeoutMs > 0
            ? { timeoutMs: request.timeoutMs }
            : {}),
          ...(typeof request.temperature === 'number' && request.temperature > 0
            ? { temperature: request.temperature }
            : {})
        }
      );

      const response = {
        api: result?.api,
        provider,
        model: result?.model ?? id,
        answers: result?.answers ?? {},
        ...(result?.usage ? { usage: result.usage } : {}),
        stopReason: result?.stopReason ?? 'error',
        ...(result?.errorMessage ? { errorMessage: result.errorMessage } : {}),
        timestamp: result?.timestamp ?? Date.now()
      } satisfies ClassifierResponse;

      // 端点的原始返回（含 stopReason / answers / usage）也落盘："未判定"时能直接看到原因
      logPlay({ phase: response.stopReason === 'stop' ? 'response' : 'error', result });
      return response;
    } catch (error: any) {
      logPlay({ phase: 'error', error });
      return errorResponse(provider, id, String(error?.message ?? error));
    }
  });

  // === 自定义决策模型 provider 管理 ===
  ipcMain.handle('pi:getClassifierProviders', async () => {
    const cfg = readClassifierConfig();
    const runtime = ctx.modelRuntime;
    const errors: ClassifierRegistrationError[] = [];

    // runtime 重建后（或热更新配置后）确保已注册，顺带收集注册错误
    if (runtime) {
      try {
        const result = applyClassifierProviders(runtime);
        errors.push(...result.errors);
      } catch (error: any) {
        errors.push({ key: '*', message: String(error?.message ?? error) });
      }
    }

    return {
      providers: Object.values(cfg.providers),
      path: getClassifierConfigPath(),
      apiKinds: CLASSIFIER_API_KINDS,
      defaultContextWindow: DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
      errors
    };
  });

  ipcMain.handle('pi:saveClassifierProvider', async (_e, config: ClassifierProviderConfig) => {
    const key = String(config?.key ?? '').trim();
    if (!key) return { ok: false, error: '缺少 provider key' };

    const normalized: ClassifierProviderConfig = {
      key,
      ...(config.name?.trim() ? { name: config.name.trim() } : {}),
      baseUrl: String(config.baseUrl ?? '').trim(),
      api: config.api,
      ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
      ...(config.headers && Object.keys(config.headers).length > 0
        ? { headers: config.headers }
        : {}),
      models: (config.models ?? [])
        .map((m) => ({
          id: String(m?.id ?? '').trim(),
          ...(m?.name?.trim() ? { name: m.name.trim() } : {}),
          ...(typeof m?.contextWindow === 'number' && m.contextWindow > 0
            ? { contextWindow: Math.floor(m.contextWindow) }
            : {}),
          ...(Array.isArray(m?.input) && m.input.length > 0 ? { input: m.input } : {})
        }))
        .filter((m) => m.id)
    };

    if (!normalized.baseUrl) return { ok: false, error: '缺少 baseUrl' };
    if (!(CLASSIFIER_API_KINDS as readonly string[]).includes(normalized.api)) {
      return { ok: false, error: `不支持的决策模型协议：${normalized.api}` };
    }
    if (normalized.models.length === 0) return { ok: false, error: '至少需要一个模型' };

    // 先注册试一次：配置有问题（如缺 api）应在这里就报错，不落盘
    const runtime = ctx.modelRuntime;
    if (runtime) {
      try {
        registerClassifierProvider(runtime, normalized);
      } catch (error: any) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    try {
      saveClassifierProviderToDisk(normalized);
    } catch (error: any) {
      return { ok: false, error: `写入配置失败：${String(error?.message ?? error)}` };
    }

    return { ok: true, key };
  });

  ipcMain.handle('pi:removeClassifierProvider', async (_e, key: string) => {
    const providerKey = String(key ?? '').trim();
    if (!providerKey) return { ok: false, error: '缺少 provider key' };

    const runtime = ctx.modelRuntime;
    if (runtime) {
      try {
        unregisterClassifierProvider(runtime, providerKey);
      } catch {
        /* provider 未注册时 unregister 无副作用，忽略 */
      }
    }

    try {
      removeClassifierProviderFromDisk(providerKey);
    } catch (error: any) {
      return { ok: false, error: `删除配置失败：${String(error?.message ?? error)}` };
    }

    return { ok: true };
  });

  // === 从端点探测模型列表（llama.cpp /v1/models） ===
  ipcMain.handle('pi:fetchClassifierModels', async (_e, baseUrl: string, apiKey?: string) => {
    if (!String(baseUrl ?? '').trim()) return { ok: false, models: [], error: '缺少 baseUrl' };
    return await fetchClassifierModels(String(baseUrl).trim(), apiKey);
  });
}
