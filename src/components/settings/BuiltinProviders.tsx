/**
 * 设置页 - 模型配置 tab 的「内置供应商」区块。
 * 从 ModelsTab 拆出：state/handler/渲染自洽，仅保存/清除 key 后通知父组件刷新可用模型。
 */
import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';
import PasswordInput from '../common/PasswordInput';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface BuiltinProvidersProps {
  /** key 变化后通知父组件刷新模型选择器（ModelsTab 拉取 availableModels） */
  onAuthChanged?: () => void;
  /**
   * 只看带决策模型的供应商（设置页「决策模型」tab 复用本组件）。
   * chat 与 classifier 的模型清单在 SDK 里分开，这里用 classifierCount 过滤，
   * 避免把几十个纯聊天供应商列在决策模型页里。
   */
  onlyClassifier?: boolean;
}

export default function BuiltinProviders({
  onAuthChanged,
  onlyClassifier = false
}: BuiltinProvidersProps) {
  const [builtinProviders, setBuiltinProviders] = useState<
    Awaited<ReturnType<typeof window.pi.getBuiltinProviders>>
  >([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [editingBuiltin, setEditingBuiltin] = useState<string | null>(null);
  const [builtinApiKey, setBuiltinApiKey] = useState('');
  /** 正在从 auth.json 读取已保存的 Key（读取期间输入框显示「读取中…」） */
  const [loadingBuiltinKey, setLoadingBuiltinKey] = useState(false);
  /** 当前输入框里的值是否来自回填（用于给出「可直接修改后保存」的提示） */
  const [prefilledBuiltinKey, setPrefilledBuiltinKey] = useState(false);
  /** 正在等待回填的供应商：连续点不同供应商时，丢弃过期请求的结果 */
  const pendingKeyProviderRef = useRef<string | null>(null);
  /** 输入框当前值的镜像：异步回填落地时判断用户是否已开始输入，避免覆盖输入 */
  const keyInputValueRef = useRef('');
  const showToast = usePiStore((state) => state.showToast);
  const [refreshing, setRefreshing] = useState(false);

  const loadBuiltinProviders = async () => {
    try {
      setBuiltinProviders(await window.pi.getBuiltinProviders());
    } catch {}
  };

  /** 刷新按钮：拉取远端模型目录 + 重建鉴权快照，然后重载列表 */
  const handleRefreshProviders = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await window.pi.refreshProviders();
      if (r?.ok) {
        await loadBuiltinProviders();
        onAuthChanged?.();
      }
    } catch {}
    setRefreshing(false);
  };

  useEffect(() => {
    loadBuiltinProviders();
  }, []);

  const handleKeyInputChange = (value: string) => {
    keyInputValueRef.current = value;
    setBuiltinApiKey(value);
  };

  const closeBuiltinEdit = () => {
    pendingKeyProviderRef.current = null;
    keyInputValueRef.current = '';
    setEditingBuiltin(null);
    setBuiltinApiKey('');
    setLoadingBuiltinKey(false);
    setPrefilledBuiltinKey(false);
  };

  /**
   * 「编辑 / 取消」：展开时回填 auth.json 里已保存的 Key（不回填环境变量来源的值，
   * 避免用户顺手保存一次就把 env 值写进 auth.json；env 来源已由列表徽标标明）。
   */
  const handleToggleBuiltinEdit = async (providerId: string) => {
    if (editingBuiltin === providerId) {
      closeBuiltinEdit();
      return;
    }
    pendingKeyProviderRef.current = providerId;
    keyInputValueRef.current = '';
    setEditingBuiltin(providerId);
    setBuiltinApiKey('');
    setPrefilledBuiltinKey(false);
    setLoadingBuiltinKey(true);
    let stored = '';
    try {
      stored = await window.pi.getProviderApiKey(providerId);
    } catch {
      stored = '';
    }
    if (pendingKeyProviderRef.current !== providerId) return; // 已切到别的供应商或已收起
    pendingKeyProviderRef.current = null;
    setLoadingBuiltinKey(false);
    if (keyInputValueRef.current) return; // 读取期间用户已开始输入，别覆盖
    keyInputValueRef.current = stored;
    setBuiltinApiKey(stored);
    setPrefilledBuiltinKey(!!stored);
  };

  const handleSaveBuiltinKey = async (providerId: string) => {
    if (!builtinApiKey.trim()) return;
    try {
      await window.pi.setProviderApiKey(providerId, builtinApiKey.trim());
      showToast(t.apiKeySaved, { variant: 'success' });
      closeBuiltinEdit();
      await loadBuiltinProviders();
      onAuthChanged?.();
    } catch (e) {
      showToast(t.apiKeySaveFail(errMsg(e)), { variant: 'error' });
    }
  };

  const handleClearBuiltinKey = async (providerId: string) => {
    try {
      await window.pi.removeProviderApiKey(providerId);
      showToast(t.apiKeyCleared, { variant: 'success' });
      closeBuiltinEdit();
      await loadBuiltinProviders();
      onAuthChanged?.();
    } catch (e) {
      showToast(t.apiKeyClearFail(errMsg(e)), { variant: 'error' });
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-od-text">
            {onlyClassifier ? t.classifierBuiltinTitle : t.builtinProviders}
          </h3>
          <div className="text-xs text-od-text-dim">
            {onlyClassifier ? t.classifierBuiltinDesc : t.builtinProvidersDesc}
          </div>
        </div>
        {/* 刷新按钮 + 搜索框 */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleRefreshProviders}
            disabled={refreshing}
            className="flex items-center justify-center rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-50"
            title={t.refreshProviders}
          >
            <Icon name="rotate" spin={refreshing} className="w-3" />
          </button>
          <input
            type="text"
            value={providerSearch}
            onChange={(e) => setProviderSearch(e.target.value)}
            placeholder={t.searchProviders}
            className="w-40 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright placeholder:text-od-text-dim"
          />
        </div>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {builtinProviders.length === 0 && (
          <div className="py-2 text-xs text-od-text-dim">
            {onlyClassifier ? t.classifierNoBuiltinProviders : t.noBuiltinProviders}
          </div>
        )}
        {builtinProviders
          .filter((p) => {
            if (onlyClassifier && !(p.classifierCount ?? 0)) return false;
            const q = providerSearch.trim().toLowerCase();
            if (!q) return true;
            return p.id.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q);
          })
          .map((p) => {
            const isEditing = editingBuiltin === p.id;
            return (
              <div key={p.id} className="rounded border border-od-border bg-od-bg-alt px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-od-text-bright">{p.name || p.id}</span>
                      <span
                        className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${
                          p.authConfigured
                            ? 'bg-od-accent/20 text-od-accent'
                            : 'bg-od-bg-hover text-od-text-dim'
                        }`}
                      >
                        {p.authConfigured ? t.authConfigured : t.authNotConfigured}
                        {p.authSource === 'environment' && ` · ${t.authSourceEnv}`}
                        {p.authSource === 'stored' && ` · ${t.authSourceStored}`}
                        {p.authSource === 'runtime' && ` · ${t.authSourceRuntime}`}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-od-text-dim">
                      <span className="shrink-0 font-mono">{p.id}</span>
                      {p.baseUrl && <span className="min-w-0 truncate font-mono">{p.baseUrl}</span>}
                      <span className="shrink-0">
                        ·{' '}
                        {onlyClassifier
                          ? t.classifierProviderModelCount(p.classifierCount ?? 0)
                          : t.providerModelCount(p.modelCount)}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleToggleBuiltinEdit(p.id)}
                      className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                        isEditing
                          ? 'bg-od-bg-hover text-od-text'
                          : 'text-od-text hover:bg-od-bg-hover'
                      }`}
                    >
                      <Icon name="edit2" className="w-3" />
                      {isEditing ? t.cancel : t.edit}
                    </button>
                    {p.authConfigured && (
                      <button
                        onClick={() => handleClearBuiltinKey(p.id)}
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-red hover:bg-od-red/20"
                      >
                        <Icon name="close" size="xs" />
                        {t.clearApiKey}
                      </button>
                    )}
                  </div>
                </div>
                {isEditing && (
                  <div className="mt-2 flex gap-1">
                    <PasswordInput
                      value={builtinApiKey}
                      onChange={(e) => handleKeyInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveBuiltinKey(p.id);
                      }}
                      placeholder={loadingBuiltinKey ? t.apiKeyLoading : t.apiKeyInputPlaceholder}
                      className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1 pr-7 text-xs text-od-text-bright"
                      autoFocus
                    />
                    <button
                      onClick={() => handleSaveBuiltinKey(p.id)}
                      disabled={!builtinApiKey.trim()}
                      className="rounded bg-od-accent px-2 py-1 text-xs text-white hover:bg-od-accent/80 disabled:opacity-40"
                    >
                      {t.saveApiKey}
                    </button>
                    {prefilledBuiltinKey && (
                      <span className="shrink-0 self-center text-xs text-od-text-dim">
                        {t.apiKeyPrefilled}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
