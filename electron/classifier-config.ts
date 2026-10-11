/**
 * 决策模型（classifier）自定义 provider 配置
 *
 * 配置文件：~/.pi-desktop/classifiers.json
 *
 * 为什么不写进 models.json：SDK 的 models.json schema 不支持决策模型 ——
 * `ModelDefinitionSchema`（pi-coding-agent/dist/core/model-config.d.ts:3）没有 `type` 字段，
 * `ProviderConfigSchema` 也没有 `classifiers`。声明 classifier 模型与实现只有扩展
 * `pi.registerProvider()` 那条路（ProviderClassifierModelConfig / ProviderConfigInput.classifiers）。
 * 因此这里用独立配置文件，由 electron/classifier/registry.ts 在 runtime 就绪后调用
 * `ModelRuntime.registerProvider()` 完成注册。
 *
 * 为什么要分离 chat / classifier 的 provider key：SDK 语义是「传了 models 就替换该 provider
 * 的全部模型」（provider-composer.js:171 applyExtension），所以决策模型必须挂在独立 key 上，
 * 否则会把同名 provider 的 chat 模型整体顶掉。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from './config-dir';

const CLASSIFIERS_PATH = path.join(DESKTOP_AGENT_DIR, 'classifiers.json');

/**
 * 支持的决策模型协议。
 *
 * - `typesafe-system-one`：System One 协议（POST {baseUrl}/systemone，body `{model,state,questions}`）。
 *   TypeSafe 直连、OpenRouter、OpenCode Zen、Vercel AI Gateway、以及 **本地 llama.cpp
 *   ≥ 0.6.0 的 /v1/systemone** 都是这套协议。
 * - `llama-cpp-classify`：把普通 llama.cpp **chat 模型**当分类器用（走 next-token logprobs），
 *   适用于服务端未提供原生 decisions 输出的情况。
 *
 * `cloudflare-workers-ai-system-one` 不在列表内：它需要账户维度鉴权
 * （CLOUDFLARE_ACCOUNT_ID），内置 provider 已覆盖，不适合作为自定义端点。
 */
export type ClassifierApiKind = 'typesafe-system-one' | 'llama-cpp-classify';

export const CLASSIFIER_API_KINDS: readonly ClassifierApiKind[] = [
  'typesafe-system-one',
  'llama-cpp-classify'
];

/** 决策模型默认上下文窗口（分类输入通常只是一段 JSON state） */
export const DEFAULT_CLASSIFIER_CONTEXT_WINDOW = 32768;

export interface ClassifierModelConfig {
  id: string;
  name?: string;
  /** 上下文窗口，缺省 DEFAULT_CLASSIFIER_CONTEXT_WINDOW */
  contextWindow?: number;
  /** 输入模态。只有目录标 image 的模型才接受图片，缺省 ['text'] */
  input?: ('text' | 'image')[];
  /** 计价（本地模型通常全 0），缺省全 0 */
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ClassifierProviderConfig {
  /** provider key（classifiers.json 内的对象键），必须与 models.json 的 key 不冲突 */
  key: string;
  name?: string;
  /** 服务地址。System One 会拼成 {baseUrl}/systemone；llama-cpp-classify 用 {baseUrl}/v1/completions */
  baseUrl: string;
  api: ClassifierApiKind;
  /**
   * 凭据。SDK 强制要求非空（provider-composer.js:357「no authentication method configured」），
   * llama.cpp 未用 --api-key 启动时随便给个非空值即可，registry 会兜底为 'local'。
   */
  apiKey?: string;
  headers?: Record<string, string>;
  models: ClassifierModelConfig[];
}

export interface ClassifiersJson {
  providers: Record<string, ClassifierProviderConfig>;
}

/** 空配置骨架 */
export function emptyClassifierConfig(): ClassifiersJson {
  return { providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiKind(value: unknown): value is ClassifierApiKind {
  return typeof value === 'string' && (CLASSIFIER_API_KINDS as readonly string[]).includes(value);
}

function normalizeCost(value: unknown): ClassifierModelConfig['cost'] | undefined {
  if (!isRecord(value)) return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const input = num(value.input);
  const output = num(value.output);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(num(value.cacheRead) !== undefined ? { cacheRead: num(value.cacheRead) } : {}),
    ...(num(value.cacheWrite) !== undefined ? { cacheWrite: num(value.cacheWrite) } : {})
  };
}

function normalizeModel(value: unknown): ClassifierModelConfig | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;

  const input = Array.isArray(value.input)
    ? (value.input.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image') as (
        'text' | 'image'
      )[])
    : undefined;
  const contextWindow =
    typeof value.contextWindow === 'number' &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0
      ? Math.floor(value.contextWindow)
      : undefined;

  const cost = normalizeCost(value.cost);

  return {
    id,
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(input && input.length > 0 ? { input } : {}),
    ...(cost ? { cost } : {})
  };
}

/**
 * 校验并归一化单条 provider 配置。
 * 返回 null 表示该条无效（缺 key/baseUrl/api 或模型列表为空）—— 视为损坏条目丢弃，
 * 不让一条坏配置拖垮整个决策模型功能。
 */
export function normalizeClassifierProvider(
  key: string,
  value: unknown
): ClassifierProviderConfig | null {
  if (!isRecord(value)) return null;
  const providerKey = typeof key === 'string' ? key.trim() : '';
  if (!providerKey) return null;

  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  if (!baseUrl) return null;

  if (!isApiKind(value.api)) return null;

  const models = Array.isArray(value.models)
    ? value.models.map(normalizeModel).filter((m): m is ClassifierModelConfig => m !== null)
    : [];
  if (models.length === 0) return null;

  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : undefined;

  return {
    key: providerKey,
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
    baseUrl,
    api: value.api,
    ...(typeof value.apiKey === 'string' && value.apiKey.trim() ? { apiKey: value.apiKey } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    models
  };
}

/**
 * 读取 classifiers.json。
 * 损坏的 JSON 或单条非法配置都会被静默跳过（不影响其它条目），保持文件不被覆写，
 * 便于用户自行修复。
 */
export function readClassifierConfig(): ClassifiersJson {
  if (!fs.existsSync(CLASSIFIERS_PATH)) return emptyClassifierConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(CLASSIFIERS_PATH, 'utf-8'));
  } catch {
    return emptyClassifierConfig();
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return emptyClassifierConfig();

  const providers: Record<string, ClassifierProviderConfig> = {};
  for (const [key, value] of Object.entries(parsed.providers)) {
    const normalized = normalizeClassifierProvider(key, value);
    if (normalized) providers[key] = normalized;
  }
  return { providers };
}

/** 写入 classifiers.json（保留其它未知顶层字段） */
function writeClassifierJson(next: ClassifiersJson): void {
  fs.mkdirSync(DESKTOP_AGENT_DIR, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(CLASSIFIERS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CLASSIFIERS_PATH, 'utf-8'));
      if (isRecord(raw)) existing = raw;
    } catch {
      /* 损坏文件直接重建 */
    }
  }

  const payload = { ...existing, providers: next.providers };
  fs.writeFileSync(CLASSIFIERS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

/** 新增或覆盖一条决策模型 provider */
export function saveClassifierProvider(config: ClassifierProviderConfig): void {
  const current = readClassifierConfig();
  current.providers[config.key] = config;
  writeClassifierJson(current);
}

/** 删除一条决策模型 provider，返回是否真的删掉了 */
export function removeClassifierProvider(key: string): boolean {
  const current = readClassifierConfig();
  if (!current.providers[key]) return false;
  delete current.providers[key];
  writeClassifierJson(current);
  return true;
}

export function getClassifierConfigPath(): string {
  return CLASSIFIERS_PATH;
}
