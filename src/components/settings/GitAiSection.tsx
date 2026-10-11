import { useCallback, useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { GitAiBinSource, GitAiConfig, GitAiScope, GitAiStatus } from '../../types/pi';

/**
 * 设置页 - 智能体配置 tab：git-ai 改动溯源
 *
 * 总开关 + 二进制路径（留空自动探测）+ 上报范围。
 * 配置落 `~/.pi-desktop/git-ai.json`，内联扩展每次事件读一次 → 改动即时生效，无需重启。
 * 每项改动立即提交（开关/下拉 onChange，路径输入框 blur/Enter），与设置页其它分区一致。
 */
export default function GitAiSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [config, setConfig] = useState<GitAiConfig | null>(null);
  const [status, setStatus] = useState<GitAiStatus | null>(null);
  const [binInput, setBinInput] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 探测生效的二进制（版本 + 来源）；失败只清空状态，不打扰用户 */
  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = await window.pi?.gitAi.detect();
      setStatus(res ?? null);
    } catch {
      setStatus(null);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.pi?.gitAi.getConfig();
        if (cancelled || !cfg) return;
        setConfig(cfg);
        setBinInput(cfg.binPath);
      } catch {
        // 读配置失败：保持加载态，不显示开关
      }
      if (!cancelled) await detect();
    })();
    return () => {
      cancelled = true;
    };
  }, [detect]);

  /** 提交单个字段；返回是否成功（成功后按需刷新探测结果） */
  const save = async (patch: Partial<GitAiConfig>, opts: { redetect?: boolean } = {}) => {
    if (saving) return false;
    setSaving(true);
    try {
      const res = await window.pi?.gitAi.setConfig(patch);
      if (!res || !res.ok) throw new Error(res?.error || t.gitAiSaveFailed);
      const next = res.config;
      if (next) {
        setConfig(next);
        // 只回填本次改的字段，避免覆盖用户正在编辑的输入框
        if ('binPath' in patch) setBinInput(next.binPath);
      }
      if (opts.redetect) await detect();
      return true;
    } catch (e: any) {
      showToast(e?.message || t.gitAiSaveFailed, { variant: 'error' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** 路径输入框失焦/回车提交；未改动则不写盘 */
  const commitBinPath = async () => {
    if (!config || binInput.trim() === config.binPath) return;
    await save({ binPath: binInput }, { redetect: true });
  };

  const sourceLabel = (source: GitAiBinSource) =>
    source === 'config'
      ? t.gitAiSourceConfig
      : source === 'env'
        ? t.gitAiSourceEnv
        : source === 'installed'
          ? t.gitAiSourceInstalled
          : t.gitAiSourcePath;

  const detectText = detecting ? (
    <span className="flex items-center gap-1">
      <Icon name="spinner" spin className="h-3 w-3" />
      {t.loadingDots}
    </span>
  ) : status?.version ? (
    t.gitAiDetected(status.version, status.bin, sourceLabel(status.source))
  ) : status ? (
    t.gitAiDetectedNoVersion(status.bin, sourceLabel(status.source))
  ) : (
    t.gitAiNotFound
  );

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.gitAiSection}</h3>
        <div className="text-xs text-od-text-dim">{t.gitAiSectionDesc}</div>
      </div>
      {!config ? (
        <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
          <Icon name="spinner" spin className="w-3 h-3 mr-1" />
          {t.loadingDots}
        </div>
      ) : (
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 总开关 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.gitAiEnabledLabel}</div>
              <div className="text-xs text-od-text-dim">{t.gitAiEnabledDesc}</div>
            </div>
            <Switch
              checked={config.enabled}
              onChange={(value) => save({ enabled: value })}
              ariaLabel={t.gitAiEnabledLabel}
              disabled={saving}
            />
          </div>

          {/* 检测结果 + 重新检测 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.gitAiDetectLabel}</div>
              <div className="break-all text-xs text-od-text-dim">{detectText}</div>
            </div>
            <button
              type="button"
              onClick={detect}
              disabled={detecting}
              className="shrink-0 rounded border border-od-border-light px-2 py-1 text-xs text-od-text-bright hover:bg-od-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t.gitAiDetectButton}
            </button>
          </div>

          {/* 二进制路径 */}
          <div>
            <div className="text-sm text-od-text-bright">{t.gitAiBinPathLabel}</div>
            <div className="text-xs text-od-text-dim">{t.gitAiBinPathDesc}</div>
            <input
              type="text"
              spellCheck={false}
              value={binInput}
              placeholder={status?.installedPath || t.gitAiBinPathPlaceholder}
              onChange={(e) => setBinInput(e.target.value)}
              onBlur={commitBinPath}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label={t.gitAiBinPathLabel}
              className="mt-1.5 w-full rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright"
            />
            {status?.envValue && (
              <div className="mt-1 break-all text-xs text-od-text-dim">
                {t.gitAiEnvOverrideHint(status.envValue)}
              </div>
            )}
          </div>

          {/* 上报范围 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.gitAiScopeLabel}</div>
              <div className="text-xs text-od-text-dim">{t.gitAiScopeDesc}</div>
            </div>
            <Dropdown
              className="w-44 shrink-0"
              fullWidth
              value={config.scope}
              onChange={(value) => save({ scope: value as GitAiScope })}
              disabled={saving}
              ariaLabel={t.gitAiScopeLabel}
              options={[
                { value: 'all', label: t.gitAiScopeAll },
                { value: 'files', label: t.gitAiScopeFiles },
                { value: 'shell', label: t.gitAiScopeShell }
              ]}
            />
          </div>

          {status && (
            <div className="break-all text-xs text-od-text-dim">
              {t.gitAiConfigFileHint(status.configPath)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
