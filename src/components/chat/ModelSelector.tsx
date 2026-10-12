import { useState, useEffect } from 'react';
import { usePiStore } from '../../store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n/zh';
import Dropdown from '../common/Dropdown';
import { captureSessionGuard } from '../../hooks/loadSession';

/**
 * 推理强度配色：未选中用彩色文字（弱提示），选中用彩色底（强提示）。
 * max 单独给一条渐变 + 光晕，和其它等级区分开。
 */
const THINKING_LEVEL_STYLE: Record<string, { chip: string; text: string }> = {
  off: { chip: 'bg-od-border-light text-od-text-bright', text: 'text-od-text-dim' },
  minimal: { chip: 'bg-od-cyan text-od-bg-dark', text: 'text-od-cyan' },
  low: { chip: 'bg-od-accent text-od-bg-dark', text: 'text-od-accent' },
  medium: { chip: 'bg-od-green text-od-bg-dark', text: 'text-od-green' },
  high: { chip: 'bg-od-yellow text-od-bg-dark', text: 'text-od-yellow' },
  xhigh: { chip: 'bg-od-orange text-od-bg-dark', text: 'text-od-orange' },
  max: {
    // 先铺一层实色（万一渐变没生效也不会变成「没有背景」），再叠渐变；
    // bg-[length:200%_100%] + animate-gradient-flow 让渐变缓慢来回流动
    chip: 'bg-od-purple bg-gradient-to-r from-od-purple via-od-red to-od-orange bg-[length:200%_100%] animate-gradient-flow motion-reduce:animate-none text-od-bg-dark',
    // 渐变文字。注意：background-clip:text 会把元素自己的背景一起裁掉，
    // 所以它只能加在「内层 span / 无背景的触发按钮」上，不能直接加在 chip 按钮上
    text: 'bg-gradient-to-r from-od-purple via-od-red to-od-orange bg-[length:200%_100%] bg-clip-text text-transparent animate-gradient-flow motion-reduce:animate-none'
  }
};

const levelStyle = (level: string) =>
  THINKING_LEVEL_STYLE[level] ?? { chip: 'bg-od-accent text-od-bg-dark', text: 'text-od-accent' };

export default function ModelSelector() {
  const { model, thinkingLevel, availableModels, setModel, setThinkingLevel } = usePiStore(
    useShallow((s) => ({
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      availableModels: s.availableModels,
      setModel: s.setModel,
      setThinkingLevel: s.setThinkingLevel
    }))
  );
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

  // 触发按钮只显示模型名 + 推理强度（不显示供应商前缀，供应商在菜单第二行看）
  const currentModelLabel = model ? (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{model.name || model.id}</span>
      {thinkingLevel !== 'off' && (
        <span className={`shrink-0 ${levelStyle(thinkingLevel).text}`}>{thinkingLevel}</span>
      )}
    </span>
  ) : (
    t.noModel
  );
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
      // 选完不关面板：方便连着调「模型 + 推理强度」，点面板外部才关
      closeOnSelect={false}
      searchable
      searchPlaceholder={t.searchModels}
      emptyText={availableModels.length === 0 ? t.noModelsConfigured : t.noModelsMatched}
      options={availableModels.map((m: any) => ({
        value: `${m.provider}/${m.id}`,
        label: m.name || m.id,
        hint: `${m.provider}/${m.id}`
      }))}
      footer={() => (
        <>
          <div className="px-3 py-1 text-xs text-od-text-dim">{t.thinking}</div>
          <div className="flex flex-wrap gap-1 px-2">
            {thinkingLevels.map((l) => {
              const style = levelStyle(l);
              return (
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
                    } catch (e: any) {
                      if (current()) setError(e?.message || t.modelSwitchFailed);
                    }
                    // 不 close()：面板保持打开，用户点外部才关闭
                  }}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    thinkingLevel === l ? style.chip : 'bg-od-bg-hover hover:bg-od-border-light'
                  }`}
                >
                  {/* 未选中时文字色放在内层 span：max 的渐变文字会裁掉所在元素的背景 */}
                  <span className={thinkingLevel === l ? undefined : style.text}>{l}</span>
                </button>
              );
            })}
          </div>
          {error && (
            <div className="border-t border-od-border px-3 py-1.5 text-xs text-od-red">{error}</div>
          )}
        </>
      )}
    />
  );
}
