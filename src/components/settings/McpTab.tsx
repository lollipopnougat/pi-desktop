import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import McpIcon from '../common/McpIcon';
import Switch from '../common/Switch';
import ConfirmDialog from '../common/ConfirmDialog';
import { t } from '../../i18n/zh';
import { usePiStore } from '../../store/pi-store';

interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: 'streamable-http' | 'sse';
  bearerToken?: string;
  bearerTokenEnv?: string;
  disabled?: boolean;
}

interface ServerStatus {
  name: string;
  entry: ServerEntry;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export default function McpTab({
  projectMode = false,
  projectCwd
}: { projectMode?: boolean; projectCwd?: string } = {}) {
  const [servers, setServers] = useState<Record<string, ServerEntry>>({});
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [autoConnect, setAutoConnect] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerEntry>({ command: '', args: [] });
  const showToast = usePiStore((state) => state.showToast);
  const [serverTools, setServerTools] = useState<
    Record<string, { name: string; description: string }[]>
  >({});
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const config = projectMode
        ? await window.pi.getProjectMcpConfig(projectCwd)
        : await window.pi.getMcpConfig();
      setServers(config.mcpServers || {});
      // 始终加载状态（合并配置显示所有服务器，含项目级）
      const st = await window.pi.getMcpStatus();
      setStatuses(st);
      if (!projectMode) {
        const ac = await window.pi.getMcpAutoConnect();
        setAutoConnect(ac);
      }
    } catch {}
  };

  const handleSave = async (name: string, entry: ServerEntry) => {
    try {
      const config = projectMode
        ? await window.pi.getProjectMcpConfig(projectCwd)
        : await window.pi.getMcpConfig();
      config.mcpServers[name] = entry;
      let result: { ok: boolean; error?: string };
      if (projectMode) {
        result = await window.pi.saveProjectMcpConfig(config, projectCwd);
      } else {
        result = await window.pi.saveMcpConfig(config);
      }
      if (!result.ok) throw new Error(result.error || t.mcpSaveFail);
      setServers(config.mcpServers);
      setEditingName(null);
      await loadAll();
      showToast(t.mcpSaveSuccess, { variant: 'success' });
    } catch (e: any) {
      showToast(e?.message || t.mcpSaveFail, { variant: 'error' });
    }
  };

  const handleDelete = async (name: string) => {
    setConfirmDelete(name);
  };

  const performDelete = async () => {
    const name = confirmDelete;
    if (!name) return;
    try {
      const config = projectMode
        ? await window.pi.getProjectMcpConfig(projectCwd)
        : await window.pi.getMcpConfig();
      delete config.mcpServers[name];
      if (projectMode) {
        await window.pi.saveProjectMcpConfig(config, projectCwd);
      } else {
        await window.pi.saveMcpConfig(config);
        await window.pi.disconnectMcpServer(name);
      }
      setServers(config.mcpServers);
      await loadAll();
    } catch (e) {
      // 原来是空 catch：删除失败被静默吞掉，列表没变但用户不知道原因
      showToast(t.mcpDeleteFail(e instanceof Error ? e.message : String(e)), { variant: 'error' });
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleConnect = async (name: string) => {
    const entry = servers[name];
    if (!entry) return;
    const result = await window.pi.connectMcpServer(name, entry);
    if (result.connected) {
      // 获取工具列表并自动展开
      const tools = await window.pi.getMcpTools();
      const myTools = tools
        .filter((t: any) => t.name.startsWith(`mcp__${name}__`))
        .map((t: any) => ({
          name: t.name.replace(`mcp__${name}__`, ''),
          description: t.description
        }));
      setServerTools((prev) => ({ ...prev, [name]: myTools }));
      setExpandedServers((prev) => ({ ...prev, [name]: true }));
    } else {
      showToast(t.mcpConnectFail(result.error || '未知错误'), { variant: 'error' });
    }
    await loadAll();
  };

  const handleDisconnect = async (name: string) => {
    await window.pi.disconnectMcpServer(name);
    setServerTools((prev) => {
      const n = { ...prev };
      delete n[name];
      return n;
    });
    setExpandedServers((prev) => {
      const n = { ...prev };
      delete n[name];
      return n;
    });
    await loadAll();
  };

  const handleToggleAutoConnect = async (v: boolean) => {
    setAutoConnect(v);
    await window.pi.setMcpAutoConnect(v);
  };

  const startAdd = () => {
    setEditingName('__new__');
    setDraft({ command: '', args: [] });
  };

  const startEdit = (name: string) => {
    setEditingName(name);
    setDraft({ ...servers[name] });
  };

  const isAdding = editingName === '__new__';

  const statusOf = (name: string): ServerStatus | undefined =>
    statuses.find((s) => s.name === name);

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-od-text">{t.mcpTitle}</h3>
          <div className="text-xs text-od-text-dim">{t.mcpDesc}</div>
        </div>
        {/* 添加服务器按钮：表单已弹窗化，编辑中无需隐藏 */}
        {
          <button
            onClick={startAdd}
            className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-1 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
          >
            <Icon name="plus" className="w-3" />
            {t.mcpAddServer}
          </button>
        }
      </div>

      {/* autoConnect 开关（仅全局模式） */}
      {!projectMode && (
        <div className="mb-3 flex items-center justify-between rounded border border-od-border bg-od-bg-alt px-3 py-2">
          <div>
            <div className="text-xs text-od-text-bright">{t.mcpAutoConnect}</div>
            <div className="text-xs text-od-text-dim">{t.mcpAutoConnectDesc}</div>
          </div>
          <Switch
            checked={autoConnect}
            onChange={(v) => handleToggleAutoConnect(v)}
            ariaLabel={t.mcpAutoConnect}
          />
        </div>
      )}

      {/* 服务器列表 */}
      <div className="space-y-1">
        {Object.keys(servers).length === 0 && (
          <div className="py-2 text-xs text-od-text-dim">{t.mcpNoServers}</div>
        )}

        {Object.entries(servers).map(([name, entry]) => {
          const st = statusOf(name);
          const isHttp = !!entry.url;
          const transportLabel = isHttp
            ? entry.transport === 'sse'
              ? 'SSE'
              : 'HTTP'
            : t.mcpTypeStdio;
          return (
            <div key={name} className="rounded border border-od-border bg-od-bg-alt px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <McpIcon className="w-3 h-3 shrink-0 text-od-green" />
                    <span className="text-sm text-od-text-bright">{name}</span>
                    <span className="shrink-0 rounded bg-od-bg-hover px-1.5 py-0.5 text-xs text-od-text-dim">
                      {isHttp ? (entry.transport === 'sse' ? 'SSE' : 'HTTP') : t.mcpTypeStdio}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                        st?.connected
                          ? 'bg-od-green/20 text-od-green'
                          : 'bg-od-bg-hover text-od-text-dim'
                      }`}
                    >
                      {st?.connected ? t.mcpConnected : t.mcpDisconnected}
                      {st?.connected && st.toolCount > 0 ? ` (${st.toolCount})` : ''}
                    </span>
                  </div>
                  <div className="truncate text-xs text-od-text-dim">
                    {isHttp ? entry.url : `${entry.command} ${(entry.args || []).join(' ')}`}
                  </div>
                  {st?.error && <div className="text-xs text-od-red">{st.error}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    onClick={() => (st?.connected ? handleDisconnect(name) : handleConnect(name))}
                    className={`rounded px-2 py-0.5 text-xs ${
                      st?.connected
                        ? 'text-od-text-dim hover:bg-od-bg-hover'
                        : 'text-od-accent hover:bg-od-accent/20'
                    }`}
                  >
                    {st?.connected ? t.mcpDisconnect : t.mcpConnect}
                  </button>
                  <button
                    onClick={() => startEdit(name)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-text hover:bg-od-bg-hover"
                  >
                    <Icon name="edit2" className="w-3" />
                  </button>
                  <button
                    onClick={() => handleDelete(name)}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-od-red hover:bg-od-red/20"
                  >
                    <Icon name="delete" className="w-3" />
                  </button>
                </div>
              </div>

              {/* 工具列表展开 */}
              {st?.connected && serverTools[name] && serverTools[name].length > 0 && (
                <div className="mt-1.5 border-t border-od-border pt-1.5">
                  <button
                    onClick={() => setExpandedServers((prev) => ({ ...prev, [name]: !prev[name] }))}
                    className="flex items-center gap-1 text-xs text-od-text-dim hover:text-od-text-bright"
                  >
                    <Icon
                      name={expandedServers[name] ? 'chevronDown' : 'chevronRight'}
                      className="w-2.5"
                    />
                    {t.mcpToolCount(serverTools[name].length)}
                  </button>
                  {expandedServers[name] && (
                    <div className="mt-1.5 space-y-1 pl-4">
                      {serverTools[name].map((tool, ti) => (
                        <div key={ti} className="flex items-start gap-1.5">
                          <Icon name="tool" className="w-3 shrink-0 mt-1 text-od-yellow" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-mono text-od-text-bright">{tool.name}</div>
                            {tool.description && (
                              <div className="text-xs text-od-text-dim break-all">
                                {tool.description}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 编辑/新增弹窗：服务器多时内联表单在列表下方不便操作，改为居中弹窗 */}
      {editingName && (
        <McpEditModal
          open
          title={isAdding ? t.mcpAddServerTitle : t.mcpEditServer}
          name={isAdding ? '' : editingName}
          entry={draft}
          onSave={handleSave}
          onCancel={() => setEditingName(null)}
        />
      )}

      {/* 删除服务器二次确认 */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t.mcpDelete}
        message={confirmDelete ? t.mcpDeleteConfirm(confirmDelete) : ''}
        confirmText={t.delete}
        danger
        onConfirm={performDelete}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** 添加/编辑 MCP 服务器弹窗：遮罩居中卡片，服务器列表很长时不再被内联表单挤到下方 */
function McpEditModal({
  open,
  title,
  name,
  entry,
  onSave,
  onCancel
}: {
  open: boolean;
  title: string;
  name: string;
  entry: ServerEntry;
  onSave: (name: string, entry: ServerEntry) => void;
  onCancel: () => void;
}) {
  const [formName, setFormName] = useState(name);
  const [isHttp, setIsHttp] = useState(!!entry.url);
  const [transport, setTransport] = useState<'streamable-http' | 'sse'>(
    entry.transport || 'streamable-http'
  );
  const [command, setCommand] = useState(entry.command || '');
  const [argsStr, setArgsStr] = useState((entry.args || []).join(' '));
  const [url, setUrl] = useState(entry.url || '');
  const [envStr, setEnvStr] = useState(
    entry.env
      ? Object.entries(entry.env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      : ''
  );
  const [bearerToken, setBearerToken] = useState(entry.bearerToken || '');
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>(
    entry.headers ? Object.entries(entry.headers).map(([k, v]) => ({ key: k, value: v })) : []
  );

  const handleSave = () => {
    if (!formName.trim()) return;
    const result: ServerEntry = {};
    if (isHttp) {
      result.url = url.trim();
      result.transport = transport;
      if (bearerToken.trim()) result.bearerToken = bearerToken.trim();
      const headers: Record<string, string> = {};
      for (const row of headerRows) {
        const k = row.key.trim();
        if (k) headers[k] = row.value.trim();
      }
      if (Object.keys(headers).length) result.headers = headers;
    } else {
      result.command = command.trim();
      result.args = argsStr.trim().split(/\s+/).filter(Boolean);
      const env: Record<string, string> = {};
      for (const line of envStr.split('\n')) {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) env[m[1].trim()] = m[2].trim();
      }
      if (Object.keys(env).length) result.env = env;
    }
    onSave(formName.trim(), result);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[80vh] w-[34rem] flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <McpIcon className="w-3.5 h-3.5 text-od-green" />
            {title}
          </div>
          <button onClick={onCancel} className="text-od-text-dim hover:text-od-text-bright">
            <Icon name="close" size="sm" />
          </button>
        </div>

        {/* 表单主体（可滚动） */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-2 flex gap-2">
            <button
              onClick={() => setIsHttp(false)}
              className={`rounded px-2 py-0.5 text-xs ${
                !isHttp ? 'bg-od-accent text-white' : 'bg-od-bg-hover text-od-text'
              }`}
            >
              {t.mcpTypeStdio}
            </button>
            <button
              onClick={() => setIsHttp(true)}
              className={`rounded px-2 py-0.5 text-xs ${
                isHttp ? 'bg-od-accent text-white' : 'bg-od-bg-hover text-od-text'
              }`}
            >
              {t.mcpTypeHttp}
            </button>
          </div>

          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t.mcpServerName}
            className="mb-2 w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
          />

          {isHttp ? (
            <>
              {/* 传输类型选择 */}
              <div className="mb-2 flex gap-2">
                <button
                  onClick={() => setTransport('streamable-http')}
                  className={`rounded px-2 py-0.5 text-xs ${
                    transport === 'streamable-http'
                      ? 'bg-od-accent text-white'
                      : 'bg-od-bg-hover text-od-text'
                  }`}
                >
                  Streamable HTTP
                </button>
                <button
                  onClick={() => setTransport('sse')}
                  className={`rounded px-2 py-0.5 text-xs ${
                    transport === 'sse' ? 'bg-od-accent text-white' : 'bg-od-bg-hover text-od-text'
                  }`}
                >
                  SSE
                </button>
              </div>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`${t.mcpUrl}（支持 $ENV_VAR 插值）`}
                className="mb-2 w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
              />
              {/* 请求头：每行两个输入框 + 删除按钮 */}
              <div className="mb-1 text-xs text-od-text-dim">{t.mcpHeaders}（值支持 $ENV_VAR）</div>
              <div className="mb-2 space-y-1">
                {headerRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-1">
                    <input
                      value={row.key}
                      onChange={(e) => {
                        const next = [...headerRows];
                        next[idx] = { ...row, key: e.target.value };
                        setHeaderRows(next);
                      }}
                      placeholder="Key"
                      className="w-1/3 rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
                    />
                    <input
                      value={row.value}
                      onChange={(e) => {
                        const next = [...headerRows];
                        next[idx] = { ...row, value: e.target.value };
                        setHeaderRows(next);
                      }}
                      placeholder="Value（支持 $ENV_VAR）"
                      className="flex-1 rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
                    />
                    <button
                      onClick={() => setHeaderRows(headerRows.filter((_, i) => i !== idx))}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-od-text-dim hover:bg-od-red/20 hover:text-od-red"
                      title={t.remove}
                    >
                      <Icon name="delete" className="w-3" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setHeaderRows([...headerRows, { key: '', value: '' }])}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-od-accent hover:bg-od-accent/20"
                >
                  <Icon name="plus" className="w-3" />
                  添加请求头
                </button>
              </div>
              {/* Bearer token */}
              <input
                value={bearerToken}
                onChange={(e) => setBearerToken(e.target.value)}
                placeholder="Bearer Token（支持 $ENV_VAR）"
                className="mb-2 w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
              />
            </>
          ) : (
            <>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={`${t.mcpCommand}（支持 $ENV_VAR 插值）`}
                className="mb-2 w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
              />
              <input
                value={argsStr}
                onChange={(e) => setArgsStr(e.target.value)}
                placeholder={`${t.mcpArgs} (空格分隔，支持 $ENV_VAR)`}
                className="mb-2 w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
              />
              <textarea
                value={envStr}
                onChange={(e) => setEnvStr(e.target.value)}
                placeholder={`${t.mcpEnv} (每行 KEY=value，可引用 $OTHER_VAR)`}
                rows={2}
                className="w-full rounded border border-od-border-light bg-od-bg px-2 py-1 text-xs text-od-text-bright"
              />
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 border-t border-od-border px-4 py-2.5">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1 text-xs text-od-text hover:bg-od-bg-hover"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!formName.trim()}
            className="rounded bg-od-accent px-3 py-1 text-xs text-white hover:bg-od-accent/80 disabled:opacity-50"
          >
            {t.saveProvider}
          </button>
        </div>
      </div>
    </div>
  );
}
