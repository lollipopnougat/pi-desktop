import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { SubagentConfig, SubagentConfigPayload } from '../../types/pi';

/**
 * 设置页 - 智能体配置 tab：子智能体
 *
 * 只有一个总开关。配置落 `~/.pi-desktop/subagents.json`，
 * 关闭后 `piBridge.applySubagentConfig()` 会把 `task` 工具从所有会话槽
 * （含后台槽）的活跃工具里移除 —— 模型看不到 task，也就无法再委派子任务；
 * 子任务面板 / 历史 run 的查看不受影响。改完即时生效，无需重启会话。
 */
export default function SubagentsSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [payload, setPayload] = useState<SubagentConfigPayload | null>(null);
  const [config, setConfig] = useState<SubagentConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.pi?.subagents.getConfig();
        if (cancelled || !res) return;
        setPayload(res);
        setConfig(res.config);
      } catch {
        // 读配置失败：保持加载态，不显示开关
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 提交单个字段（成功后回填主进程归一化的结果） */
  const save = async (patch: Partial<SubagentConfig>) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await window.pi?.subagents.setConfig(patch);
      if (!res || !res.ok) throw new Error(res?.error || t.subagentSaveFailed);
      if (res.config) setConfig(res.config);
      showToast(t.subagentSaved, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.subagentSaveFailed, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.subagentSection}</h3>
        <div className="text-xs text-od-text-dim">{t.subagentSectionDesc}</div>
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
              <div className="text-sm text-od-text-bright">{t.subagentEnabledLabel}</div>
              <div className="text-xs text-od-text-dim">{t.subagentEnabledDesc}</div>
            </div>
            <Switch
              checked={config.enabled}
              onChange={(value) => save({ enabled: value })}
              ariaLabel={t.subagentEnabledLabel}
              disabled={saving}
            />
          </div>

          {/* 关闭时的补充说明 */}
          {!config.enabled && (
            <div className="text-xs text-od-text-dim">{t.subagentDisabledHint}</div>
          )}

          <div className="break-all text-xs text-od-text-dim">
            {t.subagentConfigFileHint(payload?.configPath ?? '')}
          </div>
        </div>
      )}
    </div>
  );
}
