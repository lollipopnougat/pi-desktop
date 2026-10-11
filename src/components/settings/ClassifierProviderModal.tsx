import { useState } from 'react';
import Icon from '../common/Icon';
import PasswordInput from '../common/PasswordInput';
import ConfirmDialog from '../common/ConfirmDialog';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { ClassifierApiKind } from '../../types/pi';

/** 表单内的模型行（含仅 UI 使用的 name 字段） */
interface FormModel {
  id: string;
  name: string;
  contextWindow: number;
}

interface FormState {
  key: string;
  name: string;
  baseUrl: string;
  api: ClassifierApiKind;
  apiKey: string;
  models: FormModel[];
}

interface ClassifierProviderModalProps {
  /** 正在编辑的 provider key（null = 新增） */
  editingKey: string | null;
  initialForm: FormState;
  defaultContextWindow: number;
  onClose: () => void;
  onSave: (form: FormState) => Promise<string | null>;
}

const API_OPTIONS: { value: ClassifierApiKind; label: string; hint: string }[] = [
  {
    value: 'typesafe-system-one',
    label: t.classifierApiSystemOne,
    hint: t.classifierApiSystemOneHint
  },
  {
    value: 'llama-cpp-classify',
    label: t.classifierApiLlamaCpp,
    hint: t.classifierApiLlamaCppHint
  }
];

/**
 * 新增/编辑自定义决策模型端点弹窗。
 *
 * 决策模型不能写进 models.json（SDK schema 无 type/classifiers 字段），
 * 由主进程写到 ~/.pi-desktop/classifiers.json 并调用 ModelRuntime.registerProvider 注册。
 * 表单里的 apiKey 可留空：本地 llama.cpp 未用 --api-key 启动时不需要凭据。
 */
export default function ClassifierProviderModal({
  editingKey,
  initialForm,
  defaultContextWindow,
  onClose,
  onSave
}: ClassifierProviderModalProps) {
  const isMac = window.pi?.platform === 'darwin';
  const [form, setForm] = useState<FormState>(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const showToast = usePiStore((state) => state.showToast);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isNew = editingKey === null;

  const updateModel = (index: number, patch: Partial<FormModel>) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((m, i) => (i === index ? { ...m, ...patch } : m))
    }));
  };

  const addModel = () => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, { id: '', name: '', contextWindow: defaultContextWindow }]
    }));
  };

  const removeModel = (index: number) => {
    setForm((prev) => ({ ...prev, models: prev.models.filter((_, i) => i !== index) }));
  };

  /** 从端点拉取模型清单（llama.cpp /v1/models 会带 n_ctx 与 output_modalities） */
  const handleFetchModels = async () => {
    if (!form.baseUrl.trim()) {
      showToast(t.classifierBaseUrlRequired, { variant: 'warning' });
      return;
    }
    setFetching(true);
    try {
      const result = await window.pi.fetchClassifierModels(
        form.baseUrl.trim(),
        form.apiKey || undefined
      );
      if (!result.ok) {
        showToast(t.classifierFetchFailed(result.error ?? t.classifierFetchUnknownError), {
          variant: 'error'
        });
        return;
      }
      if (result.models.length === 0) {
        showToast(t.classifierFetchEmpty, { variant: 'warning' });
        return;
      }

      // 合并：已存在的 id 保留用户填的名称/上下文窗口，只补新模型
      const existing = new Map(form.models.filter((m) => m.id).map((m) => [m.id, m]));
      const merged: FormModel[] = result.models.map((m) => {
        const prev = existing.get(m.id);
        return {
          id: m.id,
          name: prev?.name ?? '',
          contextWindow: prev?.contextWindow ?? m.contextWindow ?? defaultContextWindow
        };
      });
      setForm((prev) => ({ ...prev, models: merged }));

      const nativeCount = result.models.filter((m) => m.nativeDecisions).length;
      const hint =
        result.models[0]?.nativeDecisions === undefined
          ? ''
          : nativeCount > 0
            ? t.classifierFetchNativeHint(nativeCount)
            : t.classifierFetchNoNativeHint;
      showToast(`${t.classifierFetchOK(result.models.length)}${hint}`, { variant: 'success' });
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!form.key.trim()) {
      setError(t.classifierKeyRequired);
      return;
    }
    if (!form.baseUrl.trim()) {
      setError(t.classifierBaseUrlRequired);
      return;
    }
    const models = form.models.filter((m) => m.id.trim());
    if (models.length === 0) {
      setError(t.classifierModelRequired);
      return;
    }

    setSaving(true);
    try {
      const message = await onSave({
        ...form,
        key: form.key.trim(),
        baseUrl: form.baseUrl.trim(),
        models
      });
      if (message) {
        // 三个必填校验仍留在表单内联（指向具体字段），这里的 message 是保存失败 → toast
        showToast(message, { variant: 'error' });
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  /** 关闭前拦一下未保存的改动 */
  const handleClose = () => {
    const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // 宽度不写进 base：模型行里要与 flex-1 / 固定宽度组合，
  // 同时出现 w-full 和 w-32/w-24 时 Tailwind 的层叠顺序不可控（w-full 在后会胜出）
  const inputBase =
    'rounded border border-od-border bg-od-bg px-2 py-1.5 text-xs text-od-text placeholder:text-od-text-dim focus:border-od-accent focus:outline-none';
  const inputClass = `${inputBase} w-full`;
  const labelClass = 'mb-1 block text-xs text-od-text-dim';
  // 模型行的列宽常量：表头与每行输入框共用，避免两处宽度写不一致而对不齐
  const MODEL_NAME_WIDTH = 'w-36';
  const MODEL_CTX_WIDTH = 'w-24';
  // 删除按钮约占宽度：px-1(0.5rem) + 图标 w-3(0.75rem) = w-5
  const MODEL_DEL_WIDTH = 'w-5';

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex flex-col items-center bg-black/60"
        style={{ paddingTop: isMac ? 38 : 32 }}
        onClick={handleClose}
      >
        <div
          className="flex min-h-0 w-[min(48rem,90vw)] flex-1 flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-od-border px-4 py-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
              <Icon name="classifier" className="w-3.5 text-od-accent" />
              {isNew ? t.classifierAddProvider : t.classifierEditProvider}
            </h2>
            <button onClick={handleClose} className="text-od-text-dim hover:text-od-text-bright">
              <Icon name="close" size="sm" />
            </button>
          </div>

          {/* Body（可滚动） */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>{t.classifierProviderKey}</label>
                <input
                  className={inputClass}
                  value={form.key}
                  disabled={!isNew}
                  placeholder="local-llama-classifier"
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                />
                {isNew && (
                  <div className="mt-1 text-[0.7rem] text-od-text-dim">
                    {t.classifierProviderKeyHint}
                  </div>
                )}
              </div>
              <div>
                <label className={labelClass}>{t.displayName}</label>
                <input
                  className={inputClass}
                  value={form.name}
                  placeholder={t.classifierProviderNamePh}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label className={labelClass}>{t.classifierBaseUrl}</label>
              <input
                className={inputClass}
                value={form.baseUrl}
                placeholder="http://127.0.0.1:8080/v1"
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
              <div className="mt-1 text-[0.7rem] text-od-text-dim">{t.classifierBaseUrlHint}</div>
            </div>

            <div>
              <label className={labelClass}>{t.classifierApi}</label>
              <div className="flex gap-1">
                {API_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    title={option.hint}
                    onClick={() => setForm({ ...form, api: option.value })}
                    className={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${
                      form.api === option.value
                        ? 'border-od-accent bg-od-accent/15 text-od-accent'
                        : 'border-od-border bg-od-bg text-od-text-dim hover:bg-od-bg-hover'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[0.7rem] text-od-text-dim">{t.classifierApiHint}</div>
            </div>

            <div>
              <label className={labelClass}>{t.classifierApiKeyOptional}</label>
              <div className="flex items-center gap-2">
                <PasswordInput
                  className={inputClass}
                  value={form.apiKey}
                  placeholder="local"
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </div>
              <div className="mt-1 text-[0.7rem] text-od-text-dim">{t.classifierApiKeyHint}</div>
            </div>

            {/* 模型列表 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className={`${labelClass} mb-0`}>{t.classifierModels}</label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={fetching}
                    className="flex items-center gap-1 rounded bg-od-bg px-2 py-1 text-xs text-od-text transition-colors hover:bg-od-bg-hover disabled:opacity-50"
                  >
                    <Icon name={fetching ? 'spinner' : 'refresh'} className="w-3" />
                    {fetching ? t.classifierFetching : t.classifierFetchModels}
                  </button>
                  <button
                    type="button"
                    onClick={addModel}
                    className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
                  >
                    <Icon name="plus" className="w-3" />
                    {t.classifierAddModel}
                  </button>
                </div>
              </div>

              {form.models.length === 0 ? (
                <div className="rounded border border-od-border bg-od-bg px-3 py-2 text-xs text-od-text-dim">
                  {t.classifierNoModelsYet(t.classifierFetchModels)}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    {/* 列标题：与下方每行输入框同宽对齐 */}
                    <div className="flex items-center gap-2 border border-transparent px-2 text-[0.7rem] text-od-text-dim">
                      <div className="min-w-0 flex-1">{t.classifierModelIdCol}</div>
                      <div className={`${MODEL_NAME_WIDTH} shrink-0`}>
                        {t.classifierModelNameCol}
                      </div>
                      <div className={`${MODEL_CTX_WIDTH} shrink-0`}>
                        {t.classifierContextWindow}
                      </div>
                      <div className={`${MODEL_DEL_WIDTH} shrink-0`} />
                    </div>

                    {form.models.map((model, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 rounded border border-od-border bg-od-bg px-2 py-1.5"
                      >
                        <input
                          className={`${inputBase} min-w-0 flex-1`}
                          value={model.id}
                          placeholder={t.classifierModelIdPh}
                          onChange={(e) => updateModel(index, { id: e.target.value })}
                        />
                        <input
                          className={`${inputBase} ${MODEL_NAME_WIDTH} shrink-0`}
                          value={model.name}
                          placeholder={t.classifierModelNamePh}
                          title={t.classifierModelNameHint}
                          onChange={(e) => updateModel(index, { name: e.target.value })}
                        />
                        <input
                          className={`${inputBase} ${MODEL_CTX_WIDTH} shrink-0`}
                          type="number"
                          min={1}
                          value={model.contextWindow}
                          title={t.classifierContextWindow}
                          onChange={(e) =>
                            updateModel(index, {
                              contextWindow: Number(e.target.value) || defaultContextWindow
                            })
                          }
                        />
                        <button
                          type="button"
                          onClick={() => removeModel(index)}
                          className="shrink-0 rounded px-1 py-0.5 text-od-red transition-colors hover:bg-od-red/20"
                          title={t.remove}
                        >
                          <Icon name="delete" className="w-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="mt-2 text-[0.7rem] leading-relaxed text-od-text-dim">
                    {t.classifierModelFieldsHint}
                  </div>
                </>
              )}
            </div>

            {error && (
              <div className="rounded border border-od-red/30 bg-od-red/10 px-3 py-2 text-xs text-od-red">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-od-border px-4 py-2">
            <button
              onClick={handleClose}
              className="rounded px-3 py-1.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            >
              {t.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-od-accent/20 px-3 py-1.5 text-xs text-od-accent transition-colors hover:bg-od-accent/30 disabled:opacity-50"
            >
              <Icon name={saving ? 'spinner' : 'save'} className="w-3" />
              {t.classifierSaveProvider}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title={t.classifierDiscardTitle}
        message={t.classifierDiscardMessage}
        danger
        confirmText={t.classifierDiscardConfirm}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onClose={() => setConfirmDiscard(false)}
      />
    </>
  );
}
