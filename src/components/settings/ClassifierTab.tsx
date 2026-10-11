import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../common/Icon';
import Dropdown from '../common/Dropdown';
import ConfirmDialog from '../common/ConfirmDialog';
import JsonEditor from '../common/JsonEditor';
import { t } from '../../i18n/zh';
import ClassifierProviderModal from './ClassifierProviderModal';
import BuiltinProviders from './BuiltinProviders';
import type {
  ClassifierAnswer,
  ClassifierApiKind,
  ClassifierModelInfo,
  ClassifierProviderConfig,
  ClassifierQuestion,
  ClassifyResult
} from '../../types/pi';

/** 表单状态（与 ClassifierProviderModal 共用） */
interface FormState {
  key: string;
  name: string;
  baseUrl: string;
  api: ClassifierApiKind;
  apiKey: string;
  models: { id: string; name: string; contextWindow: number }[];
}

const EMPTY_FORM: FormState = {
  key: '',
  name: '',
  baseUrl: '',
  api: 'typesafe-system-one',
  apiKey: '',
  models: []
};

/**
 * 设置页 - 决策模型 tab。
 *
 * 四个区块：
 * 1. 可用决策模型（凭据已就绪的模型 + 自定义端点注册进来的）
 * 2. 内置决策模型供应商（填 API Key；仅列出带 classifier 模型的供应商）
 * 3. 试跑面板（选模型 → 编辑 state/questions → classify）
 * 4. 自定义决策模型端点管理（~/.pi-desktop/classifiers.json）
 *
 * 决策模型不支持 stream，也不出现在模型选择器里；调用入口只有 classify()。
 */
export default function ClassifierTab() {
  const [models, setModels] = useState<ClassifierModelInfo[]>([]);
  const [providers, setProviders] = useState<ClassifierProviderConfig[]>([]);
  const [configPath, setConfigPath] = useState('');
  const [logPath, setLogPath] = useState<{ dir: string; file: string; enabled: boolean } | null>(
    null
  );
  const [defaultContextWindow, setDefaultContextWindow] = useState(32768);
  const [loading, setLoading] = useState(true);
  const [registerErrors, setRegisterErrors] = useState<{ key: string; message: string }[]>([]);

  const [selected, setSelected] = useState('');
  const [stateText, setStateText] = useState(t.classifierDefaultState);
  const [questionsText, setQuestionsText] = useState(t.classifierDefaultQuestions);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ClassifyResult | null>(null);

  const [modal, setModal] = useState<{ editingKey: string | null; form: FormState } | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  /** 「选为试跑模型」点击后滚动到这里（否则已是当前目标时点击看不出变化） */
  const playgroundRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [modelList, providerList, logPaths] = await Promise.all([
        window.pi.getClassifierModels(),
        window.pi.getClassifierProviders(),
        window.pi.getClassifierLogPath()
      ]);
      setModels(modelList.models ?? []);
      setRegisterErrors(modelList.errors?.length ? modelList.errors : (providerList.errors ?? []));
      setProviders(providerList.providers ?? []);
      setConfigPath(providerList.path ?? '');
      setLogPath(logPaths ?? null);
      setDefaultContextWindow(providerList.defaultContextWindow ?? 32768);

      // 默认选中第一个可用模型；当前选中项失效时回退
      const available = (modelList.models ?? []).filter((m) => m.available);
      setSelected((prev) => {
        const stillValid = prev && available.some((m) => `${m.provider}/${m.id}` === prev);
        return stillValid
          ? prev
          : available[0]
            ? `${available[0].provider}/${available[0].id}`
            : '';
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const availableModels = useMemo(() => models.filter((m) => m.available), [models]);

  const selectedModel = useMemo(
    () => availableModels.find((m) => `${m.provider}/${m.id}` === selected),
    [availableModels, selected]
  );

  /** 按供应商分组展示已就绪（凭据已配）的模型 */
  const grouped = useMemo(() => {
    const map = new Map<string, ClassifierModelInfo[]>();
    for (const model of availableModels) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [availableModels]);

  /** 解析两段 JSON 并调用 classify */
  const handleRun = async () => {
    if (!selectedModel) return;
    setResult(null);

    let parsedState: unknown;
    let parsedQuestions: unknown;
    try {
      parsedState = JSON.parse(stateText);
    } catch (err: any) {
      setResult({
        provider: selectedModel.provider,
        model: selectedModel.id,
        answers: {},
        stopReason: 'error',
        errorMessage: t.classifierInvalidJson(t.classifierStateLabel, String(err?.message ?? err)),
        timestamp: Date.now()
      });
      return;
    }
    if (typeof parsedState !== 'object' || parsedState === null || Array.isArray(parsedState)) {
      setResult({
        provider: selectedModel.provider,
        model: selectedModel.id,
        answers: {},
        stopReason: 'error',
        errorMessage: t.classifierStateRequired,
        timestamp: Date.now()
      });
      return;
    }
    try {
      parsedQuestions = JSON.parse(questionsText);
    } catch (err: any) {
      setResult({
        provider: selectedModel.provider,
        model: selectedModel.id,
        answers: {},
        stopReason: 'error',
        errorMessage: t.classifierInvalidJson(
          t.classifierQuestionsLabel,
          String(err?.message ?? err)
        ),
        timestamp: Date.now()
      });
      return;
    }
    if (
      typeof parsedQuestions !== 'object' ||
      parsedQuestions === null ||
      Array.isArray(parsedQuestions)
    ) {
      setResult({
        provider: selectedModel.provider,
        model: selectedModel.id,
        answers: {},
        stopReason: 'error',
        errorMessage: t.classifierQuestionsRequired,
        timestamp: Date.now()
      });
      return;
    }

    setRunning(true);
    try {
      const response = await window.pi.classify({
        provider: selectedModel.provider,
        id: selectedModel.id,
        state: parsedState as Record<string, unknown>,
        questions: parsedQuestions as Record<string, ClassifierQuestion>
      });
      setResult(response);
    } finally {
      setRunning(false);
    }
  };

  const openAddModal = () => {
    setModal({ editingKey: null, form: { ...EMPTY_FORM } });
  };

  const openEditModal = (provider: ClassifierProviderConfig) => {
    setModal({
      editingKey: provider.key,
      form: {
        key: provider.key,
        name: provider.name ?? '',
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKey: provider.apiKey ?? '',
        models: provider.models.map((m) => ({
          id: m.id,
          name: m.name ?? '',
          contextWindow: m.contextWindow ?? defaultContextWindow
        }))
      }
    });
  };

  /** 保存端点：返回错误文案（null = 成功） */
  const handleSaveProvider = async (form: FormState): Promise<string | null> => {
    const response = await window.pi.saveClassifierProvider({
      key: form.key,
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      baseUrl: form.baseUrl,
      api: form.api,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      models: form.models
        .filter((m) => m.id.trim())
        .map((m) => ({
          id: m.id.trim(),
          ...(m.name.trim() ? { name: m.name.trim() } : {}),
          contextWindow: m.contextWindow
        }))
    });
    if (!response.ok) return response.error ?? t.classifierSaveFailed;
    await load();
    return null;
  };

  const handleRemoveProvider = async (key: string) => {
    await window.pi.removeClassifierProvider(key);
    await load();
  };

  /** 答案渲染：按 type 分支 */
  const renderAnswer = (answer: ClassifierAnswer | undefined) => {
    if (!answer) {
      return <span className="text-od-red">{t.classifierNoAnswer}</span>;
    }
    if (answer.type === 'choice') {
      const entries = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
      return (
        <div className="space-y-1">
          <div className="text-sm text-od-text-bright">
            {answer.choice}
            <span className="ml-2 text-xs text-od-text-dim">
              置信度 {(answer.confidence ?? 0).toFixed(3)}
            </span>
          </div>
          <div className="space-y-0.5">
            {entries.map(([label, probability]) => (
              <div key={label} className="flex items-center gap-2">
                <div className="w-32 shrink-0 truncate text-xs text-od-text-dim" title={label}>
                  {label}
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-od-bg">
                  <div
                    className="h-full rounded-full bg-od-accent"
                    style={{ width: `${Math.max(0, Math.min(1, probability)) * 100}%` }}
                  />
                </div>
                <div className="w-14 shrink-0 text-right text-xs text-od-text-dim">
                  {probability.toFixed(4)}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (answer.type === 'score') {
      return (
        <div className="text-sm text-od-text-bright">
          {answer.score?.toFixed(3)}
          <span className="ml-2 text-xs text-od-text-dim">
            置信度 {(answer.confidence ?? 0).toFixed(3)}
          </span>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <div className="text-sm text-od-text-bright">
          {(answer.probability ?? 0) >= 0.5 ? 'true' : 'false'}
          <span className="ml-2 text-xs text-od-text-dim">
            P(true) = {(answer.probability ?? 0).toFixed(4)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-od-bg">
          <div
            className="h-full rounded-full bg-od-accent"
            style={{ width: `${(answer.probability ?? 0) * 100}%` }}
          />
        </div>
      </div>
    );
  };

  const usage = result?.usage as { input?: number; output?: number } | undefined;

  return (
    <>
      {/* 说明 */}
      <div className="mb-4 rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
        {t.classifierDesc}
      </div>

      {/* 调用日志：每次判定（权限闸门自动调用 + 试跑）都把请求参数与返回写成一行 JSON */}
      {logPath && (
        <div className="mb-4 flex items-center gap-2 rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
          <Icon
            name={logPath.enabled ? 'file' : 'warning'}
            className={`w-3 shrink-0 ${logPath.enabled ? '' : 'text-od-yellow'}`}
          />
          <span className="min-w-0 flex-1 truncate" title={logPath.file}>
            {logPath.enabled
              ? t.classifierLogHint(logPath.dir)
              : t.classifierLogHintDisabled(logPath.dir)}
          </span>
          <button
            type="button"
            onClick={() => window.pi.openWith(logPath.dir, 'default')}
            className="flex shrink-0 items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent hover:bg-od-accent/25"
          >
            <Icon name="folder" className="w-3" />
            {t.classifierOpenLogDir}
          </button>
        </div>
      )}
      {/* 注册错误 */}
      {registerErrors.length > 0 && (
        <div className="mb-4 space-y-1 rounded border border-od-red/30 bg-od-red/10 px-3 py-2">
          {registerErrors.map((err, index) => (
            <div key={`${err.key}-${index}`} className="text-xs text-od-red">
              <span className="font-semibold">{err.key}</span> 注册失败：{err.message}
            </div>
          ))}
        </div>
      )}

      {/* === 可用决策模型 === */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.classifierAvailable}</h3>

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-od-text-dim">
            <Icon name="spinner" className="w-3" />
            {t.classifierLoading}
          </div>
        ) : availableModels.length === 0 ? (
          <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
            <div>{t.classifierAvailableEmpty}</div>
            <div className="mt-1">{t.classifierNoModelsHint}</div>
          </div>
        ) : (
          <div className="space-y-2">
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div className="mb-1 flex items-center gap-2 text-xs text-od-text-dim">
                  <span className="text-od-text">{list[0]?.providerName ?? provider}</span>
                  <span className="text-od-text-dim">{provider}</span>
                  {list[0]?.custom && (
                    <span className="rounded bg-od-accent/20 px-1.5 py-0.5 text-[0.7rem] text-od-accent">
                      {t.classifierCustom}
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {list.map((model) => (
                    <div
                      key={`${model.provider}/${model.id}`}
                      className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm text-od-text-bright">
                          <span className="truncate" title={model.id}>
                            {model.name}
                          </span>
                          <span className="shrink-0 rounded bg-od-bg px-1.5 py-0.5 text-[0.7rem] text-od-text-dim">
                            {model.apiLabel}
                          </span>
                        </div>
                        <div className="truncate text-xs text-od-text-dim" title={model.id}>
                          {model.id}
                          {model.contextWindow
                            ? ` · ${model.contextWindow.toLocaleString()} tokens`
                            : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          // 这只是「选为试跑对象」：设定面板目标模型并清掉上次结果，
                          // 真正的执行是面板里的「运行分类」。点击后滚动到试跑面板，
                          // 否则当它已是当前目标时点击看不出任何变化（看起来像无效按钮）。
                          setSelected(`${model.provider}/${model.id}`);
                          setResult(null);
                          playgroundRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                          });
                        }}
                        title={t.classifierSelectForPlaygroundHint}
                        className={`shrink-0 rounded px-2 py-0.5 text-xs transition-colors ${
                          selected === `${model.provider}/${model.id}`
                            ? 'bg-od-accent/20 text-od-accent'
                            : 'text-od-text hover:bg-od-bg-hover'
                        }`}
                      >
                        {t.classifierSelectForPlayground}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* === 试跑 === */}
      <div ref={playgroundRef} className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-od-text">{t.classifierPlayground}</h3>
          <button
            onClick={() => {
              setStateText(t.classifierDefaultState);
              setQuestionsText(t.classifierDefaultQuestions);
              setResult(null);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            <Icon name="retry" className="w-3" />
            {t.classifierResetTemplate}
          </button>
        </div>

        <div className="rounded border border-od-border bg-od-bg-alt p-3">
          <div className="mb-3 flex items-center gap-2">
            <span className="shrink-0 text-xs text-od-text-dim">模型</span>
            <div className="min-w-0 flex-1">
              <Dropdown
                value={selected}
                onChange={(value) => {
                  setSelected(value);
                  setResult(null);
                }}
                disabled={availableModels.length === 0}
                placeholder={
                  availableModels.length === 0 ? t.classifierNoModels : t.classifierSelectModel
                }
                options={availableModels.map((model) => ({
                  value: `${model.provider}/${model.id}`,
                  label: model.name,
                  hint: `${model.provider}/${model.id}`
                }))}
              />
            </div>
            <button
              onClick={handleRun}
              disabled={running || !selectedModel}
              className="flex shrink-0 items-center gap-1 rounded bg-od-accent/20 px-3 py-1.5 text-xs text-od-accent transition-colors hover:bg-od-accent/30 disabled:opacity-50"
            >
              <Icon name={running ? 'spinner' : 'continue'} className="w-3" />
              {running ? t.classifierRunning : t.classifierRun}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-od-text-dim">
                {t.classifierStateLabel}
              </label>
              <JsonEditor
                value={stateText}
                onChange={setStateText}
                ariaLabel={t.classifierStateLabel}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-od-text-dim">
                {t.classifierQuestionsLabel}
              </label>
              <JsonEditor
                value={questionsText}
                onChange={setQuestionsText}
                ariaLabel={t.classifierQuestionsLabel}
              />
            </div>
          </div>

          {/* 结果 */}
          <div className="mt-3 border-t border-od-border pt-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-od-text">{t.classifierResult}</span>
              {result && (
                <>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[0.7rem] ${
                      result.stopReason === 'stop'
                        ? 'bg-od-green/20 text-od-green'
                        : 'bg-od-red/20 text-od-red'
                    }`}
                  >
                    {result.stopReason}
                  </span>
                  <span className="text-xs text-od-text-dim">
                    {result.provider}/{result.model}
                  </span>
                  {usage && (usage.input !== undefined || usage.output !== undefined) && (
                    <span className="text-xs text-od-text-dim">
                      {t.classifierUsage(usage.input ?? 0, usage.output ?? 0)}
                    </span>
                  )}
                </>
              )}
            </div>

            {!result ? (
              <div className="py-2 text-xs text-od-text-dim">{t.classifierNoResult}</div>
            ) : result.errorMessage ? (
              <div className="whitespace-pre-wrap rounded border border-od-red/30 bg-od-red/10 px-3 py-2 text-xs text-od-red">
                {result.errorMessage}
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(result.answers).map(([id, answer]) => (
                  <div key={id} className="rounded border border-od-border bg-od-bg px-3 py-2">
                    <div className="mb-1 text-xs text-od-text-dim">{id}</div>
                    {renderAnswer(answer)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* === 内置供应商（填 Key 启用官方决策模型） === */}
      <BuiltinProviders onlyClassifier onAuthChanged={load} />

      {/* === 自定义端点 === */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-od-text">{t.classifierCustomProviders}</h3>
          <button
            onClick={openAddModal}
            className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
          >
            <Icon name="plus" className="w-3" />
            {t.classifierAddProvider}
          </button>
        </div>

        <div className="space-y-1">
          {providers.length === 0 && (
            <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
              {t.classifierNoCustomProviders}
            </div>
          )}
          {providers.map((provider) => (
            <div
              key={provider.key}
              className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-od-text-bright">
                  <span className="truncate">{provider.name || provider.key}</span>
                  {!provider.apiKey && (
                    <span className="shrink-0 rounded bg-od-bg px-1.5 py-0.5 text-[0.7rem] text-od-text-dim">
                      {t.classifierApiKeyOptional}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-od-text-dim">
                  {provider.baseUrl} · {provider.api} · {provider.models.length} models
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => openEditModal(provider)}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-text hover:bg-od-bg-hover"
                >
                  <Icon name="edit2" className="w-3" />
                  {t.edit}
                </button>
                <button
                  onClick={() => setRemovingKey(provider.key)}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-red hover:bg-od-red/20"
                >
                  <Icon name="delete" className="w-3" />
                  {t.remove}
                </button>
              </div>
            </div>
          ))}
        </div>

        {configPath && (
          <div className="mt-2 text-[0.7rem] text-od-text-dim">
            {t.classifierConfigPath(configPath)}
          </div>
        )}
      </div>

      {/* 新增/编辑端点弹窗 */}
      {modal && (
        <ClassifierProviderModal
          editingKey={modal.editingKey}
          initialForm={modal.form}
          defaultContextWindow={defaultContextWindow}
          onClose={() => setModal(null)}
          onSave={handleSaveProvider}
        />
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!removingKey}
        title={t.classifierRemoveProvider}
        message={t.classifierRemoveProviderConfirm(removingKey || '')}
        danger
        confirmText={t.remove}
        onConfirm={() => {
          const key = removingKey;
          setRemovingKey(null);
          if (key) handleRemoveProvider(key);
        }}
        onClose={() => setRemovingKey(null)}
      />
    </>
  );
}
