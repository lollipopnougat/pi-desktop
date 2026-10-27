import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Radio from '../common/Radio';
import Dropdown, { DROPDOWN_TRIGGER_CLASS } from '../common/Dropdown';
import GitAiSection from './GitAiSection';
import WebSearchSection from './WebSearchSection';
import SubagentsSection from './SubagentsSection';
import { t } from '../../i18n/zh';
import { usePiStore, type PendingSendMode, type PermissionPolicy } from '../../store/pi-store';
import type { ClassifierModelInfo } from '../../types/pi';

/** 决策模型下拉项的复合值分隔符（与主进程 classifier-ipc 的约定一致，模型 id 可能含 '/' 等字符） */
const MODEL_KEY_SEP = '\u0000';

const COMPACTION_DEFAULTS = {
  reserveTokens: 16384,
  keepRecentTokens: 20000
};

/**
 * 设置页 - 智能体配置 tab：默认模型 + 权限沙箱 + 上下文压缩
 * 权限沙箱部分：默认审批策略选择 + auto-safe 自定义白名单（安全工具/bash 命令）
 */
export default function AgentTab() {
  return (
    <>
      {/* 默认模型 section */}
      <DefaultModelSection />

      {/* 待发送消息默认方式 section */}
      <PendingModeSection />

      {/* 权限沙箱 section */}
      <PermissionSection />

      {/* 图片识别工具 section */}
      <ReadImgSection />

      {/* 网络搜索工具 section */}
      <WebSearchSection />

      {/* 子智能体 section */}
      <SubagentsSection />

      {/* 上下文压缩 section */}
      <CompactionSection />

      {/* git-ai 改动溯源 section */}
      <GitAiSection />

      {/* 全局自定义指令 section */}
      <GlobalInstructionsSection />
    </>
  );
}

/**
 * 默认模型配置：新建会话时使用的模型。
 * 落到 settings.json 的 defaultProvider/defaultModel，SDK 建会话时按
 * 会话历史 → 默认模型 → 内置 provider 默认表 → 第一个可用模型 的顺序选型。
 */
function DefaultModelSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([]);
  const [selected, setSelected] = useState(''); // '' = 未设置，否则 'provider/modelId'
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [available, current] = await Promise.all([
          window.pi?.getAvailableModels(),
          window.pi?.getDefaultModel()
        ]);
        if (cancelled) return;
        setModels((available ?? []).map((m) => ({ provider: m.provider, id: m.id, name: m.name })));
        if (current?.provider && current?.modelId) {
          setSelected(`${current.provider}/${current.modelId}`);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = async (value: string) => {
    setSelected(value);
    if (!loaded || saving) return;
    setSaving(true);
    try {
      if (value === '') {
        const res = await window.pi?.setDefaultModel(null, null);
        if (res && !res.ok) throw new Error(res.error || t.defaultModelSaveFailed);
      } else {
        const sep = value.indexOf('/');
        const res = await window.pi?.setDefaultModel(value.slice(0, sep), value.slice(sep + 1));
        if (res && !res.ok) throw new Error(res.error || t.defaultModelSaveFailed);
      }
      showToast(t.defaultModelSaved, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.defaultModelSaveFailed, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // 已保存的默认模型可能已不在可用列表（provider 被删/未配密钥）——补一个选项显式标出
  const options = models.map((m) => `${m.provider}/${m.id}`);
  const known = options.includes(selected);
  const extraOption = selected && !known ? selected : null;

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.defaultModelSection}</h3>
        <div className="text-xs text-od-text-dim">{t.defaultModelSectionDesc}</div>
      </div>
      <div className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm text-od-text-bright">{t.defaultModelLabel}</div>
          <div className="text-xs text-od-text-dim">
            {saving ? (
              <span className="flex items-center gap-1">
                <Icon name="spinner" spin className="h-3 w-3" />
                {t.loadingDots}
              </span>
            ) : loadError ? (
              <span className="text-od-red">{t.defaultModelLoadFailed}</span>
            ) : loaded && models.length === 0 ? (
              t.defaultModelNoModels
            ) : extraOption ? (
              t.defaultModelUnavailable
            ) : (
              t.defaultModelNotSet
            )}
          </div>
        </div>
        <Dropdown
          className="min-w-0 max-w-[55%] shrink-0"
          fullWidth
          value={selected}
          onChange={commit}
          disabled={!loaded || (models.length === 0 && !extraOption)}
          searchable
          searchPlaceholder={t.searchModels}
          panelWidth="w-72"
          ariaLabel={t.defaultModelLabel}
          options={[
            { value: '', label: t.defaultModelNotSet },
            ...(extraOption
              ? [{ value: extraOption, label: extraOption, hint: t.defaultModelUnavailable }]
              : []),
            ...models.map((m) => ({
              value: `${m.provider}/${m.id}`,
              label: m.name || m.id,
              hint: `${m.provider}/${m.id}`
            }))
          ]}
        />
      </div>
    </div>
  );
}

/**
 * 待发送消息：模型回复期间（streaming）发送消息的默认投递方式。
 * 持久化到 ui-config.json 的 streamingSendMode；聊天输入框的 Enter / 发送按钮按此走，
 * Alt+Enter 走另一种，队列 chip 上还可单条互转。
 */
function PendingModeSection() {
  const streamingSendMode = usePiStore((s) => s.streamingSendMode);
  const setStreamingSendMode = usePiStore((s) => s.setStreamingSendMode);

  const options: Array<{ value: PendingSendMode; label: string; desc: string }> = [
    { value: 'followUp', label: t.pendingModeQueue, desc: t.pendingModeQueueDesc },
    { value: 'steer', label: t.pendingModeSteer, desc: t.pendingModeSteerDesc }
  ];

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.pendingModeSection}</h3>
        <div className="text-xs text-od-text-dim">{t.pendingModeSectionDesc}</div>
      </div>
      <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        <div className="mb-2 text-sm text-od-text-bright">{t.pendingModeLabel}</div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t.pendingModeLabel}>
          {options.map((o) => {
            const active = streamingSendMode === o.value;
            return (
              <label
                key={o.value}
                className={`group flex cursor-pointer items-start gap-2.5 rounded border px-2.5 py-2 transition-colors ${
                  active
                    ? 'border-od-accent/70 bg-od-accent/10'
                    : 'border-od-border-light hover:bg-od-bg-hover'
                }`}
              >
                <Radio
                  name="pending-send-mode"
                  checked={active}
                  onChange={() => setStreamingSendMode(o.value)}
                />
                <div className="min-w-0">
                  <div className="text-sm text-od-text-bright">{o.label}</div>
                  <div className="text-xs text-od-text-dim">{o.desc}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** read_img 图片识别工具配置：选择视觉模型（或不配置） */
function ReadImgSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);
  const [selected, setSelected] = useState(''); // '' = 不配置，否则 'provider/modelId'
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [visionModels, ui] = await Promise.all([
          window.pi?.getVisionModels(),
          window.pi?.getUiSettings()
        ]);
        if (cancelled) return;
        setModels(visionModels ?? []);
        const cfg = ui?.readImgModel;
        if (cfg?.provider && cfg?.modelId) {
          setSelected(`${cfg.provider}/${cfg.modelId}`);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = async (value: string) => {
    setSelected(value);
    if (!loaded || saving) return;
    setSaving(true);
    try {
      if (value === '') {
        const res = await window.pi?.setReadImgModel(null, null);
        if (res && !res.ok) throw new Error(res.error || t.readImgSaveFailed);
      } else {
        const sep = value.indexOf('/');
        const provider = value.slice(0, sep);
        const modelId = value.slice(sep + 1);
        const res = await window.pi?.setReadImgModel(provider, modelId);
        if (res && !res.ok) throw new Error(res.error || t.readImgSaveFailed);
      }
      showToast(t.readImgSaved, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.readImgSaveFailed, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.readImgSection}</h3>
        <div className="text-xs text-od-text-dim">{t.readImgSectionDesc}</div>
      </div>
      <div className="flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm text-od-text-bright">{t.readImgModelLabel}</div>
          <div className="text-xs text-od-text-dim">
            {saving ? (
              <span className="flex items-center gap-1">
                <Icon name="spinner" spin className="h-3 w-3" />
                {t.loadingDots}
              </span>
            ) : loadError ? (
              <span className="text-od-red">{t.readImgLoadFailed}</span>
            ) : loaded && models.length === 0 ? (
              t.readImgNoVisionModels
            ) : (
              t.readImgModelNotConfigured
            )}
          </div>
        </div>
        <Dropdown
          className="min-w-0 max-w-[55%] shrink-0"
          fullWidth
          value={selected}
          onChange={commit}
          disabled={!loaded || models.length === 0}
          searchable
          searchPlaceholder={t.searchModels}
          panelWidth="w-72"
          ariaLabel={t.readImgModelLabel}
          options={[
            { value: '', label: t.readImgModelNotConfigured },
            ...models.map((m) => ({
              value: `${m.provider}/${m.id}`,
              label: m.name || m.id,
              hint: `${m.provider}/${m.id}`
            }))
          ]}
        />
      </div>
    </div>
  );
}

/** 权限沙箱配置：默认策略 + auto-safe 白名单 + 决策模型自动审批 */
function PermissionSection() {
  // 默认策略与 store 同步（设置页改动会写 ui-config.json 并同步主进程闸门）
  const permissionPolicy = usePiStore((s) => s.permissionPolicy);
  const setPermissionPolicy = usePiStore((s) => s.setPermissionPolicy);
  const showToast = usePiStore((state) => state.showToast);

  const [safeTools, setSafeTools] = useState('');
  const [safeBashCommands, setSafeBashCommands] = useState('');
  // 决策模型自动审批（classifier-auto）：选中的判定模型 + 超时/置信度阈值
  const [classifierModels, setClassifierModels] = useState<ClassifierModelInfo[]>([]);
  const [classifierModelKey, setClassifierModelKey] = useState('');
  const [classifierTimeout, setClassifierTimeout] = useState('');
  const [classifierMinConfidence, setClassifierMinConfidence] = useState('');
  const [classifierAllowWrite, setClassifierAllowWrite] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.pi
      ?.getAutoSafeConfig()
      .then((c) => {
        setSafeTools((c.safeTools ?? []).join('\n'));
        setSafeBashCommands((c.safeBashCommands ?? []).join('\n'));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    window.pi
      ?.getClassifierApprovalConfig()
      .then((c) => {
        setClassifierModelKey(
          c.providerId && c.modelId ? `${c.providerId}${MODEL_KEY_SEP}${c.modelId}` : ''
        );
        setClassifierTimeout(typeof c.timeoutMs === 'number' ? String(c.timeoutMs) : '');
        setClassifierMinConfidence(
          typeof c.minConfidence === 'number' ? String(c.minConfidence) : ''
        );
        setClassifierAllowWrite(c.allowWriteInCwd === true);
      })
      .catch(() => {});
    window.pi
      ?.getClassifierModels()
      .then((res) => setClassifierModels(res.models.filter((m) => m.available)))
      .catch(() => {});
  }, []);

  /** 多行文本 → 去重保序字符串数组 */
  const toList = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };

  const dirty = loaded && (safeTools !== '' || safeBashCommands !== '');

  const handleSave = async () => {
    if (!loaded || saving) return;
    setSaving(true);
    try {
      const res = await window.pi?.setAutoSafeConfig({
        safeTools: toList(safeTools),
        safeBashCommands: toList(safeBashCommands)
      });
      if (res && !res.ok) throw new Error(t.permissionWhitelistSaveFailed);
      // 决策模型自动审批配置（同一保存按钮，归一化结果回填到输入框）
      const [providerId, modelId] = classifierModelKey
        ? classifierModelKey.split(MODEL_KEY_SEP)
        : ['', ''];
      const res2 = await window.pi?.setClassifierApprovalConfig({
        providerId,
        modelId,
        ...(classifierTimeout.trim() ? { timeoutMs: Number(classifierTimeout) } : {}),
        ...(classifierMinConfidence.trim()
          ? { minConfidence: Number(classifierMinConfidence) }
          : {}),
        allowWriteInCwd: classifierAllowWrite
      });
      if (res2 && !res2.ok) throw new Error(t.permissionClassifierSaveFailed);
      if (res2?.config) {
        const c = res2.config;
        setClassifierTimeout(typeof c.timeoutMs === 'number' ? String(c.timeoutMs) : '');
        setClassifierMinConfidence(
          typeof c.minConfidence === 'number' ? String(c.minConfidence) : ''
        );
        setClassifierAllowWrite(c.allowWriteInCwd === true);
      }
      showToast(t.permissionWhitelistSaved, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.permissionWhitelistSaveFailed, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const textareaCls =
    'w-full resize-y rounded border border-od-border-light bg-od-bg px-2 py-1.5 font-mono text-xs leading-relaxed text-od-text-bright placeholder:text-od-text-dim';
  const numberInputCls =
    'w-28 rounded border border-od-border-light bg-od-bg px-2 py-1 text-left text-xs text-od-text-bright placeholder:text-od-text-dim';

  // 判定模型下拉项：可用模型 + （若已配置的模型当前不可用则额外列出，避免静默清空用户选择）
  const modelOptions = [
    ...classifierModels.map((m) => ({
      value: `${m.provider}${MODEL_KEY_SEP}${m.id}`,
      label: `${m.name}（${m.providerName} / ${m.apiLabel}）`
    })),
    ...(classifierModelKey &&
    !classifierModels.some((m) => `${m.provider}${MODEL_KEY_SEP}${m.id}` === classifierModelKey)
      ? [
          {
            value: classifierModelKey,
            label: `${classifierModelKey.split(MODEL_KEY_SEP).join(' / ')}（${t.permissionClassifierModelMissing}）`
          }
        ]
      : [])
  ];

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.permissionSettings}</h3>
        <div className="text-xs text-od-text-dim">{t.permissionSettingsDesc}</div>
      </div>
      <div className="space-y-3 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        {/* 默认审批策略 */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-od-text-bright">{t.permissionDefaultPolicyLabel}</div>
            <div className="text-xs text-od-text-dim">{t.permissionDefaultPolicyDesc}</div>
          </div>
          <Dropdown
            value={permissionPolicy}
            onChange={(v) => setPermissionPolicy(v as PermissionPolicy)}
            triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-36`}
            panelWidth="w-44"
            ariaLabel={t.permissionDefaultPolicyLabel}
            options={[
              { value: 'ask-all', label: t.permissionAskAll },
              { value: 'auto-safe', label: t.permissionAutoSafe },
              { value: 'classifier-auto', label: t.permissionClassifierAuto },
              { value: 'allow-all', label: t.permissionAllowAll }
            ]}
          />
        </div>

        {/* 自动审批安全工具白名单 */}
        <div>
          <div className="text-sm text-od-text-bright">{t.permissionSafeToolsLabel}</div>
          <div className="mb-1.5 text-xs text-od-text-dim">{t.permissionSafeToolsDesc}</div>
          <textarea
            value={safeTools}
            onChange={(e) => {
              setSafeTools(e.target.value);
            }}
            placeholder={t.permissionWhitelistPlaceholder}
            rows={3}
            spellCheck={false}
            className={textareaCls}
          />
        </div>

        {/* Bash 命令白名单 */}
        <div>
          <div className="text-sm text-od-text-bright">{t.permissionSafeBashLabel}</div>
          <div className="mb-1.5 text-xs text-od-text-dim">{t.permissionSafeBashDesc}</div>
          <textarea
            value={safeBashCommands}
            onChange={(e) => {
              setSafeBashCommands(e.target.value);
            }}
            placeholder={t.permissionWhitelistPlaceholder}
            rows={4}
            spellCheck={false}
            className={textareaCls}
          />
        </div>

        {/* 决策模型自动审批（classifier-auto） */}
        <div>
          <div className="text-sm text-od-text-bright">{t.permissionClassifierLabel}</div>
          <div className="mb-1.5 text-xs text-od-text-dim">{t.permissionClassifierDesc}</div>
          <div className="space-y-2 rounded border border-od-border-light bg-od-bg px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-od-text-bright">
                {t.permissionClassifierModelLabel}
              </span>
              <Dropdown
                value={classifierModelKey}
                onChange={(v) => {
                  setClassifierModelKey(v);
                }}
                triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-64`}
                panelWidth="w-96"
                ariaLabel={t.permissionClassifierModelLabel}
                placeholder={
                  modelOptions.length > 0
                    ? t.permissionClassifierModelNotConfigured
                    : t.permissionClassifierModelEmpty
                }
                options={modelOptions}
                disabled={modelOptions.length === 0}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-od-text-bright">
                {t.permissionClassifierTimeoutLabel}
              </span>
              <input
                type="number"
                value={classifierTimeout}
                onChange={(e) => {
                  setClassifierTimeout(e.target.value);
                }}
                placeholder={t.permissionClassifierTimeoutHint}
                className={numberInputCls}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-od-text-bright">
                {t.permissionClassifierConfidenceLabel}
              </span>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={classifierMinConfidence}
                onChange={(e) => {
                  setClassifierMinConfidence(e.target.value);
                }}
                placeholder={t.permissionClassifierConfidenceHint}
                className={numberInputCls}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-od-text-bright">
                {t.permissionClassifierAllowWriteLabel}
              </span>
              <Switch
                checked={classifierAllowWrite}
                onChange={(v) => setClassifierAllowWrite(v)}
                ariaLabel={t.permissionClassifierAllowWriteLabel}
              />
            </div>
            <div className="text-xs leading-relaxed text-od-text-dim">
              {t.permissionClassifierAllowWriteHint}
            </div>
            {classifierAllowWrite && (
              <div className="flex items-start gap-1.5 rounded border border-od-yellow/30 bg-od-yellow/10 px-2 py-1.5 text-xs leading-relaxed text-od-yellow">
                <Icon name="warning" className="mt-0.5 w-3 shrink-0" />
                <span>{t.permissionClassifierAllowWriteWarn}</span>
              </div>
            )}
            <div className="text-xs leading-relaxed text-od-text-dim">
              {t.permissionClassifierFirstHint}
            </div>
            {/* 判定超时过小是「未能判定」的最常见原因：本地端点空闲后首次判定可能 3~5 秒（已自动重试一次） */}
            {Number(classifierTimeout) > 0 && Number(classifierTimeout) < 5000 && (
              <div className="flex items-start gap-1.5 rounded border border-od-yellow/30 bg-od-yellow/10 px-2 py-1.5 text-xs leading-relaxed text-od-yellow">
                <Icon name="warning" className="mt-0.5 w-3 shrink-0" />
                <span>{t.permissionClassifierTimeoutWarn}</span>
              </div>
            )}
            <div className="text-xs leading-relaxed text-od-text-dim">
              {t.permissionClassifierFallbackHint}
            </div>
          </div>
        </div>

        {/* 保存状态条 */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-od-text-dim">
            {saving ? (
              <span className="flex items-center gap-1">
                <Icon name="spinner" spin className="w-3 h-3" />
                {t.loadingDots}
              </span>
            ) : null}
          </div>
          <button
            onClick={handleSave}
            disabled={!loaded || saving}
            className="flex items-center gap-1.5 rounded bg-od-accent px-3 py-1 text-xs text-white transition-colors hover:bg-od-accent/80 active:bg-od-accent/65 disabled:opacity-50"
          >
            <Icon name={saving ? 'spinner' : 'check'} spin={saving} className="w-3" />
            {t.permissionWhitelistSave}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 全局自定义指令：读写 ~/.pi-desktop/AGENTS.md（SDK 作为全局 context 注入所有会话） */
function GlobalInstructionsSection() {
  const showToast = usePiStore((state) => state.showToast);
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.pi
      ?.getGlobalInstructions()
      .then((t) => {
        setText(t);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    if (!loaded || saving) return;
    setSaving(true);
    try {
      await window.pi?.setGlobalInstructions(text);
      setDirty(false);
      showToast(t.globalInstructionsSaved, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.globalInstructionsSaveFailed, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-semibold text-od-text">{t.globalInstructions}</h3>
        <div className="text-xs text-od-text-dim">{t.globalInstructionsDesc}</div>
      </div>
      <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          placeholder={t.globalInstructionsPlaceholder}
          rows={8}
          spellCheck={false}
          className="w-full resize-y rounded border border-od-border-light bg-od-bg px-2 py-1.5 font-mono text-xs leading-relaxed text-od-text-bright placeholder:text-od-text-dim"
        />
        <div className="mt-2 flex items-center justify-between">
          {/* 状态提示 */}
          <div className="text-xs text-od-text-dim">
            {saving ? (
              <span className="flex items-center gap-1">
                <Icon name="spinner" spin className="w-3 h-3" />
                {t.loadingDots}
              </span>
            ) : dirty ? (
              t.globalInstructionsDirty
            ) : null}
          </div>
          <button
            onClick={handleSave}
            disabled={!loaded || saving || !dirty}
            className="flex items-center gap-1.5 rounded bg-od-accent px-3 py-1 text-xs text-white transition-colors hover:bg-od-accent/80 active:bg-od-accent/65 disabled:opacity-50"
          >
            <Icon name={saving ? 'spinner' : 'check'} spin={saving} className="w-3" />
            {t.globalInstructionsSave}
          </button>
        </div>
      </div>
    </div>
  );
}
/** 上下文压缩配置 */
function CompactionSection() {
  const [enabled, setEnabled] = useState(true);
  const [reserveTokens, setReserveTokens] = useState('');
  const [keepRecentTokens, setKeepRecentTokens] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.pi
      ?.getCompactionSettings()
      .then((s) => {
        setEnabled(s.enabled ?? true);
        setReserveTokens(s.reserveTokens === undefined ? '' : String(s.reserveTokens));
        setKeepRecentTokens(s.keepRecentTokens === undefined ? '' : String(s.keepRecentTokens));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const commitToggle = (v: boolean) => {
    setEnabled(v);
    window.pi?.setCompactionEnabled(v).catch(() => {});
  };

  const commitReserveTokens = (raw: string) => {
    const n = raw === '' ? undefined : Number(raw);
    if (raw !== '' && !Number.isFinite(n)) return;
    window.pi
      ?.setCompactionTokens(n, keepRecentTokens === '' ? undefined : Number(keepRecentTokens))
      .catch(() => {});
  };

  const commitKeepRecentTokens = (raw: string) => {
    const n = raw === '' ? undefined : Number(raw);
    if (raw !== '' && !Number.isFinite(n)) return;
    window.pi
      ?.setCompactionTokens(reserveTokens === '' ? undefined : Number(reserveTokens), n)
      .catch(() => {});
  };

  const numberInputCls =
    'w-32 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold text-od-text">{t.compactionSection}</h3>
      {!loaded ? (
        <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
          <Icon name="spinner" spin className="w-3 h-3 mr-1" />
          加载中...
        </div>
      ) : (
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 开关 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.compactionEnabledLabel}</div>
              <div className="text-xs text-od-text-dim">{t.compactionDesc}</div>
            </div>
            <Switch checked={enabled} onChange={(v) => commitToggle(v)} />
          </div>
          {/* 剩余窗口预留 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.compactionReserveTokensLabel}</div>
              <div className="flex items-baseline gap-1 text-xs text-od-text-dim">
                {t.compactionReserveTokensDesc}
                <span className="text-od-text-dim opacity-70">
                  {t.compactionReserveDefaultHint}
                </span>
              </div>
            </div>
            <input
              type="number"
              min={COMPACTION_DEFAULTS.reserveTokens / 2}
              value={reserveTokens}
              placeholder={String(COMPACTION_DEFAULTS.reserveTokens)}
              onChange={(e) => setReserveTokens(e.target.value)}
              onBlur={() => commitReserveTokens(reserveTokens)}
              className={numberInputCls}
            />
          </div>
          {/* 保留最近消息 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.compactionKeepRecentTokensLabel}</div>
              <div className="flex items-baseline gap-1 text-xs text-od-text-dim">
                {t.compactionKeepRecentTokensDesc}
                <span className="text-od-text-dim opacity-70">
                  {t.compactionKeepRecentDefaultHint}
                </span>
              </div>
            </div>
            <input
              type="number"
              min={COMPACTION_DEFAULTS.keepRecentTokens / 2}
              value={keepRecentTokens}
              placeholder={String(COMPACTION_DEFAULTS.keepRecentTokens)}
              onChange={(e) => setKeepRecentTokens(e.target.value)}
              onBlur={() => commitKeepRecentTokens(keepRecentTokens)}
              className={numberInputCls}
            />
          </div>
        </div>
      )}
    </div>
  );
}
