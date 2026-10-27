import { useCallback, useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type {
  WebSearchConfig,
  WebSearchConfigPayload,
  WebSearchProviderSetting,
  WebSearchTestResult
} from '../../types/pi';

/** 每次返回条数的可选项（与主进程的 clamp 上限 20 对齐） */
const COUNT_OPTIONS = [5, 8, 12, 20];

/**
 * 设置页 - 智能体配置 tab：内置网络搜索
 *
 * 开关 + 搜索源 + 每次条数 + 自建 SearXNG 地址 + 「测试搜索」。
 * 配置落 `~/.pi-desktop/web-search.json`，工具每次执行前读一次 → 改动即时生效；
 * 开关变化还会经 `applyWebSearchConfig()` 立刻在所有会话槽上注入/移除 web_search 工具。
 *
 * 全部搜索源都免 Key：默认 auto 模式下按 Parallel → Bing → Brave → 360 → SearXNG
 * 顺序自动降级，用户什么都不用配就能用。
 */
export default function WebSearchSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [payload, setPayload] = useState<WebSearchConfigPayload | null>(null);
  const [config, setConfig] = useState<WebSearchConfig | null>(null);
  const [searxngInput, setSearxngInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.pi?.webSearch.getConfig();
        if (cancelled || !res) return;
        setPayload(res);
        setConfig(res.config);
        setSearxngInput(res.config.searxngBaseUrl);
      } catch {
        // 读配置失败：保持加载态，不显示开关
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 提交单个字段（成功后回填主进程归一化的结果） */
  const save = async (patch: Partial<WebSearchConfig>) => {
    if (saving) return false;
    setSaving(true);
    try {
      const res = await window.pi?.webSearch.setConfig(patch);
      if (!res || !res.ok) throw new Error(res?.error || t.webSearchSaveFailed);
      if (res.config) {
        setConfig(res.config);
        // 只回填本次改的字段，避免覆盖用户正在编辑的输入框
        if ('searxngBaseUrl' in patch) setSearxngInput(res.config.searxngBaseUrl);
      }
      showToast(t.webSearchSaved, { variant: 'success' });
      return true;
    } catch (e: any) {
      showToast(e?.message || t.webSearchSaveFailed, { variant: 'error' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** SearXNG 地址失焦/回车提交；未改动则不写盘 */
  const commitSearxng = async () => {
    if (!config || searxngInput.trim() === config.searxngBaseUrl) return;
    await save({ searxngBaseUrl: searxngInput });
  };

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.pi?.webSearch.test();
      setTestResult(res ?? { ok: false, error: t.webSearchTestEmpty });
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setTesting(false);
    }
  }, []);

  const providerLabel = (id?: string) =>
    payload?.providers.find((item) => item.id === id)?.label ?? id ?? '';

  const testText = testing ? (
    <span className="flex items-center gap-1">
      <Icon name="spinner" spin className="h-3 w-3" />
      {t.webSearchTesting}
    </span>
  ) : testResult?.ok ? (
    t.webSearchTestOk(
      providerLabel(testResult.provider),
      testResult.results?.length ?? 0,
      testResult.ms ?? 0
    )
  ) : testResult ? (
    t.webSearchTestFailed(testResult.error || t.webSearchTestEmpty)
  ) : (
    t.webSearchTestHint
  );

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.webSearchSection}</h3>
        <div className="text-xs text-od-text-dim">{t.webSearchSectionDesc}</div>
      </div>
      {!config ? (
        <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
          <Icon name="spinner" spin className="mr-1 h-3 w-3" />
          {t.loadingDots}
        </div>
      ) : (
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 总开关 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.webSearchEnabledLabel}</div>
              <div className="text-xs text-od-text-dim">{t.webSearchEnabledDesc}</div>
            </div>
            <Switch
              checked={config.enabled}
              onChange={(value) => save({ enabled: value })}
              ariaLabel={t.webSearchEnabledLabel}
              disabled={saving}
            />
          </div>

          {/* 搜索源 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.webSearchProviderLabel}</div>
              <div className="text-xs text-od-text-dim">{t.webSearchProviderDesc}</div>
            </div>
            <Dropdown
              className="w-56 shrink-0"
              fullWidth
              value={config.provider}
              onChange={(value) => save({ provider: value as WebSearchProviderSetting })}
              disabled={saving || !config.enabled}
              ariaLabel={t.webSearchProviderLabel}
              options={[
                { value: 'auto', label: t.webSearchProviderAuto },
                ...(payload?.providers ?? []).map((item) => ({
                  value: item.id,
                  label: item.label
                }))
              ]}
            />
          </div>

          {/* 每次条数 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.webSearchCountLabel}</div>
              <div className="text-xs text-od-text-dim">{t.webSearchCountDesc}</div>
            </div>
            <Dropdown
              className="w-24 shrink-0"
              fullWidth
              value={String(config.maxResults)}
              onChange={(value) => save({ maxResults: Number(value) })}
              disabled={saving || !config.enabled}
              ariaLabel={t.webSearchCountLabel}
              options={COUNT_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>

          {/* 自建 SearXNG */}
          <div>
            <div className="text-sm text-od-text-bright">{t.webSearchSearxngLabel}</div>
            <div className="text-xs text-od-text-dim">{t.webSearchSearxngDesc}</div>
            <input
              type="text"
              spellCheck={false}
              value={searxngInput}
              placeholder={t.webSearchSearxngPlaceholder}
              onChange={(e) => setSearxngInput(e.target.value)}
              onBlur={commitSearxng}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label={t.webSearchSearxngLabel}
              disabled={!config.enabled}
              className="mt-1.5 w-full rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright disabled:opacity-50"
            />
          </div>

          {/* 测试搜索 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.webSearchTestLabel}</div>
              <div className="break-all text-xs text-od-text-dim">{testText}</div>
            </div>
            <button
              type="button"
              onClick={runTest}
              disabled={testing || !config.enabled}
              className="shrink-0 rounded border border-od-border-light px-2 py-1 text-xs text-od-text-bright hover:bg-od-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.webSearchTestButton}
            </button>
          </div>

          {/* 测试结果前几条（可点击打开） */}
          {testResult?.ok && (testResult.results?.length ?? 0) > 0 && (
            <ul className="space-y-1 border-t border-od-border pt-2">
              {testResult.results!.slice(0, 3).map((item) => (
                <li key={item.url} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => window.pi?.openExternal(item.url)}
                    className="block max-w-full truncate text-left text-xs text-od-accent hover:underline"
                    title={item.url}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="break-all text-xs text-od-text-dim">
            {t.webSearchConfigFileHint(payload?.configPath ?? '')}
          </div>
        </div>
      )}
    </div>
  );
}
