import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../common/Icon';
import Switch from '../common/Switch';
import Dropdown from '../common/Dropdown';
import ConfirmDialog from '../common/ConfirmDialog';
import { DROPDOWN_TRIGGER_CLASS } from '../common/Dropdown';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';
import type { LogChannelId, LogConfig, LogFileInfo, LogLevel } from '../../types/pi';

/** 各功能的界面文案（顺序即渲染顺序） */
const CHANNEL_TEXT: Record<string, { label: string; desc: string }> = {
  classifier: { label: t.logsChannelClassifier, desc: t.logsChannelClassifierDesc },
  model: { label: t.logsChannelModel, desc: t.logsChannelModelDesc },
  tools: { label: t.logsChannelTools, desc: t.logsChannelToolsDesc },
  permission: { label: t.logsChannelPermission, desc: t.logsChannelPermissionDesc },
  app: { label: t.logsChannelApp, desc: t.logsChannelAppDesc }
};

const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: t.logsLevelDebug },
  { value: 'info', label: t.logsLevelInfo },
  { value: 'warn', label: t.logsLevelWarn },
  { value: 'error', label: t.logsLevelError }
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间戳 → 本地 `MM-DD HH:mm` */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 设置页 - 日志 tab。
 *
 * 四个区块：
 * 1. 总开关 / 等级 / 保留天数（存 ui-config.json 的 logConfig，改完立即生效）
 * 2. 按功能开关（决策模型 / 助手模型 / 工具 / 审批 / 应用）
 * 3. 日志文件列表（按功能分组折叠，每项可打开/删除）+ 清除
 * 4. 最近日志预览（按功能查看当天最后若干行）
 *
 * 每项改动都直接落盘（无「保存」按钮）：与权限策略等设置一致，避免用户以为改了却没生效。
 */
export default function LogsTab() {
  const showToast = usePiStore((state) => state.showToast);
  const [config, setConfig] = useState<LogConfig | null>(null);
  const [dir, setDir] = useState('');
  const [channels, setChannels] = useState<LogChannelId[]>([]);
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [retentionText, setRetentionText] = useState('');

  const [preview, setPreview] = useState<LogChannelId>('model');
  const [lines, setLines] = useState<string[]>([]);

  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<LogFileInfo | null>(null);
  /** 分组折叠状态：只有用户主动收起的组才记为 true，缺省即展开 */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const refreshPreview = useCallback(async (channel: LogChannelId) => {
    try {
      const res = await window.pi.readLogTail(channel, 200);
      setLines(res.ok && res.lines ? res.lines : []);
    } catch {
      setLines([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([window.pi.getLogConfig(), window.pi.listLogFiles()]);
      setConfig(cfg.config);
      setRetentionText(String(cfg.config.retentionDays));
      setDir(cfg.dir);
      setChannels(cfg.channels);
      setFiles(list.files);
    } catch (err) {
      showToast(String(err), { variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshPreview(preview);
  }, [preview, refreshPreview]);

  /**
   * 按功能分组（顺序与上方「按功能开关」一致，见 LOG_CHANNELS）。
   * 文件里出现但配置里没有的功能追加在末尾——不然它们会从列表里静默消失。
   */
  const grouped = useMemo(() => {
    const byChannel = new Map<string, LogFileInfo[]>();
    for (const file of files) {
      const list = byChannel.get(file.channel);
      if (list) list.push(file);
      else byChannel.set(file.channel, [file]);
    }
    const extra = [...byChannel.keys()].filter((c) => !channels.includes(c as LogChannelId));
    return [...channels, ...extra]
      .filter((channel) => byChannel.has(channel))
      .map((channel) => ({
        channel,
        label: CHANNEL_TEXT[channel]?.label ?? channel,
        files: byChannel.get(channel) ?? []
      }));
  }, [files, channels]);

  const toggleGroup = useCallback((channel: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [channel]: !prev[channel] }));
  }, []);

  const handleOpenFile = useCallback(
    async (file: LogFileInfo) => {
      try {
        const res = await window.pi.openLogFile(file.name);
        if (!res.ok) showToast(res.error ?? t.logsFileOpenFailed(file.name), { variant: 'error' });
      } catch (err) {
        showToast(String(err), { variant: 'error' });
      }
    },
    [showToast]
  );

  const handleDeleteFile = useCallback(
    async (file: LogFileInfo) => {
      setConfirmDeleteFile(null);
      try {
        const res = await window.pi.deleteLogFile(file.name);
        if (!res.ok) {
          showToast(res.error ?? t.logsSaveFailed, { variant: 'error' });
          return;
        }
        showToast(t.logsFileDeleted(file.name), { variant: 'success' });
        await load();
        await refreshPreview(preview);
      } catch (err) {
        showToast(String(err), { variant: 'error' });
      }
    },
    [load, preview, refreshPreview, showToast]
  );

  /**
   * 保存（部分字段）→ 立即生效。
   * 失败不写回界面，而走全局 toast；同时重新拉配置，把开关回滚到磁盘现状，
   * 避免「界面翻了、磁盘没变」的静默不一致。
   */
  const save = useCallback(
    async (patch: Partial<LogConfig>) => {
      try {
        const res = await window.pi.setLogConfig(patch);
        if (!res.ok || !res.config) {
          showToast(res.error ?? t.logsSaveFailed, { variant: 'error' });
          await load();
          return;
        }
        setConfig(res.config);
        setRetentionText(String(res.config.retentionDays));
      } catch (err) {
        showToast(String(err), { variant: 'error' });
        await load();
      }
    },
    [load, showToast]
  );

  /**
   * 打开日志目录。日志默认不启用，目录可能从未创建过（`shell.openPath` 对不存在路径会报错），
   * 所以必须 catch，否则 renderer 里是一次未捕获的 rejection。
   */
  const handleOpenDir = useCallback(async () => {
    try {
      await window.pi.openWith(dir, 'default');
    } catch {
      showToast(t.logsDirMissing(dir), { variant: 'error' });
    }
  }, [dir, showToast]);

  const handleClear = useCallback(async () => {
    setConfirmClear(false);
    try {
      const res = await window.pi.clearLogs();
      if (!res.ok) {
        showToast(res.error ?? t.logsSaveFailed, { variant: 'error' });
        return;
      }
      // 结果用全局 toast 提示（自动消失），不在设置页里留常驻文字
      showToast(t.logsCleared(res.removed ?? 0), { variant: 'success' });
      await load();
      await refreshPreview(preview);
    } catch (err) {
      showToast(String(err), { variant: 'error' });
    }
  }, [load, preview, refreshPreview, showToast]);

  const numberInputCls =
    'w-24 rounded border border-od-border-light bg-od-bg px-2 py-1 text-left text-xs text-od-text-bright placeholder:text-od-text-dim';

  if (loading || !config) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-od-text-dim">
        <Icon name="spinner" className="w-3" />
        {t.classifierLoading}
      </div>
    );
  }

  const enabled = config.enabled;

  return (
    <>
      <div className="mb-4 rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs leading-relaxed text-od-text-dim">
        {t.logsDesc}
      </div>

      {/* === 基本设置 === */}
      <div className="mb-4 rounded border border-od-border bg-od-bg-alt px-3 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-od-text-bright">{t.logsEnabled}</div>
            <div className="mt-0.5 text-[0.7rem] leading-relaxed text-od-text-dim">
              {t.logsEnabledHint}
            </div>
          </div>
          <Switch
            checked={config.enabled}
            onChange={(v) => void save({ enabled: v })}
            ariaLabel={t.logsEnabled}
          />
        </div>

        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-od-text-bright">{t.logsLevelLabel}</div>
            <div className="mt-0.5 text-[0.7rem] leading-relaxed text-od-text-dim">
              {t.logsLevelHint}
            </div>
          </div>
          <Dropdown
            value={config.level}
            onChange={(v) => void save({ level: v as LogLevel })}
            disabled={!enabled}
            triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-44`}
            panelWidth="w-56"
            ariaLabel={t.logsLevelLabel}
            options={LEVEL_OPTIONS}
          />
        </div>

        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-od-text-bright">{t.logsRetentionLabel}</div>
            <div className="mt-0.5 text-[0.7rem] leading-relaxed text-od-text-dim">
              {t.logsRetentionHint}
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={365}
            value={retentionText}
            disabled={!enabled}
            onChange={(e) => setRetentionText(e.target.value)}
            onBlur={() => {
              const n = Number(retentionText);
              if (Number.isFinite(n) && n > 0) void save({ retentionDays: n });
              else setRetentionText(String(config.retentionDays));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={numberInputCls}
          />
        </div>

        <div className="flex items-center gap-2 border-t border-od-border pt-3 text-xs text-od-text-dim">
          <Icon name="folder" className="w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={dir}>
            {t.logsDirLabel}：{dir}
          </span>
          <button
            type="button"
            onClick={() => void handleOpenDir()}
            className="flex shrink-0 items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent hover:bg-od-accent/25"
          >
            <Icon name="folder" className="w-3" />
            {t.logsOpenDir}
          </button>
        </div>
      </div>

      {/* === 按功能开关 === */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.logsChannelsTitle}</h3>
        {/* 默认关闭后，未启用时这排开关全是灰的：给一行说明，避免误以为开关坏了 */}
        {!enabled && (
          <div className="mb-2 rounded border border-od-border bg-od-bg-alt px-3 py-2 text-[0.7rem] leading-relaxed text-od-text-dim">
            {t.logsChannelsDisabledHint}
          </div>
        )}
        <div className="space-y-1">
          {channels.map((channel) => {
            const text = CHANNEL_TEXT[channel];
            return (
              <div
                key={channel}
                className="flex items-center justify-between gap-3 rounded border border-od-border bg-od-bg-alt px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs text-od-text-bright">
                    {text?.label ?? channel}
                    <span className="ml-2 font-mono text-[0.7rem] text-od-text-dim">{channel}</span>
                  </div>
                  {text && (
                    <div className="mt-0.5 text-[0.7rem] leading-relaxed text-od-text-dim">
                      {text.desc}
                    </div>
                  )}
                </div>
                <Switch
                  checked={enabled && (config.channels[channel] ?? true)}
                  disabled={!enabled}
                  onChange={(v) => void save({ channels: { [channel]: v } })}
                  ariaLabel={text?.label ?? channel}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* === 日志文件 === */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-od-text">{t.logsFilesTitle}</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={files.length === 0}
              className="flex items-center gap-1 rounded bg-od-red/15 px-2 py-1 text-xs text-od-red hover:bg-od-red/25 disabled:opacity-50"
            >
              <Icon name="delete" className="w-3" />
              {t.logsClear}
            </button>
          </div>
        </div>
        {files.length === 0 ? (
          <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
            {t.logsFilesEmpty}
          </div>
        ) : (
          <div className="space-y-1">
            {grouped.map((group) => {
              const open = !collapsedGroups[group.channel];
              const totalBytes = group.files.reduce((sum, file) => sum + file.sizeBytes, 0);
              return (
                <div key={group.channel}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.channel)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-2 rounded border border-od-border bg-od-bg-alt px-3 py-1.5 text-left hover:bg-od-bg-hover"
                  >
                    <Icon
                      name={open ? 'chevronDown' : 'chevronRight'}
                      className="w-3 shrink-0 text-od-text-dim"
                    />
                    <span className="text-xs text-od-text-bright">{group.label}</span>
                    <span className="font-mono text-[0.7rem] text-od-text-dim">
                      {group.channel}
                    </span>
                    <span className="ml-auto shrink-0 text-[0.7rem] text-od-text-dim">
                      {t.logsGroupFiles(group.files.length)} · {formatBytes(totalBytes)}
                    </span>
                  </button>
                  {open && (
                    <div className="mt-1 space-y-1 pl-3">
                      {group.files.map((file) => (
                        <div
                          key={file.name}
                          className="flex items-center justify-between gap-3 rounded border border-od-border bg-od-bg-alt px-3 py-1.5 text-xs"
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-od-text-bright"
                            title={file.name}
                          >
                            {file.name}
                          </span>
                          {file.rotated && (
                            <span className="shrink-0 rounded bg-od-yellow/20 px-1.5 py-0.5 text-[0.7rem] text-od-yellow">
                              {t.logsRotated}
                            </span>
                          )}
                          <span className="shrink-0 text-od-text-dim">
                            {formatBytes(file.sizeBytes)}
                          </span>
                          <span className="shrink-0 text-od-text-dim">
                            {formatTime(file.mtimeMs)}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void handleOpenFile(file)}
                              title={t.logsFileOpen}
                              className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-0.5 text-xs text-od-accent hover:bg-od-accent/25"
                            >
                              <Icon name="external" className="w-3" />
                              {t.logsFileOpen}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteFile(file)}
                              title={t.logsFileDelete}
                              className="flex items-center gap-1 rounded bg-od-red/15 px-2 py-0.5 text-xs text-od-red hover:bg-od-red/25"
                            >
                              <Icon name="delete" className="w-3" />
                              {t.logsFileDelete}
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-2 text-[0.7rem] leading-relaxed text-od-text-dim">{t.logsFilesHint}</div>
      </div>

      {/* === 最近日志预览 === */}
      <div className="mb-2">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-od-text">{t.logsPreviewTitle}</h3>
          <div className="flex items-center gap-2">
            <Dropdown
              value={preview}
              onChange={(v) => setPreview(v as LogChannelId)}
              triggerClassName={`${DROPDOWN_TRIGGER_CLASS} w-40`}
              panelWidth="w-44"
              ariaLabel={t.logsPreviewChannelLabel}
              options={channels.map((channel) => ({
                value: channel,
                label: CHANNEL_TEXT[channel]?.label ?? channel
              }))}
            />
            <button
              type="button"
              onClick={() => void refreshPreview(preview)}
              className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent hover:bg-od-accent/25"
            >
              <Icon name="retry" className="w-3" />
              {t.logsPreviewRefresh}
            </button>
          </div>
        </div>
        {lines.length === 0 ? (
          <div className="rounded border border-od-border bg-od-bg-alt px-3 py-2 text-xs text-od-text-dim">
            {t.logsPreviewEmpty}
          </div>
        ) : (
          <div className="rounded border border-od-border bg-od-bg-alt">
            <div className="border-b border-od-border px-3 py-1 text-[0.7rem] text-od-text-dim">
              {t.logsPreviewLines(lines.length)}
            </div>
            <div className="max-h-80 overflow-y-auto px-3 py-2">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className="break-all font-mono text-[0.7rem] leading-relaxed text-od-text-dim"
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t.logsClearTitle}
        message={t.logsClearMessage}
        confirmText={t.logsClearConfirm}
        danger
        onConfirm={() => void handleClear()}
        onClose={() => setConfirmClear(false)}
      />

      <ConfirmDialog
        open={confirmDeleteFile !== null}
        title={t.logsFileDeleteTitle}
        message={t.logsFileDeleteMessage(confirmDeleteFile?.name ?? '')}
        confirmText={t.logsFileDelete}
        danger
        onConfirm={() => {
          const file = confirmDeleteFile;
          if (file) void handleDeleteFile(file);
        }}
        onClose={() => setConfirmDeleteFile(null)}
      />
    </>
  );
}
