import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from './config-dir';

// pi-desktop 独立配置目录 ~/.pi-desktop（不再与 pi CLI 共享 ~/.pi/agent）
const AGENT_DIR = DESKTOP_AGENT_DIR;
const MODELS_PATH = path.join(AGENT_DIR, 'models.json');
const AUTH_PATH = path.join(AGENT_DIR, 'auth.json');

export interface ProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  /** 思考等级映射：勾选 → identity，未勾选 → null（SDK getSupportedThinkingLevels 消费） */
  thinkingLevelMap?: Record<string, string | null>;
  /** 模型级默认思考等级：切换模型时应用（SDK 不消费，pi:setModel handler 读取） */
  defaultThinkingLevel?: string;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, any>;
}

export interface ProviderConfig {
  key: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models: ProviderModelConfig[];
}

export interface ModelsJson {
  providers: Record<string, any>;
}

/**
 * Read the current models.json
 * @param excludeKeys 需要从结果中排除的 provider key
 */
export function readProviderConfig(excludeKeys: string[] = []): ModelsJson {
  const base = (() => {
    if (!fs.existsSync(MODELS_PATH)) {
      return { providers: {} };
    }
    const raw = fs.readFileSync(MODELS_PATH, 'utf-8');
    try {
      return JSON.parse(raw) as ModelsJson;
    } catch {
      return { providers: {} };
    }
  })();
  if (excludeKeys.length === 0) return base;
  const filtered: Record<string, any> = {};
  const exclude = new Set(excludeKeys);
  for (const [k, v] of Object.entries(base.providers || {})) {
    if (!exclude.has(k)) filtered[k] = v;
  }
  return { providers: filtered };
}

/**
 * Save or update a provider in models.json.
 * Triggers pi's native hot-reload (models.json is re-read on model selection).
 */
export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  const current = readProviderConfig();
  if (!current.providers) {
    current.providers = {};
  }

  current.providers[config.key] = {
    name: config.name || config.key,
    baseUrl: config.baseUrl,
    api: config.api,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.authHeader ? { authHeader: config.authHeader } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    models: config.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.input ? { input: m.input } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      ...(m.defaultThinkingLevel ? { defaultThinkingLevel: m.defaultThinkingLevel } : {}),
      ...(m.cost ? { cost: m.cost } : {}),
      ...(m.compat ? { compat: m.compat } : {})
    }))
  };

  writeModelsJson(current);
}

/**
 * Remove a provider from models.json
 */
export async function removeProviderConfig(key: string): Promise<void> {
  const current = readProviderConfig();
  if (current.providers && current.providers[key]) {
    delete current.providers[key];
    writeModelsJson(current);
  }
}

/**
 * Write models.json with pretty formatting
 */
function writeModelsJson(data: ModelsJson): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(MODELS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the models.json path (for ModelRuntime)
 */
export function getModelsPath(): string {
  return MODELS_PATH;
}

/**
 * Get the auth.json path
 */
export function getAuthPath(): string {
  return path.join(AGENT_DIR, 'auth.json');
}

/**
 * Get the agent dir
 */
export function getAgentDir(): string {
  return AGENT_DIR;
}

// =============================================================================
// 内置供应商 API Key 持久化（auth.json）
// SDK 的 ModelRuntime.setRuntimeApiKey 只写内存覆盖层（RuntimeCredentials.overrides），
// 不会落盘 auth.json，重启后丢失。这里按 SDK 的 auth.json 凭证格式直接持久化：
//   { "<providerId>": { "type": "api_key", "key": "<key>" } }
// 写入后仍需调用 modelRuntime.setRuntimeApiKey 同步当次会话的内存快照；
// 下次启动 ModelRuntime.create 会读取 auth.json 自动恢复。原子写 (temp+rename) 避免半写损坏。
// =============================================================================

function readAuthJson(): Record<string, any> {
  try {
    if (!fs.existsSync(AUTH_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAuthJson(data: Record<string, any>): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const tmp = `${AUTH_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, AUTH_PATH);
  // rename 可能不保留 mode，再显式 chmod 一次
  try {
    fs.chmodSync(AUTH_PATH, 0o600);
  } catch {
    // Windows 不支持 Unix 权限位，忽略
  }
}

/** 持久化内置供应商的 API Key 到 auth.json（合并保留其它条目） */
export function persistBuiltinApiKey(providerId: string, key: string): void {
  const data = readAuthJson();
  data[providerId] = { type: 'api_key', key };
  writeAuthJson(data);
}

/** 从 auth.json 删除内置供应商的 API Key（保留其它条目） */
export function deleteBuiltinApiKey(providerId: string): void {
  const data = readAuthJson();
  if (providerId in data) {
    delete data[providerId];
    writeAuthJson(data);
  }
}

/**
 * 读取内置供应商在 auth.json 中保存的 API Key（设置页「编辑」表单回填用）。
 * 只认 SDK 的 api_key 凭证格式（{ type: 'api_key', key }）；oauth 等其它类型返回 ''，
 * 避免把 access token 回填进输入框后被当成 API Key 覆盖保存。
 * 不做环境变量兜底：环境变量来源已由列表徽标标明，把 env 值回填反而容易诱使用户
 * 原样「保存」一次，把环境变量值写进 auth.json。
 */
export function readBuiltinApiKey(providerId: string): string {
  if (!providerId) return '';
  const credential = readAuthJson()[providerId];
  if (
    credential &&
    typeof credential === 'object' &&
    credential.type === 'api_key' &&
    typeof credential.key === 'string'
  ) {
    return credential.key;
  }
  return '';
}

/**
 * 计算指定 cwd 的会话目录（与 SDK getDefaultSessionDir 编码规则一致）：
 * ~/.pi-desktop/sessions/--<encoded-cwd>--/
 * SDK 未导出 getDefaultSessionDir，这里本地复刻，避免会话目录静默落回 ~/.pi/agent。
 */
export function getSessionDir(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = path.join(AGENT_DIR, 'sessions', safePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 目录创建失败时交给调用方处理
  }
  return dir;
}

/**
 * 移除项目：删除该 cwd 对应的会话目录（~/.pi-desktop/sessions/--<encoded-cwd>--/）。
 * 仅清除会话数据，不删除磁盘上的项目目录本身。
 */
export function removeProjectSessions(cwd: string): void {
  const dir = getSessionDir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// OpenAI 兼容网关模型拉取（通用）
// 从任意 OpenAI Chat Completions 兼容的 /v1/models 端点拉取模型列表，
// 供自定义 Provider 表单的「从 /v1/models 拉取」按钮使用。
// =============================================================================

export interface FetchedModelEntry {
  id: string;
}

export interface FetchModelsResult {
  ok: boolean;
  models: FetchedModelEntry[];
  error?: string;
}

/**
 * 从 OpenAI 兼容的 /v1/models 端点拉取模型列表。
 * baseUrl 可带 /v1 也可不带；apiKey 为空时不带 Authorization 头。
 */
export async function fetchOpenAiModels(
  baseUrl: string,
  apiKey?: string
): Promise<FetchModelsResult> {
  try {
    // 规范化：确保 baseUrl 以 /models 结尾（兼容用户填带 /v1 或不填的情况）
    let url = baseUrl.replace(/\/+$/, '');
    if (!url.endsWith('/models')) {
      url = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
    }
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      return { ok: false, models: [], error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as {
      data?: Array<{ id: string }>;
    };
    const models = (payload.data ?? []).map((m) => ({ id: m.id }));
    return { ok: true, models };
  } catch (err: any) {
    return {
      ok: false,
      models: [],
      error: String(err?.message ?? err)
    };
  }
}
