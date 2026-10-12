import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import McpIcon from '../common/McpIcon';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

interface ServerStatus {
  name: string;
  entry: {
    command?: string;
    args?: string[];
    url?: string;
    transport?: string;
    disabled?: boolean;
    builtin?: boolean;
  };
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * MCP 状态弹窗：展示所有配置的 MCP 服务器连接状态。
 * 通过 /mcp 命令或设置页触发。
 */
export default function McpStatusModal() {
  const { mcpStatusOpen, setMcpStatusOpen } = usePiStore(
    useShallow((s) => ({ mcpStatusOpen: s.mcpStatusOpen, setMcpStatusOpen: s.setMcpStatusOpen }))
  );
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const isMac = window.pi?.platform === 'darwin';

  useEffect(() => {
    if (!mcpStatusOpen) return;
    setLoading(true);
    window.pi
      .getMcpStatus()
      .then((st) => {
        setStatuses(st);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [mcpStatusOpen]);

  if (!mcpStatusOpen) return null;

  const connectedCount = statuses.filter((s) => s.connected).length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center bg-black/60"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={() => setMcpStatusOpen(false)}
    >
      <div
        className="flex min-h-0 w-full max-w-lg flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2 shrink-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <McpIcon className="w-4 h-4 text-od-accent" />
            {t.tabMcp}
            <span className="text-xs font-normal text-od-text-dim">
              ({connectedCount}/{statuses.length})
            </span>
          </h2>
          <button
            onClick={() => setMcpStatusOpen(false)}
            className="text-od-text-dim hover:text-od-text-bright"
            title={t.closePanel}
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {loading ? (
            <div className="py-4 text-center text-xs text-od-text-dim">{t.loading}</div>
          ) : statuses.length === 0 ? (
            <div className="py-4 text-center text-xs text-od-text-dim">{t.mcpNoServers}</div>
          ) : (
            <div className="space-y-1.5">
              {statuses.map((s) => {
                const isHttp = !!s.entry.url;
                const typeLabel = s.entry.builtin
                  ? '内置'
                  : isHttp
                    ? s.entry.transport === 'sse'
                      ? 'SSE'
                      : 'HTTP'
                    : 'stdio';
                return (
                  <div
                    key={s.name}
                    className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-3 py-2"
                  >
                    <McpIcon
                      className={`w-4 h-4 shrink-0 mt-0.5 ${s.connected ? 'text-od-green' : 'text-od-text-dim'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-od-text-bright">{s.name}</span>
                        <span className="shrink-0 rounded bg-od-bg-hover px-1.5 py-0.5 text-xs text-od-text-dim">
                          {typeLabel}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                            s.connected
                              ? 'bg-od-green/20 text-od-green'
                              : 'bg-od-bg-hover text-od-text-dim'
                          }`}
                        >
                          {s.connected ? t.mcpConnected : t.mcpDisconnected}
                        </span>
                      </div>
                      <div className="truncate text-xs text-od-text-dim mt-0.5">
                        {isHttp
                          ? s.entry.url
                          : `${s.entry.command || ''} ${(s.entry.args || []).join(' ')}`}
                      </div>
                      {s.connected && s.toolCount > 0 && (
                        <div className="text-xs text-od-accent mt-0.5">
                          {t.mcpToolCount(s.toolCount)}
                        </div>
                      )}
                      {s.error && <div className="text-xs text-od-red mt-0.5">{s.error}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
