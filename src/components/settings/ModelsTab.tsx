import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import ConfirmDialog from '../common/ConfirmDialog';
import { t } from '../../i18n/zh';
import { type Provider } from '../../types/shared';
import BuiltinProviders from './BuiltinProviders';
import ProviderModal from './ProviderModal';

/** 新增 provider 时的空表单 */
const EMPTY_FORM: Provider = {
  key: '',
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKey: '',
  authHeader: false,
  models: []
};

/**
 * 设置页 - 模型配置 tab：内置供应商 + 自定义 Provider（含 /v1/models 拉取）。
 * 新增/编辑 Provider 走 ProviderModal 弹窗（表单较长，弹窗内滚动更直观）。
 */
export default function ModelsTab() {
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  /** 弹窗状态：null = 关闭；否则为 { 编辑的 key（null = 新增）, 初始表单 } */
  const [modal, setModal] = useState<{
    editingKey: string | null;
    initialForm: Provider;
  } | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const showToast = usePiStore((state) => state.showToast);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    const cfg = await window.pi.getProviders();
    setProviders(cfg.providers || {});
  };

  const refreshAvailableModels = async () => {
    const models = await window.pi.getAvailableModels();
    usePiStore.getState().setAvailableModels(models);
  };

  /** ProviderModal 的保存回调：写盘 + 刷新列表，随后由弹窗自行关闭 */
  const handleSave = async (form: Provider) => {
    const hasApiKey = !!form.apiKey;
    await window.pi.saveProvider(form);
    if (form.apiKey) {
      await window.pi.setApiKey(form.key, form.apiKey);
    }
    await loadProviders();
    // 刷新模型选择器的可用模型列表
    await refreshAvailableModels();
    setModal(null);
    // 没填 API Key 时提示（原先是在 provider 列表区域内联 5s 后自动消失，现统一走 toast）
    if (!hasApiKey) {
      showToast(t.providerSavedNoKey, { variant: 'warning' });
    }
  };

  const handleRemove = async (key: string) => {
    await window.pi.removeProvider(key);
    await loadProviders();
    await refreshAvailableModels();
  };

  const handleEdit = (key: string) => {
    const p = providers[key];
    setModal({
      editingKey: key,
      initialForm: {
        key,
        name: p.name || '',
        baseUrl: p.baseUrl || '',
        api: p.api || 'openai-completions',
        apiKey: p.apiKey || '',
        authHeader: p.authHeader ?? false,
        models: p.models || []
      }
    });
  };

  const providerKeys = Object.keys(providers);

  return (
    <>
      {/* 内置供应商 section */}
      <BuiltinProviders onAuthChanged={refreshAvailableModels} />

      {/* 自定义 Provider section */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-od-text">{t.providers}</h3>
          <button
            onClick={() => setModal({ editingKey: null, initialForm: { ...EMPTY_FORM } })}
            className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
          >
            <Icon name="plus" className="w-3" />
            {t.addProvider}
          </button>
        </div>

        <div className="space-y-1">
          {providerKeys.length === 0 && (
            <div className="text-xs text-od-text-dim py-2">{t.noProviders}</div>
          )}
          {providerKeys.map((key) => {
            const p = providers[key];
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2"
              >
                <div>
                  <div className="text-sm text-od-text-bright">
                    {p.name || key}
                    {!p.apiKey && (
                      <span className="ml-2 rounded bg-od-yellow/20 px-1.5 py-0.5 text-xs text-od-yellow">
                        {t.providerNoKey}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-od-text-dim">
                    {p.baseUrl} · {p.api} · {p.models?.length || 0} models
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleEdit(key)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-text hover:bg-od-bg-hover"
                  >
                    <Icon name="edit2" className="w-3" />
                    {t.edit}
                  </button>
                  <button
                    onClick={() => setRemovingKey(key)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-red hover:bg-od-red/20"
                  >
                    <Icon name="delete" className="w-3" />
                    {t.remove}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 新增/编辑 Provider 弹窗 */}
      {modal && (
        <ProviderModal
          editingProvider={modal.editingKey}
          initialForm={modal.initialForm}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!removingKey}
        title={t.removeProviderTitle}
        message={t.removeProviderConfirm(removingKey || '')}
        danger
        confirmText={t.remove}
        onConfirm={() => {
          const key = removingKey;
          setRemovingKey(null);
          if (key) handleRemove(key);
        }}
        onClose={() => setRemovingKey(null)}
      />
    </>
  );
}
