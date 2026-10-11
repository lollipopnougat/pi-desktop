import { useState, useEffect } from 'react';
import { usePiStore } from '../../store/pi-store';
import { t } from '../../i18n/zh';
import Dropdown from '../common/Dropdown';
import { captureSessionGuard } from '../../hooks/loadSession';

export default function ModelSelector() {
  const { model, thinkingLevel, availableModels, setModel, setThinkingLevel } = usePiStore();
  const [error, setError] = useState<string | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(['off']);

  useEffect(() => {
    const current = captureSessionGuard();
    window.pi
      .getThinkingLevels()
      .then((levels) => {
        if (current()) setThinkingLevels(levels);
      })
      .catch(() => {});
  }, [model]);

  const switchModel = async (m: any) => {
    if (usePiStore.getState().isSessionLoading) return;
    const current = captureSessionGuard();
    try {
      setError(null);
      const res = await window.pi.setModel(m.provider, m.id);
      if (!current()) return;
      if (res?.model) {
        // 主进程已切换（agent.state.model 已更新），同步 store 的 model/thinkingLevel。
        // 不能依赖 onEvent：SDK 的 model_select 是扩展事件，AgentSessionEvent 里没有。
        setModel(res.model);
        setThinkingLevel(res.thinkingLevel ?? 'off');
      } else {
        // 极端情况（如 modelRuntime 未初始化）回退全量拉取状态
        const state = await window.pi.getState();
        if (current()) {
          setModel(state.model);
          setThinkingLevel(state.thinkingLevel);
        }
      }
    } catch (e: any) {
      if (current()) setError(e?.message || t.modelSwitchFailed);
    }
  };

  const currentModelLabel = model ? `${model.provider}/${model.id}` : t.noModel;
  const currentValue = model ? `${model.provider}/${model.id}` : '';

  return (
    <Dropdown
      className="min-w-0"
      value={currentValue}
      triggerLabel={currentModelLabel}
      onChange={(value) => {
        const picked = availableModels.find((m: any) => `${m.provider}/${m.id}` === value);
        if (picked) void switchModel(picked);
      }}
      triggerClassName="flex w-full min-w-0 items-center justify-between gap-1 rounded-lg px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
      panelWidth="w-64"
      listClassName="max-h-48"
      placement="top"
      searchable
      searchPlaceholder={t.searchModels}
      emptyText={availableModels.length === 0 ? t.noModelsConfigured : t.noModelsMatched}
      options={availableModels.map((m: any) => ({
        value: `${m.provider}/${m.id}`,
        label: m.name || m.id,
        hint: `${m.provider}/${m.id}`
      }))}
      footer={(close) => (
        <>
          <div className="px-3 py-1 text-xs text-od-text-dim">{t.thinking}</div>
          <div className="flex flex-wrap gap-1 px-2">
            {thinkingLevels.map((l) => (
              <button
                key={l}
                onClick={async () => {
                  if (usePiStore.getState().isSessionLoading) return;
                  const current = captureSessionGuard();
                  try {
                    await window.pi.setThinkingLevel(l);
                    // SDK 的 setThinkingLevel 是同步方法，返回 void（不是 Promise）
                    // 但 pi-bridge 包了一层 IPC，await 拿到的是已完成的信号
                    // thunk 里立即同步 store，不等 next turn 的 thinking_level_changed 事件
                    if (current()) setThinkingLevel(l);
                  } finally {
                    close();
                  }
                }}
                className={`rounded px-2 py-0.5 text-xs ${
                  thinkingLevel === l
                    ? 'bg-od-accent text-white'
                    : 'bg-od-bg-hover text-od-text hover:bg-od-border-light'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          {error && (
            <div className="border-t border-od-border px-3 py-1.5 text-xs text-od-red">{error}</div>
          )}
        </>
      )}
    />
  );
}
