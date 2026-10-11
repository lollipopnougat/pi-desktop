import {
  usePiStore,
  FONT_SIZE_MIN,
  FONT_SIZE_DEFAULT,
  UI_FONT_FAMILY_DEFAULT,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_FAMILY_DEFAULT,
  TERMINAL_SHELL_DEFAULT
} from '../../store/pi-store';
import { useState, useEffect } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown, { DROPDOWN_TRIGGER_CLASS } from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { THEME_FAMILIES, type ColorMode } from '../../theme/themes';
import EditorSettings from './EditorSettings';

/**
 * 设置页 - 界面 tab：字号设置 + 沙箱模式
 */
export default function AppearanceTab() {
  const fontSize = usePiStore((s) => s.fontSize);
  const setFontSize = usePiStore((s) => s.setFontSize);
  const uiFontFamily = usePiStore((s) => s.uiFontFamily);
  const setUiFontFamily = usePiStore((s) => s.setUiFontFamily);
  const terminalFontFamily = usePiStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = usePiStore((s) => s.setTerminalFontFamily);
  const terminalFontSize = usePiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = usePiStore((s) => s.setTerminalFontSize);
  const terminalShell = usePiStore((s) => s.terminalShell);
  const setTerminalShell = usePiStore((s) => s.setTerminalShell);
  const showBookmarks = usePiStore((s) => s.showBookmarks);
  const setShowBookmarks = usePiStore((s) => s.setShowBookmarks);
  const showThinkingBlocks = usePiStore((s) => s.showThinkingBlocks);
  const setShowThinkingBlocks = usePiStore((s) => s.setShowThinkingBlocks);
  const collapseToolCalls = usePiStore((s) => s.collapseToolCalls);
  const setCollapseToolCalls = usePiStore((s) => s.setCollapseToolCalls);

  // 通知设置（主进程读同一份 ui-config.json 裁决是否发送）
  const notifyEnabled = usePiStore((s) => s.notifyEnabled);
  const setNotifyEnabled = usePiStore((s) => s.setNotifyEnabled);
  const notifyMode = usePiStore((s) => s.notifyMode);
  const setNotifyMode = usePiStore((s) => s.setNotifyMode);
  const notifyOnTurnEnd = usePiStore((s) => s.notifyOnTurnEnd);
  const setNotifyOnTurnEnd = usePiStore((s) => s.setNotifyOnTurnEnd);
  const notifyOnAsk = usePiStore((s) => s.notifyOnAsk);
  const setNotifyOnAsk = usePiStore((s) => s.setNotifyOnAsk);

  const themeFamily = usePiStore((s) => s.themeFamily);

  const setThemeFamily = usePiStore((s) => s.setThemeFamily);
  const colorMode = usePiStore((s) => s.colorMode);
  const setColorMode = usePiStore((s) => s.setColorMode);

  const platform = window.pi.platform;
  const isWin = platform === 'win32';
  const [detectedShells, setDetectedShells] = useState<
    Awaited<ReturnType<typeof window.pi.terminalDetectShells>>
  >([]);

  useEffect(() => {
    window.pi
      .terminalDetectShells()
      .then(setDetectedShells)
      .catch(() => setDetectedShells([]));
  }, []);

  // 选 shell 菜单项：命中检测到的 shell 则回填其路径，否则回填原始值
  const pickShell = (val: string) => setTerminalShell(val);
  // 手动选择 shell 可执行文件
  const pickShellFile = async () => {
    const filters = isWin
      ? [
          { name: 'Shell 程序', extensions: ['exe', 'cmd', 'bat'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      : [{ name: '所有文件', extensions: ['*'] }];
    const picked = await window.pi.selectFile({
      title: isWin ? t.terminalShellPickFileTitleWin : t.terminalShellPickFileTitle,
      filters
    });
    if (picked) setTerminalShell(picked);
  };
  return (
    <>
      {/* 主题设置 section：明暗模式 + 主题族 */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.theme}</h3>
        <div className="space-y-2.5 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 颜色模式 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.colorMode}</div>
              <div className="text-xs text-od-text-dim">{t.colorModeDesc}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {[
                { v: 'system' as ColorMode, label: t.colorModeSystem },
                { v: 'dark' as ColorMode, label: t.colorModeDark },
                { v: 'light' as ColorMode, label: t.colorModeLight }
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setColorMode(opt.v)}
                  aria-pressed={colorMode === opt.v}
                  className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                    colorMode === opt.v
                      ? 'border-od-accent bg-od-accent/20 text-od-text-bright'
                      : 'border-od-border text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {/* 主题族 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.theme}</div>
              <div className="text-xs text-od-text-dim">{t.themeDesc}</div>
            </div>
            <Dropdown
              value={themeFamily}
              onChange={setThemeFamily}
              options={THEME_FAMILIES.filter((th) => !th.hidden).map((th) => ({
                value: th.id,
                label: th.label
              }))}
              triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-56`}
              panelWidth="w-64"
              ariaLabel={t.theme}
            />
          </div>
        </div>
      </div>

      {/* 界面设置 section：字号 + 界面字体 */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.appearance}</h3>
        <div className="space-y-2.5 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.fontSize}</div>
              <div className="text-xs text-od-text-dim">{t.fontSizeDesc}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFontSize(fontSize - 1)}
                disabled={fontSize <= FONT_SIZE_MIN}
                className="flex h-6 w-6 items-center justify-center rounded border border-od-border-light text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:opacity-40"
                aria-label="减小字号"
              >
                <Icon name="minus" className="w-3" />
              </button>
              <input
                type="number"
                min={FONT_SIZE_MIN}
                value={fontSize}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  const n = Number(raw);
                  if (Number.isFinite(n)) setFontSize(n);
                }}
                onBlur={(e) => {
                  const raw = e.target.value;
                  if (raw === '' || Number(raw) < FONT_SIZE_MIN) {
                    setFontSize(FONT_SIZE_DEFAULT);
                  }
                }}
                className="w-16 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-center font-mono text-xs text-od-text-bright [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                onClick={() => setFontSize(fontSize + 1)}
                className="flex h-6 w-6 items-center justify-center rounded border border-od-border-light text-od-text-bright transition-colors hover:bg-od-bg-hover"
                aria-label="增大字号"
              >
                <Icon name="plus" className="w-3" />
              </button>
              <span className="w-8 font-mono text-xs text-od-text-dim">px</span>
              <button
                onClick={() => setFontSize(FONT_SIZE_DEFAULT)}
                disabled={fontSize === FONT_SIZE_DEFAULT}
                className="rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
              >
                {t.reset}
              </button>
            </div>
          </div>
          {/* 界面字体 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.uiFontFamily}</div>
              <div className="text-xs text-od-text-dim">{t.uiFontFamilyDesc}</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={uiFontFamily}
                placeholder={t.uiFontFamilyPlaceholder}
                onChange={(e) => setUiFontFamily(e.target.value)}
                onBlur={() => {
                  if (!uiFontFamily.trim()) setUiFontFamily(UI_FONT_FAMILY_DEFAULT);
                }}
                className="w-64 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 font-mono text-xs text-od-text-bright"
              />
              <button
                onClick={() => setUiFontFamily(UI_FONT_FAMILY_DEFAULT)}
                disabled={uiFontFamily === UI_FONT_FAMILY_DEFAULT}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
              >
                {t.reset}
              </button>
            </div>
          </div>
          {/* Live preview：同时体现字号与界面字体 */}
          <div className="rounded bg-od-bg-dark px-2 py-1.5 text-sm text-od-text">
            The quick brown fox · 敏捷的棕色狐狸 · 123
          </div>
        </div>
      </div>

      {/* 终端设置 section */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.terminalSettings}</h3>
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 字体 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.terminalFontFamily}</div>
              <div className="text-xs text-od-text-dim">{t.terminalFontFamilyDesc}</div>
            </div>
            <input
              type="text"
              value={terminalFontFamily}
              placeholder={t.terminalFontFamilyPlaceholder}
              onChange={(e) => setTerminalFontFamily(e.target.value)}
              onBlur={() => {
                if (!terminalFontFamily.trim()) setTerminalFontFamily(TERMINAL_FONT_FAMILY_DEFAULT);
              }}
              className="w-64 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 font-mono text-xs text-od-text-bright"
            />
          </div>
          {/* 字号 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.terminalFontSize}</div>
              <div className="text-xs text-od-text-dim">{t.terminalFontSizeDesc}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTerminalFontSize(terminalFontSize - 1)}
                disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
                className="flex h-6 w-6 items-center justify-center rounded border border-od-border-light text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:opacity-40"
                aria-label="减小字号"
              >
                <Icon name="minus" className="w-3" />
              </button>
              <input
                type="number"
                min={TERMINAL_FONT_SIZE_MIN}
                value={terminalFontSize}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  const n = Number(raw);
                  if (Number.isFinite(n)) setTerminalFontSize(n);
                }}
                onBlur={(e) => {
                  const raw = e.target.value;
                  if (raw === '' || Number(raw) < TERMINAL_FONT_SIZE_MIN) {
                    setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT);
                  }
                }}
                className="w-16 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-center font-mono text-xs text-od-text-bright [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                onClick={() => setTerminalFontSize(terminalFontSize + 1)}
                className="flex h-6 w-6 items-center justify-center rounded border border-od-border-light text-od-text-bright transition-colors hover:bg-od-bg-hover"
                aria-label="增大字号"
              >
                <Icon name="plus" className="w-3" />
              </button>
              <span className="w-8 font-mono text-xs text-od-text-dim">px</span>
              <button
                onClick={() => setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)}
                disabled={terminalFontSize === TERMINAL_FONT_SIZE_DEFAULT}
                className="rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
              >
                {t.reset}
              </button>
            </div>
          </div>
          {/* 默认 Shell */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.terminalShell}</div>
              <div className="text-xs text-od-text-dim">{t.terminalShellDesc}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex">
                <input
                  type="text"
                  value={terminalShell}
                  placeholder={t.terminalShellPlaceholderAuto}
                  onChange={(e) => setTerminalShell(e.target.value)}
                  onBlur={() => {
                    if (!terminalShell.trim()) setTerminalShell('');
                  }}
                  className="w-64 rounded-l border border-r-0 border-od-border-light bg-od-bg-alt px-2 py-1 font-mono text-xs text-od-text-bright"
                />
                <Dropdown
                  value={terminalShell}
                  onChange={pickShell}
                  options={detectedShells.map((sh) => ({
                    value: sh.path,
                    label: sh.label,
                    hint: sh.path
                  }))}
                  hideTriggerLabel
                  triggerClassName="flex items-center justify-center rounded-r border border-od-border-light bg-od-bg-alt px-1.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                  panelWidth="w-72"
                  emptyText={t.terminalShellNoneDetected}
                  ariaLabel={t.terminalShell}
                  footer={(close) => (
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        void pickShellFile();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-od-text-bright hover:bg-od-bg-hover"
                    >
                      <Icon name="file" className="w-3 shrink-0" />
                      <span>{isWin ? t.terminalShellPickFileWin : t.terminalShellPickFile}</span>
                    </button>
                  )}
                />
              </div>
              <button
                onClick={() => setTerminalShell(TERMINAL_SHELL_DEFAULT)}
                disabled={terminalShell === TERMINAL_SHELL_DEFAULT}
                className="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-40"
              >
                {t.terminalShellReset}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 编辑器设置 section（Monaco 字体/字号/连字/主题 + 实时预览） */}
      <EditorSettings />

      {/* 聊天区设置 section */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.chatSettings}</h3>
        <div className="space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          {/* 用户消息书签 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.showBookmarks}</div>
              <div className="text-xs text-od-text-dim">{t.showBookmarksDesc}</div>
            </div>
            <Switch
              checked={showBookmarks}
              onChange={(v) => setShowBookmarks(v)}
              ariaLabel={t.showBookmarks}
            />
          </div>
          {/* 显示模型思考块 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.showThinkingBlocks}</div>
              <div className="text-xs text-od-text-dim">{t.showThinkingBlocksDesc}</div>
            </div>
            <Switch
              checked={showThinkingBlocks}
              onChange={(v) => setShowThinkingBlocks(v)}
              ariaLabel={t.showThinkingBlocks}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-od-text-bright">{t.collapseToolCalls}</div>
              <div className="text-xs text-od-text-dim">{t.collapseToolCallsDesc}</div>
            </div>
            <Switch
              checked={collapseToolCalls}
              onChange={setCollapseToolCalls}
              ariaLabel={t.collapseToolCalls}
            />
          </div>
        </div>
      </div>

      {/* 通知管理 section */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.notifications}</h3>
        <div
          className={`space-y-2 rounded border border-od-border bg-od-bg-alt px-3 py-2.5 ${
            !notifyEnabled ? 'opacity-50' : ''
          }`}
        >
          {/* 总开关 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.notifyEnabled}</div>
              <div className="text-xs text-od-text-dim">{t.notifyEnabledDesc}</div>
            </div>
            <Switch
              checked={notifyEnabled}
              onChange={(v) => setNotifyEnabled(v)}
              ariaLabel={t.notifyEnabled}
            />
          </div>
          {/* 发送时机（总开关关闭时禁用） */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.notifyMode}</div>
            </div>
            <Dropdown
              value={notifyMode}
              disabled={!notifyEnabled}
              onChange={(v) => setNotifyMode(v as 'always' | 'unfocused' | 'never')}
              options={[
                { value: 'always', label: t.notifyModeAlways },
                { value: 'unfocused', label: t.notifyModeUnfocused },
                { value: 'never', label: t.notifyModeNever }
              ]}
              triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-28`}
              panelWidth="w-32"
              ariaLabel={t.notifyMode}
            />
          </div>
          {/* 对话轮次完成 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.notifyOnTurnEnd}</div>
              <div className="text-xs text-od-text-dim">{t.notifyOnTurnEndDesc}</div>
            </div>
            <Switch
              checked={notifyOnTurnEnd}
              disabled={!notifyEnabled}
              onChange={(v) => setNotifyOnTurnEnd(v)}
              ariaLabel={t.notifyOnTurnEnd}
            />
          </div>
          {/* 问题询问 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-od-text-bright">{t.notifyOnAsk}</div>
              <div className="text-xs text-od-text-dim">{t.notifyOnAskDesc}</div>
            </div>
            <Switch
              checked={notifyOnAsk}
              disabled={!notifyEnabled}
              onChange={(v) => setNotifyOnAsk(v)}
              ariaLabel={t.notifyOnAsk}
            />
          </div>
        </div>
      </div>
    </>
  );
}
