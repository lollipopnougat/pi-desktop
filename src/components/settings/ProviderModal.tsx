import { useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';
import PasswordInput from '../common/PasswordInput';
import Checkbox from '../common/Checkbox';
import Dropdown, { type DropdownGroup, type DropdownOption } from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import {
  type Provider,
  type ProviderModel,
  type ThinkingFormat,
  API_OPTIONS,
  THINKING_FORMAT_OPTIONS,
  THINKING_LEVELS,
  getSelectedThinkingLevels,
  buildThinkingLevelMap
} from '../../types/shared';
import type { ModelPreset } from '../../types/model-preset';
import { normalizePresetModelId } from '../../types/model-preset';
import {
  EMPTY_PRESET_INDEX,
  findModelPreset,
  formatTokenCount,
  loadModelPresetIndex,
  presetToModelFields,
  suggestModelPresets,
  type ModelPresetIndex
} from '../../lib/model-presets';

/** 新增模型草稿（预设与应用后的可编辑状态） */
interface ModelDraft {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingFormat: ThinkingFormat;
  developerRole: boolean;
  /** 勾选的思考等级（默认全选；应用预设后按内置目录过滤） */
  levels: string[];
  /** 价格 $/M tokens（全 0 时不写入 models.json） */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const createDraft = (): ModelDraft => ({
  id: '',
  name: '',
  reasoning: true,
  image: true,
  contextWindow: 1000000,
  maxTokens: 128000,
  thinkingFormat: 'auto',
  developerRole: false,
  levels: [...THINKING_LEVELS],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
});

const DRAFT_INPUT_CLASS =
  'w-full rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-sm text-od-text-bright placeholder:text-od-text-dim';
const DRAFT_SMALL_INPUT_CLASS =
  'w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright';

interface ProviderModalProps {
  /** 正在编辑的 provider key（null = 新增） */
  editingProvider: string | null;
  /** 初始表单数据（新增时为空表单） */
  initialForm: Provider;
  onClose: () => void;
  onSave: (form: Provider) => Promise<void>;
}

/**
 * 新增/编辑自定义 Provider 弹窗。
 *
 * 从 ModelsTab 的内嵌表单抽出：遮罩 + 居中卡片，内部滚动（表单较长），
 * 避开 macOS 38px / 其他平台 32px 标题栏。模型列表、/v1/models 拉取、
 * 逐模型编辑（思考等级多选 / 默认思考等级 / compat / 价格）逻辑全部内聚于此。
 *
 * 新增模型区支持「模型预设」：数据来自 SDK 内置模型目录（见 src/lib/model-presets.ts），
 * 选择预设或按 ID 匹配建议即可带出上下文窗口/视觉/推理/价格/思考等级，之后仍可手改。
 */
export default function ProviderModal({
  editingProvider,
  initialForm,
  onClose,
  onSave
}: ProviderModalProps) {
  const isMac = window.pi?.platform === 'darwin';
  const [form, setForm] = useState<Provider>(initialForm);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(createDraft);
  /** 已应用到草稿的预设（仅展示徽标，ID 被改掉后徽标自动隐藏） */
  const [appliedPreset, setAppliedPreset] = useState<ModelPreset | null>(null);
  /** 预设来源的原始草稿快照：撤销填充时回退（null = 未应用过） */
  const [draftBeforePreset, setDraftBeforePreset] = useState<ModelDraft | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presetIndex, setPresetIndex] = useState<ModelPresetIndex>(EMPTY_PRESET_INDEX);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [editingModelIdx, setEditingModelIdx] = useState<number | null>(null);
  /** 编辑面板里刚「按 ID 应用预设」的行下标（用于提示） */
  const [presetRowHintIdx, setPresetRowHintIdx] = useState<number | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const showToast = usePiStore((state) => state.showToast);

  // 预设索引按需加载：模块级缓存，弹窗二次打开不再走 IPC
  useEffect(() => {
    let alive = true;
    loadModelPresetIndex()
      .then((idx) => {
        if (alive) setPresetIndex(idx);
      })
      .finally(() => {
        if (alive) setPresetsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 预设下拉：按内置 provider 分组（列表已按 provider 优先级排序，同 provider 连续） */
  const { presetGroups, presetByValue } = useMemo(() => {
    const groups: DropdownGroup[] = [];
    const byValue = new Map<string, ModelPreset>();
    for (const p of presetIndex.presets) {
      const value = `${p.provider}::${p.id}`;
      byValue.set(value, p);
      const traits = [
        formatTokenCount(p.contextWindow),
        ...(p.vision ? [t.modelImage] : []),
        ...(p.reasoning ? [t.reasoning] : [])
      ].join(' · ');
      const option: DropdownOption = {
        value,
        label: p.name,
        hint: `${p.id} · ${traits}`
      };
      const last = groups[groups.length - 1];
      if (last && last.label === p.providerName) last.options.push(option);
      else groups.push({ label: p.providerName, options: [option] });
    }
    return { presetGroups: groups, presetByValue: byValue };
  }, [presetIndex.presets]);

  /** 输入模型 ID 时的候选（≥ 2 字符才查，避免刷屏） */
  const suggestions = useMemo(
    () => (draft.id.trim().length >= 2 ? suggestModelPresets(presetIndex, draft.id, 6) : []),
    [presetIndex, draft.id]
  );

  /** 徽标只在 ID 仍指向该预设时展示 */
  const presetMatchesDraft =
    !!appliedPreset &&
    normalizePresetModelId(appliedPreset.id) === normalizePresetModelId(draft.id);

  const buildCompat = (m: { thinkingFormat: ThinkingFormat; developerRole: boolean }) => {
    if (m.thinkingFormat === 'auto' && m.developerRole) return undefined;
    const compat: Record<string, any> = {};
    if (m.thinkingFormat !== 'auto') compat.thinkingFormat = m.thinkingFormat;
    if (!m.developerRole) compat.supportsDeveloperRole = false;
    return Object.keys(compat).length > 0 ? compat : undefined;
  };

  /** 全 0（未填价格）时不写 cost，避免在 models.json 里留下无意义的 0 */
  const isZeroCost = (cost: Record<string, number | undefined>): boolean =>
    ![cost.input ?? 0, cost.output ?? 0, cost.cacheRead ?? 0, cost.cacheWrite ?? 0].some(
      (v) => Number.isFinite(v) && v > 0
    );

  const addModel = () => {
    const id = draft.id.trim();
    if (!id) return;
    const input: ('text' | 'image')[] = ['text', ...(draft.image ? (['image'] as const) : [])];
    const compat = buildCompat(draft);
    const cost = isZeroCost(draft.cost) ? undefined : { ...draft.cost };
    setForm({
      ...form,
      models: [
        ...form.models,
        {
          id,
          name: draft.name.trim() || id,
          reasoning: draft.reasoning,
          input,
          contextWindow: draft.contextWindow || 1000000,
          maxTokens: draft.maxTokens || 128000,
          // 新增模型默认全选全部等级（含 xhigh/max，显式映射后 SDK 才会展示它们）；
          // 应用预设后按内置目录里的实际支持等级勾选
          thinkingLevelMap: buildThinkingLevelMap(new Set(draft.levels)),
          ...(cost ? { cost } : {}),
          ...(compat ? { compat } : {})
        }
      ]
    });
    resetDraft();
  };

  const resetDraft = () => {
    setDraft(createDraft());
    setAppliedPreset(null);
    setDraftBeforePreset(null);
    setShowAdvanced(false);
  };

  /**
   * 应用预设到草稿。
   * @param keepId true = 保留用户已输入的 ID（按 ID 匹配建议的场景：ID 是要发给端点的原值，
   *   不能被内置目录里的别名/大小写覆盖）；false = 用预设自带的 ID（从下拉框直接选预设）
   */
  const applyPresetToDraft = (preset: ModelPreset, opts?: { keepId?: boolean }) => {
    const fields = presetToModelFields(preset);
    const levels = THINKING_LEVELS.filter((l) => preset.levels.includes(l));
    setDraft((prev) => ({
      ...prev,
      id: opts?.keepId ? prev.id : preset.id,
      name: fields.name ?? prev.name,
      reasoning: fields.reasoning ?? prev.reasoning,
      image: fields.input?.includes('image') ?? prev.image,
      contextWindow: fields.contextWindow ?? prev.contextWindow,
      maxTokens: fields.maxTokens ?? prev.maxTokens,
      levels: levels.length > 0 ? levels : prev.levels,
      cost: fields.cost
        ? {
            input: fields.cost.input,
            output: fields.cost.output,
            cacheRead: fields.cost.cacheRead ?? 0,
            cacheWrite: fields.cost.cacheWrite ?? 0
          }
        : prev.cost
    }));
    setAppliedPreset(preset);
    setDraftBeforePreset(draft);
  };

  /** 撤销填充：回到应用预设之前的草稿 */
  const undoPreset = () => {
    if (draftBeforePreset) setDraft(draftBeforePreset);
    setAppliedPreset(null);
    setDraftBeforePreset(null);
  };

  /** 编辑已有行时按 ID 补齐预设（保留该行 ID 与名称，不改 compat） */
  const applyPresetToModelRow = (idx: number) => {
    const preset = findModelPreset(presetIndex, form.models[idx]?.id ?? '');
    if (!preset) return;
    const fields = presetToModelFields(preset);
    // 保留该行已有的名称（不改 id / name，只补齐能力与参数）
    const patch = { ...fields };
    delete patch.name;
    updateModel(idx, patch);
    setPresetRowHintIdx(idx);
  };

  const removeModel = (idx: number) => {
    setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });
  };

  const updateModel = (idx: number, patch: Partial<ProviderModel>) => {
    const models = [...form.models];
    models[idx] = { ...models[idx], ...patch };
    setForm({ ...form, models });
  };

  /** 从 compat 提取 thinkingFormat（无则为 auto） */
  const getModelThinkingFormat = (m: ProviderModel): ThinkingFormat => {
    return (m.compat?.thinkingFormat as ThinkingFormat) || 'auto';
  };

  /** 勾选/取消某个思考等级（写入 thinkingLevelMap） */
  const toggleThinkingLevel = (idx: number, level: string, checked: boolean) => {
    const selected = getSelectedThinkingLevels(form.models[idx]);
    if (checked) selected.add(level);
    else selected.delete(level);
    // 至少保留一个等级，否则 getSupportedThinkingLevels 返回空、切换后无法选任何等级
    if (selected.size === 0) return;
    updateModel(idx, { thinkingLevelMap: buildThinkingLevelMap(selected) });
  };

  /** 更新模型的 thinkingFormat 和 developerRole（写入 compat） */
  const updateModelCompat = (
    idx: number,
    opts: { thinkingFormat?: ThinkingFormat; developerRole?: boolean }
  ) => {
    const model = form.models[idx];
    const curTf = getModelThinkingFormat(model);
    const curDev = model.compat?.supportsDeveloperRole !== false; // undefined → true
    const tf = opts.thinkingFormat ?? curTf;
    const dev = opts.developerRole ?? curDev;
    const compat: Record<string, any> = { ...(model.compat ?? {}) };
    if (tf !== 'auto') compat.thinkingFormat = tf;
    else delete compat.thinkingFormat;
    if (!dev) compat.supportsDeveloperRole = false;
    else delete compat.supportsDeveloperRole;
    if (Object.keys(compat).length === 0) {
      updateModel(idx, { compat: undefined });
    } else {
      updateModel(idx, { compat });
    }
  };

  /** 从 /v1/models 拉取模型列表，替换当前 form.models（按 ID 命中内置目录时自动补齐参数） */
  const handleFetchModels = async () => {
    if (!form.baseUrl) return;
    setFetchingModels(true);
    try {
      const res = await window.pi.fetchModels(form.baseUrl, form.apiKey || undefined);
      if (res.ok && res.models.length > 0) {
        // 预设索引可能仍在加载（弹窗刚打开就点拉取），这里直接 await 模块级缓存
        const index = presetIndex.presets.length > 0 ? presetIndex : await loadModelPresetIndex();
        let enriched = 0;
        const models: ProviderModel[] = res.models.map((m) => {
          const preset = findModelPreset(index, m.id);
          if (preset) enriched += 1;
          const fields = preset ? presetToModelFields(preset) : null;
          return {
            id: m.id,
            name: fields?.name || m.id,
            reasoning: fields?.reasoning ?? true,
            input: fields?.input ?? (['text', 'image'] as ('text' | 'image')[]),
            contextWindow: fields?.contextWindow ?? 1000000,
            maxTokens: fields?.maxTokens ?? 128000,
            // 默认全选全部等级（含 xhigh/max，显式映射后 SDK 才会展示它们）
            thinkingLevelMap:
              fields?.thinkingLevelMap ?? buildThinkingLevelMap(new Set(THINKING_LEVELS)),
            ...(fields?.cost ? { cost: fields.cost } : {}),
            // 默认不勾选 developer role（写入 supportsDeveloperRole: false），
            // 编辑面板读 compat?.supportsDeveloperRole !== false 时回显为未选中
            compat: { supportsDeveloperRole: false }
          };
        });
        setForm({ ...form, models });
        setEditingModelIdx(null);
        showToast(
          enriched > 0
            ? `${t.fetchModelsOk(res.models.length)} · ${t.fetchModelsEnriched(enriched, res.models.length)}`
            : t.fetchModelsOk(res.models.length),
          { variant: 'success' }
        );
      } else {
        showToast(res.error || t.fetchModelsFail, { variant: 'error' });
      }
    } catch {
      showToast(t.fetchModelsFail, { variant: 'error' });
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSave = async () => {
    if (!form.key || !form.baseUrl || saving) return;
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center bg-black/60"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 w-[min(56rem,90vw)] flex-1 flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-od-border px-4 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="server" className="w-3.5 text-od-accent" />
            {editingProvider ? t.editProviderTitle : t.addProviderTitle}
          </h2>
          <button onClick={onClose} className="text-od-text-dim hover:text-od-text-bright">
            <Icon name="close" size="sm" />
          </button>
        </div>

        {/* Body（可滚动） */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-od-text-dim">{t.providerKey}</label>
              <input
                type="text"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                disabled={!!editingProvider}
                placeholder="my-anthropic"
                className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1 text-sm text-od-text-bright disabled:opacity-50"
              />
            </div>
            <div>
              <label className="text-xs text-od-text-dim">{t.displayName}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="My Anthropic"
                className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1 text-sm text-od-text-bright"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-od-text-dim">{t.baseUrl}</label>
            <input
              type="text"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://api.anthropic.com"
              className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1 text-sm text-od-text-bright"
            />
            {/* anthropic-messages 提示：SDK 自动补 /v1/messages，勿带 /v1 后缀 */}
            {form.api === 'anthropic-messages' && (
              <div className="mt-1 space-y-1">
                <div className="text-xs text-od-text-dim opacity-70">{t.baseUrlAnthropicHint}</div>
                {/* 检测到以 /v1 结尾时给出警告（anthropic-messages 专属坑） */}
                {/\/v1\/?$/.test(form.baseUrl.trim()) && (
                  <div className="rounded border border-od-yellow/30 bg-od-yellow/10 px-2 py-1 text-xs text-od-yellow">
                    {t.baseUrlAnthropicDetected}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-od-text-dim">{t.apiType}</label>
            <Dropdown
              className="w-full"
              fullWidth
              value={form.api}
              onChange={(api) => {
                // 切换离开 anthropic-messages 时重置 authHeader，
                // 避免残留的 Bearer 开关对其它 api 类型造成误解。
                setForm({
                  ...form,
                  api,
                  authHeader: api === 'anthropic-messages' ? form.authHeader : false
                });
              }}
              triggerClassName="flex w-full items-center justify-between gap-2 rounded border border-od-border-light bg-od-bg-dark px-2 py-1 text-sm text-od-text-bright transition-colors hover:bg-od-bg-hover"
              panelWidth="w-full"
              ariaLabel={t.apiType}
              options={API_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>

          {/* Bearer 鉴权开关：仅 anthropic-messages 有效 */}
          {form.api === 'anthropic-messages' && (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={!!form.authHeader}
                onChange={(v) => setForm({ ...form, authHeader: v })}
                label={t.authHeader}
                title={t.authHeaderHint}
              />
              <span className="text-xs text-od-text-dim opacity-70">{t.authHeaderHint}</span>
            </div>
          )}

          <div>
            <label className="text-xs text-od-text-dim">
              {t.apiKey} {editingProvider && t.apiKeyHint}
            </label>
            <PasswordInput
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full rounded border border-od-border-light bg-od-bg-dark px-2 py-1 pr-7 text-sm text-od-text-bright"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs text-od-text-dim">{t.models}</label>
              <button
                onClick={handleFetchModels}
                disabled={!form.baseUrl || fetchingModels}
                className="flex items-center gap-1 rounded bg-od-accent px-2 py-0.5 text-xs text-white hover:bg-od-accent/80 disabled:opacity-40"
              >
                <Icon name="retry" className="w-3" spin={fetchingModels} />
                {fetchingModels ? t.fetchModelsFetching : t.fetchModels}
              </button>
            </div>
            <div className="space-y-1 mb-2">
              {form.models.map((m, i) => {
                const isEditingModel = editingModelIdx === i;
                const hasImage = m.input?.includes('image') ?? false;
                // 该行 ID 在内置目录中的对应条目（用于「按 ID 应用预设」）
                const rowPreset = findModelPreset(presetIndex, m.id);
                return (
                  <div key={i} className="rounded bg-od-bg-dark">
                    <div className="flex items-center justify-between px-2 py-1 text-xs">
                      <button
                        onClick={() => {
                          setEditingModelIdx(isEditingModel ? null : i);
                          setPresetRowHintIdx(null);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:bg-od-bg-hover rounded px-1"
                      >
                        <Icon
                          name={isEditingModel ? 'chevronDown' : 'chevronRight'}
                          className="w-3 shrink-0"
                        />
                        <span className="truncate text-od-text-bright">{m.name || m.id}</span>
                        <span className="flex shrink-0 gap-1">
                          {(m.contextWindow ?? 0) > 0 && (
                            <span className="rounded bg-od-bg-alt px-1 py-0.5 text-xs text-od-text-dim">
                              {formatTokenCount(m.contextWindow ?? 0)}
                            </span>
                          )}
                          {m.reasoning && (
                            <span className="rounded bg-od-purple/20 px-1 py-0.5 text-xs text-od-purple">
                              {t.reasoning}
                            </span>
                          )}
                          {m.defaultThinkingLevel && (
                            <span className="rounded bg-od-cyan/20 px-1 py-0.5 text-xs text-od-cyan">
                              {m.defaultThinkingLevel}
                            </span>
                          )}
                          {hasImage && (
                            <span className="rounded bg-od-green/20 px-1 py-0.5 text-xs text-od-green">
                              {t.modelImage}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-od-text-dim">{m.id}</span>
                      </button>
                      <button
                        onClick={() => {
                          removeModel(i);
                          if (isEditingModel) setEditingModelIdx(null);
                        }}
                        className="ml-1 shrink-0 text-od-red hover:text-od-red"
                      >
                        <Icon name="delete" className="w-3" />
                      </button>
                    </div>
                    {isEditingModel && (
                      <div className="grid grid-cols-2 gap-1.5 border-t border-od-border px-2 py-1.5">
                        {rowPreset && (
                          <div className="col-span-2 flex items-center gap-2">
                            <button
                              onClick={() => applyPresetToModelRow(i)}
                              className="flex shrink-0 items-center gap-1 rounded border border-od-accent/40 px-2 py-0.5 text-xs text-od-accent transition-colors hover:bg-od-accent/10"
                            >
                              <Icon name="lightbulb" className="w-3" />
                              {t.presetApplyToRow}
                            </button>
                            <span className="min-w-0 truncate text-xs text-od-text-dim">
                              {rowPreset.name} · {formatTokenCount(rowPreset.contextWindow)}
                              {rowPreset.vision ? ` · ${t.modelImage}` : ''}
                            </span>
                            {presetRowHintIdx === i && (
                              <span className="shrink-0 text-xs text-od-green">
                                {t.presetApplyToRowDone}
                              </span>
                            )}
                          </div>
                        )}
                        <div>
                          <label className="text-xs text-od-text-dim">{t.modelName}</label>
                          <input
                            type="text"
                            value={m.name || ''}
                            onChange={(e) => updateModel(i, { name: e.target.value })}
                            className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-od-text-dim">{t.modelId}</label>
                          <input
                            type="text"
                            value={m.id}
                            disabled
                            className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 font-mono text-xs text-od-text-dim"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-od-text-dim">{t.modelContextWindow}</label>
                          <input
                            type="number"
                            value={m.contextWindow ?? 1000000}
                            onChange={(e) =>
                              updateModel(i, { contextWindow: Number(e.target.value) || 1000000 })
                            }
                            className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-od-text-dim">{t.modelMaxTokens}</label>
                          <input
                            type="number"
                            value={m.maxTokens ?? 128000}
                            onChange={(e) =>
                              updateModel(i, { maxTokens: Number(e.target.value) || 128000 })
                            }
                            className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                          />
                        </div>
                        <div className="col-span-2 flex gap-4">
                          <Checkbox
                            checked={m.reasoning ?? false}
                            onChange={(v) => updateModel(i, { reasoning: v })}
                            label={t.reasoning}
                          />
                          <Checkbox
                            checked={hasImage}
                            onChange={(v) => {
                              const input: ('text' | 'image')[] = [
                                'text',
                                ...(v ? (['image'] as const) : [])
                              ];
                              updateModel(i, { input });
                            }}
                            label={t.modelImage}
                          />
                          <Checkbox
                            checked={m.compat?.supportsDeveloperRole !== false}
                            onChange={(v) => updateModelCompat(i, { developerRole: v })}
                            label={t.modelStringRole}
                            title={t.modelStringRoleHint}
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="text-xs text-od-text-dim">
                            {t.modelThinkingFormat}
                          </label>
                          <Dropdown
                            className="w-full"
                            fullWidth
                            value={getModelThinkingFormat(m)}
                            onChange={(v) =>
                              updateModelCompat(i, { thinkingFormat: v as ThinkingFormat })
                            }
                            triggerClassName="flex w-full items-center justify-between gap-2 rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
                            panelWidth="w-full"
                            ariaLabel={t.modelThinkingFormat}
                            options={THINKING_FORMAT_OPTIONS.map((o) => ({
                              value: o.value,
                              label: o.label
                            }))}
                          />
                        </div>
                        {/* 思考等级多选：勾选模型支持的等级，写入 thinkingLevelMap，
                            模型选择器仅展示勾选的等级；SDK 会按 thinkingLevelMap 过滤 */}
                        <div className="col-span-2">
                          <label
                            className="text-xs text-od-text-dim"
                            title={t.modelThinkingLevelsHint}
                          >
                            {t.modelThinkingLevels}
                          </label>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {THINKING_LEVELS.map((level) => (
                              <Checkbox
                                key={level}
                                checked={getSelectedThinkingLevels(m).has(level)}
                                onChange={(v) => toggleThinkingLevel(i, level, v)}
                                label={level}
                              />
                            ))}
                          </div>
                        </div>
                        {/* 默认思考等级：切换到此模型时自动应用（clamp 到支持等级） */}
                        <div className="col-span-2">
                          <label className="text-xs text-od-text-dim">
                            {t.modelDefaultThinkingLevel}
                          </label>
                          <Dropdown
                            className="w-full"
                            fullWidth
                            value={m.defaultThinkingLevel || ''}
                            onChange={(v) =>
                              updateModel(i, { defaultThinkingLevel: v || undefined })
                            }
                            triggerClassName="flex w-full items-center justify-between gap-2 rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
                            panelWidth="w-full"
                            ariaLabel={t.modelDefaultThinkingLevel}
                            options={[
                              { value: '', label: t.modelDefaultThinkingLevelNone },
                              ...THINKING_LEVELS.map((l) => ({ value: l, label: l }))
                            ]}
                          />
                        </div>
                        {/* 价格配置（$/M tokens） */}
                        <div className="col-span-2 mt-1 border-t border-od-border pt-1.5">
                          <label className="mb-1 block text-xs text-od-text-dim">
                            {t.modelCostTitle}
                            <span className="ml-2 text-xs text-od-text-dim opacity-60">
                              {t.modelCostUnit}
                            </span>
                          </label>
                          <div className="grid grid-cols-4 gap-1.5">
                            <div>
                              <label className="text-xs text-od-text-dim">{t.modelCostInput}</label>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={m.cost?.input ?? 0}
                                onChange={(e) =>
                                  updateModel(i, {
                                    cost: {
                                      input: parseFloat(e.target.value) || 0,
                                      output: m.cost?.output ?? 0,
                                      cacheRead: m.cost?.cacheRead ?? 0,
                                      cacheWrite: m.cost?.cacheWrite ?? 0
                                    }
                                  })
                                }
                                className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-od-text-dim">
                                {t.modelCostOutput}
                              </label>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={m.cost?.output ?? 0}
                                onChange={(e) =>
                                  updateModel(i, {
                                    cost: {
                                      input: m.cost?.input ?? 0,
                                      output: parseFloat(e.target.value) || 0,
                                      cacheRead: m.cost?.cacheRead ?? 0,
                                      cacheWrite: m.cost?.cacheWrite ?? 0
                                    }
                                  })
                                }
                                className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-od-text-dim">
                                {t.modelCostCacheRead}
                              </label>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={m.cost?.cacheRead ?? 0}
                                onChange={(e) =>
                                  updateModel(i, {
                                    cost: {
                                      input: m.cost?.input ?? 0,
                                      output: m.cost?.output ?? 0,
                                      cacheRead: parseFloat(e.target.value) || 0,
                                      cacheWrite: m.cost?.cacheWrite ?? 0
                                    }
                                  })
                                }
                                className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-od-text-dim">
                                {t.modelCostCacheWrite}
                              </label>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={m.cost?.cacheWrite ?? 0}
                                onChange={(e) =>
                                  updateModel(i, {
                                    cost: {
                                      input: m.cost?.input ?? 0,
                                      output: m.cost?.output ?? 0,
                                      cacheRead: m.cost?.cacheRead ?? 0,
                                      cacheWrite: parseFloat(e.target.value) || 0
                                    }
                                  })
                                }
                                className="w-full rounded border border-od-border-light bg-od-bg-alt px-1.5 py-0.5 text-xs text-od-text-bright"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 新增模型（预设 \+ 结构化字段） */}
            <div className="mt-1 rounded-lg border border-od-border bg-od-bg-dark p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-od-text-bright">
                    <Icon name="plus" className="w-3 text-od-accent" />
                    {t.addModelTitle}
                  </div>
                  <div className="mt-0.5 text-xs text-od-text-dim">{t.addModelSubtitle}</div>
                </div>
                <Dropdown
                  value=""
                  onChange={(v) => {
                    const preset = presetByValue.get(v);
                    if (preset) applyPresetToDraft(preset);
                  }}
                  title={t.presetPickHint}
                  disabled={presetsLoading || presetIndex.presets.length === 0}
                  searchable
                  searchPlaceholder={t.presetSearchPlaceholder}
                  placeholder={presetsLoading ? t.presetLoading : t.presetPick}
                  emptyText={t.presetEmpty}
                  groups={presetGroups}
                  maxVisibleOptions={60}
                  panelWidth="w-[26rem]"
                  listClassName="max-h-72"
                  className="shrink-0"
                  ariaLabel={t.presetPick}
                />
              </div>

              {/* 基础字段：标签在上、输入框在下，排版不再挤成一行 */}
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <div>
                  <label className="text-xs text-od-text-dim">
                    {t.modelId} <span className="text-od-red">*</span>
                  </label>
                  <input
                    type="text"
                    value={draft.id}
                    onChange={(e) => {
                      // 手动改动 ID 后不再标注「已应用预设」，但保留已带入的参数
                      setDraft({ ...draft, id: e.target.value });
                    }}
                    placeholder={t.modelIdPlaceholder}
                    className={DRAFT_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="text-xs text-od-text-dim">{t.modelName}</label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder={t.modelName}
                    className={DRAFT_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="text-xs text-od-text-dim">{t.modelContextWindow}</label>
                  <input
                    type="number"
                    value={draft.contextWindow}
                    onChange={(e) =>
                      setDraft({ ...draft, contextWindow: Number(e.target.value) || 0 })
                    }
                    className={DRAFT_INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className="text-xs text-od-text-dim">{t.modelMaxTokens}</label>
                  <input
                    type="number"
                    value={draft.maxTokens}
                    onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) || 0 })}
                    className={DRAFT_INPUT_CLASS}
                  />
                </div>
              </div>

              {/* 能力与思考格式 */}
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
                <Checkbox
                  checked={draft.reasoning}
                  onChange={(v) => setDraft({ ...draft, reasoning: v })}
                  label={t.reasoning}
                />
                <Checkbox
                  checked={draft.image}
                  onChange={(v) => setDraft({ ...draft, image: v })}
                  label={t.modelImage}
                />
                <Checkbox
                  checked={draft.developerRole}
                  onChange={(v) => setDraft({ ...draft, developerRole: v })}
                  label={t.modelStringRole}
                  title={t.modelStringRoleHint}
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-od-text-dim">{t.modelThinkingFormat}</span>
                  <Dropdown
                    value={draft.thinkingFormat}
                    onChange={(v) => setDraft({ ...draft, thinkingFormat: v as ThinkingFormat })}
                    title={t.modelThinkingFormat}
                    panelWidth="w-56"
                    ariaLabel={t.modelThinkingFormat}
                    options={THINKING_FORMAT_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label
                    }))}
                  />
                </div>
              </div>

              {/* 已应用预设 */}
              {presetMatchesDraft && appliedPreset && (
                <div className="mt-2 flex items-center gap-2 rounded border border-od-accent/30 bg-od-accent/10 px-2 py-1 text-xs text-od-accent">
                  <Icon name="lightbulb" className="w-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {t.presetApplied(appliedPreset.name, appliedPreset.providerName)}
                  </span>
                  <button onClick={undoPreset} className="shrink-0 hover:underline">
                    {t.presetUndo}
                  </button>
                </div>
              )}

              {/* 按 ID 匹配到的内置模型（已应用预设后收起，避免与徽标重复） */}
              {!presetMatchesDraft && draft.id.trim().length >= 2 && (
                <div className="mt-2">
                  <div className="mb-1 flex items-center gap-1 text-xs text-od-text-dim">
                    <Icon name="search" className="w-3" />
                    {t.presetSuggestTitle}
                  </div>
                  {suggestions.length === 0 ? (
                    <div className="text-xs text-od-text-dim opacity-70">
                      {presetsLoading ? t.presetLoading : t.presetSuggestEmpty}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {suggestions.map((p) => (
                        <button
                          key={`${p.provider}::${p.id}`}
                          onClick={() => applyPresetToDraft(p, { keepId: true })}
                          className="flex w-full items-center gap-2 rounded border border-od-border bg-od-bg-alt px-2 py-1 text-left text-xs transition-colors hover:border-od-accent/40 hover:bg-od-bg-hover"
                        >
                          <span className="shrink-0 text-od-text-bright">{p.name}</span>
                          <span className="min-w-0 truncate font-mono text-od-text-dim">
                            {p.id}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-od-text-dim">
                            <span>{formatTokenCount(p.contextWindow)}</span>
                            {p.vision && <span className="text-od-green">{t.modelImage}</span>}
                            {p.reasoning && <span className="text-od-purple">{t.reasoning}</span>}
                            <span className="opacity-60">{p.providerName}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 高级：价格 + 思考等级 */}
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="mt-2 flex items-center gap-1 text-xs text-od-text-dim hover:text-od-text-bright"
              >
                <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} className="w-3" />
                {t.modelAdvanced}
                <span className="opacity-60">({t.modelAdvancedHint})</span>
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-2 rounded border border-od-border bg-od-bg-alt p-2">
                  <div>
                    <div className="mb-1 text-xs text-od-text-dim">{t.modelCostTitle}</div>
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {(
                        [
                          ['input', t.modelCostInput],
                          ['output', t.modelCostOutput],
                          ['cacheRead', t.modelCostCacheRead],
                          ['cacheWrite', t.modelCostCacheWrite]
                        ] as const
                      ).map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-od-text-dim">{label}</label>
                          <input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            value={draft.cost[key]}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                cost: { ...draft.cost, [key]: parseFloat(e.target.value) || 0 }
                              })
                            }
                            className={DRAFT_SMALL_INPUT_CLASS}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-od-text-dim">{t.modelThinkingLevels}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {THINKING_LEVELS.map((level) => (
                        <Checkbox
                          key={level}
                          checked={draft.levels.includes(level)}
                          onChange={(v) => {
                            const next = v
                              ? [...draft.levels, level]
                              : draft.levels.filter((l) => l !== level);
                            // 至少保留一个等级
                            if (next.length === 0) return;
                            setDraft({ ...draft, levels: next });
                          }}
                          label={level}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  onClick={resetDraft}
                  className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
                >
                  {t.modelDraftReset}
                </button>
                <button
                  onClick={addModel}
                  disabled={!draft.id.trim()}
                  className="flex items-center gap-1 rounded bg-od-accent px-3 py-1 text-xs text-white hover:bg-od-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="plus" className="w-3" />
                  {t.modelAddButton}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-od-border px-4 py-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded px-3 py-1 text-xs text-od-text hover:bg-od-bg-hover disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!form.key || !form.baseUrl || saving}
            className="flex items-center gap-1 rounded bg-od-accent px-3 py-1 text-xs text-white hover:bg-od-accent/80 disabled:opacity-50"
          >
            {saving && <Icon name="spinner" spin className="w-3" />}
            {t.saveProvider}
          </button>
        </div>
      </div>
    </div>
  );
}
