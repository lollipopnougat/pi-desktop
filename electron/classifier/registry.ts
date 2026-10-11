/**
 * 决策模型 provider 注册器
 *
 * 把 classifiers.json 里的自定义决策模型 provider 注册进 SDK 的 `ModelRuntime`。
 *
 * 为什么不用扩展 `pi.registerProvider()`：
 * 扩展的 `pi.registerProvider` 内部就是转发到 `modelRegistry.registerProvider(name, config)`
 * （见 pi-coding-agent/dist/core/extensions/runner.js:309-315），而 `ModelRuntime` 自己就公开了
 * 同名方法（model-runtime.d.ts:117 `registerProvider(providerId, config: ProviderConfigInput): void`）。
 * 直接用 runtime 的公开方法可以在 IPC 里即时生效/撤销，不必依赖扩展加载时序，也不必重载会话。
 *
 * 注册语义（provider-composer.js:171-178 applyExtension）：
 * **传了 `models` 就替换该 provider 的全部模型** —— 因此决策模型必须使用独立 provider key，
 * 不能复用 models.json 里已有的 chat provider key（那会把它的 chat 模型整体顶掉）。
 */
import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import { llamaCppClassifyApi } from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy';
import {
  DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
  readClassifierConfig,
  type ClassifierApiKind,
  type ClassifierProviderConfig
} from '../classifier-config';

/**
 * 协议实现表。惰性工厂：`.lazy` 模块只在真正注册时才拉取实现代码。
 *
 * 类型用 `ReturnType<...>` 推导：`ProviderClassifier` 声明在 pi-ai 的 types.d.ts，
 * 但没有被根入口 index.d.ts re-export，从根导入会失败。
 */
type ClassifierImplementation = ReturnType<typeof typesafeSystemOneApi>;

const CLASSIFIER_IMPLEMENTATIONS: Record<ClassifierApiKind, () => ClassifierImplementation> = {
  'typesafe-system-one': typesafeSystemOneApi,
  'llama-cpp-classify': llamaCppClassifyApi
};

/**
 * `classify()` 要求非空凭据（system-one-shared.js:137「No API key for provider」），
 * 且 SDK 组 provider 时缺凭据会直接抛错（provider-composer.js:357）。
 * llama.cpp 未用 `--api-key` 启动时不校验凭据，这里给一个占位值。
 */
const PLACEHOLDER_API_KEY = 'local';

/**
 * 注册所需的最小 runtime 形状。
 * 只依赖这两个公开方法，便于单测用假对象替换，不与 SDK 具体类型耦合。
 */
export interface ClassifierRuntimeLike {
  registerProvider(providerId: string, config: unknown): void;
  unregisterProvider(providerId: string): void;
}

export interface ClassifierRegistrationError {
  key: string;
  message: string;
}

export interface ApplyClassifierResult {
  /** 成功注册的 provider key */
  applied: string[];
  /** 注册失败的 provider（单条失败不影响其它条） */
  errors: ClassifierRegistrationError[];
}

/**
 * 把一条配置翻译成 `ProviderConfigInput`。
 *
 * 要点：
 * - `type: 'classifier'` 必须写在**模型条目**上；分类模型不会从 provider 级 `api` 继承
 *   （provider-composer.js:122 `api = definition.api ?? (type === 'chat' ? config.api : undefined)`），
 *   所以每个模型都要带 `api`。
 * - `classifiers` 以 `model.api` 为键（provider-composer.js:441 `extensionClassifiers?.[model.api]`）。
 */
export function buildRegisterConfig(config: ClassifierProviderConfig): Record<string, unknown> {
  const implementation = CLASSIFIER_IMPLEMENTATIONS[config.api];

  return {
    ...(config.name ? { name: config.name } : {}),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey?.trim() || PLACEHOLDER_API_KEY,
    ...(config.headers ? { headers: config.headers } : {}),
    classifiers: { [config.api]: implementation() },
    models: config.models.map((model) => ({
      type: 'classifier' as const,
      id: model.id,
      name: model.name || model.id,
      api: config.api,
      contextWindow: model.contextWindow ?? DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
      input: model.input ?? ['text'],
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0
      }
    }))
  };
}

/** 注册单条 provider；失败时抛出（由调用方决定是否吞掉） */
export function registerClassifierProvider(
  runtime: ClassifierRuntimeLike,
  config: ClassifierProviderConfig
): void {
  runtime.registerProvider(config.key, buildRegisterConfig(config));
}

/** 撤销单条 provider 注册 */
export function unregisterClassifierProvider(runtime: ClassifierRuntimeLike, key: string): void {
  runtime.unregisterProvider(key);
}

/**
 * 启动时把 classifiers.json 里全部 provider 注册进 runtime。
 * 逐条 try/catch：一条配置有问题只记录错误，其余照常注册。
 */
export function applyClassifierProviders(runtime: ClassifierRuntimeLike): ApplyClassifierResult {
  const applied: string[] = [];
  const errors: ClassifierRegistrationError[] = [];

  const { providers } = readClassifierConfig();
  for (const config of Object.values(providers)) {
    try {
      registerClassifierProvider(runtime, config);
      applied.push(config.key);
    } catch (error) {
      errors.push({
        key: config.key,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { applied, errors };
}
