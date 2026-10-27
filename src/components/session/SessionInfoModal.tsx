import { useEffect, useState } from 'react';
import Icon from '../common/Icon';
import McpIcon from '../common/McpIcon';
import { t } from '../../i18n/zh';

/** 会话属性弹窗数据（与 pi:getSessionInfo 返回结构一致，见 misc-ipc.ts） */
interface SessionInfoDetail {
  systemPrompt: string;
  systemPromptSources: { path: string }[];
  tools: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    active: boolean;
    source: string;
  }[];
  skills: {
    name: string;
    description: string;
    filePath: string;
    baseDir?: string;
    scope?: string;
    origin?: string;
    disableModelInvocation: boolean;
    /** 内置只读技能（随安装包发布） */
    builtin?: boolean;
  }[];
  prompts: { name: string; description: string; argumentHint: string; filePath: string }[];
  extCommands: { name: string; description: string }[];
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  cwd: string;
  sessionId: string;
  sessionFile: string | null;
  sessionName: string | undefined;
}

interface SessionInfoModalProps {
  onClose: () => void;
}

/**
 * 会话属性弹窗：横向 tab 展示系统提示词 / 工具 / 技能 / MCP。
 * 数据来自主进程 pi:getSessionInfo（misc-ipc.ts），加载失败时展示错误并允许重试。
 * prompts 模板与扩展命令归入「技能」tab（同为会话注入资源）。
 */
type InfoTab = 'prompt' | 'tools' | 'skills' | 'mcp';

export default function SessionInfoModal({ onClose }: SessionInfoModalProps) {
  const isMac = window.pi?.platform === 'darwin';
  const [info, setInfo] = useState<SessionInfoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showInactiveTools, setShowInactiveTools] = useState(false);
  const [mcpStatuses, setMcpStatuses] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<InfoTab>('prompt');

  useEffect(() => {
    let cancelled = false;
    window.pi
      .getSessionInfo()
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || t.sessionInfoLoadFailed);
      });
    // 加载 MCP 服务器状态
    window.pi
      .getMcpStatus()
      .then((st) => {
        if (!cancelled) setMcpStatuses(st);
      })
      .catch(() => {});
    // 订阅 thinking_level_changed 事件：modal 打开期间切换思考等级也能实时更新
    const unsubscribe = window.pi.onEvent((event: any) => {
      if (cancelled) return;
      if (event.type === 'thinking_level_changed') {
        setInfo((prev) => (prev ? { ...prev, thinkingLevel: event.level ?? 'off' } : prev));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const copySystemPrompt = async () => {
    if (!info?.systemPrompt) return;
    try {
      await navigator.clipboard.writeText(info.systemPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const activeTools = info?.tools.filter((x) => x.active) ?? [];
  const inactiveTools = info?.tools.filter((x) => !x.active) ?? [];

  // count 省略 = 不显示数字（系统提示词只有一段，数字没有意义）
  const tabs: { key: InfoTab; label: string; count?: number }[] = info
    ? [
        { key: 'prompt', label: t.sessionInfoSystemPrompt },
        { key: 'tools', label: t.sessionInfoTools, count: activeTools.length },
        {
          key: 'skills',
          label: t.sessionInfoSkills,
          count: info.skills.length + info.prompts.length + info.extCommands.length
        },
        { key: 'mcp', label: t.tabMcp, count: mcpStatuses.length }
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col items-center bg-black/60"
      style={{ paddingTop: isMac ? 38 : 32 }}
      onClick={onClose}
    >
      <div
        className="flex min-h-0 w-full max-w-3xl flex-1 flex-col rounded-lg border border-od-border-light bg-od-bg-alt shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-od-border px-4 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
            <Icon name="info" className="w-3.5 text-od-accent" />
            {t.sessionInfoTitle}
          </h2>
          <button onClick={onClose} className="text-od-text-dim hover:text-od-text-bright">
            <Icon name="close" size="sm" />
          </button>
        </div>

        {error && !info ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-xs text-od-red">
            <span>{error}</span>
            <button
              onClick={() => {
                setError(null);
                window.pi
                  .getSessionInfo()
                  .then(setInfo)
                  .catch((e: any) => setError(e?.message || t.sessionInfoLoadFailed));
              }}
              className="rounded bg-od-accent px-2 py-0.5 text-xs text-white hover:bg-od-accent/80 active:bg-od-accent/65"
            >
              {t.reload}
            </button>
          </div>
        ) : !info ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-od-text-dim">
            <Icon name="spinner" spin className="w-3" />
            {t.loadingDots}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col text-xs">
            {/* 会话元信息（tab 上方固定展示） */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-od-border px-4 py-2 text-od-text-dim">
              {info.model && (
                <span>
                  {t.sessionInfoModel}: {info.model.provider}/{info.model.id}
                </span>
              )}
              <span>
                {t.sessionInfoThinking}: {info.thinkingLevel}
              </span>
              <span title={info.cwd}>
                {t.sessionInfoCwd}: {info.cwd}
              </span>
            </div>

            {/* 横向 tab 栏 */}
            <div className="flex shrink-0 items-center gap-1 border-b border-od-border px-3 pt-1.5">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 rounded-t border-b-2 px-3 py-1.5 transition-colors ${
                    activeTab === tab.key
                      ? 'border-od-accent text-od-text-bright'
                      : 'border-transparent text-od-text-dim hover:text-od-text'
                  }`}
                >
                  {tab.key === 'mcp' ? (
                    <McpIcon className="h-3 w-3" />
                  ) : tab.key === 'prompt' ? (
                    <Icon name="file" className="w-3" />
                  ) : tab.key === 'tools' ? (
                    <Icon name="tool" className="w-3" />
                  ) : (
                    <Icon name="brain" className="w-3" />
                  )}
                  {tab.label}
                  {typeof tab.count === 'number' && tab.count > 0 && (
                    <span className="text-od-text-dim">({tab.count})</span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab 内容区（独立滚动，不再整体长滚动） */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {/* ── Tab: 系统提示词 ── */}
              {activeTab === 'prompt' && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="flex items-center gap-1 font-medium text-od-text-bright">
                      {info.systemPromptSources.length > 0 && (
                        <span className="font-normal text-od-text-dim">
                          {info.systemPromptSources.map((s) => s.path).join(', ')}
                        </span>
                      )}
                    </h3>
                    {info.systemPrompt && (
                      <button
                        onClick={copySystemPrompt}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                        title={t.copyPrompt}
                      >
                        <Icon name="copy" className="w-3" />
                        {copied ? t.copied : t.copyPrompt}
                      </button>
                    )}
                  </div>
                  {info.systemPrompt ? (
                    <pre className="whitespace-pre-wrap break-words rounded border border-od-border bg-od-bg-dark p-2 font-mono text-xs leading-relaxed text-od-text">
                      {info.systemPrompt}
                    </pre>
                  ) : (
                    <div className="rounded border border-od-border bg-od-bg-dark p-2 text-od-text-dim">
                      {t.sessionInfoNoSystemPrompt}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: 工具 ── */}
              {activeTab === 'tools' && (
                <div>
                  <h3 className="mb-1 flex items-center gap-1 font-medium text-od-text-bright">
                    <Icon name="tool" className="w-3 text-od-accent" />
                    {t.sessionInfoTools} ({activeTools.length}
                    {inactiveTools.length > 0 ? `/${info.tools.length}` : ''})
                  </h3>
                  {activeTools.length === 0 && inactiveTools.length === 0 ? (
                    <div className="rounded border border-od-border bg-od-bg-dark p-2 text-od-text-dim">
                      {t.sessionInfoNoTools}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {activeTools.map((tool) => (
                        <div
                          key={tool.name}
                          className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                        >
                          {/* 左栏：工具名 + 来源路径 */}
                          <div className="shrink-0 w-[40%] min-w-0">
                            <span className="inline-block break-all rounded bg-od-accent/20 px-1 py-0.5 font-mono text-xs text-od-accent">
                              {tool.name}
                            </span>
                            {tool.source && (
                              <div
                                className="mt-0.5 break-all font-mono text-xs text-od-text-dim"
                                title={tool.source}
                              >
                                {tool.source}
                              </div>
                            )}
                          </div>
                          {/* 右栏：描述填满剩余空间 */}
                          <span className="min-w-0 flex-1 text-od-text">
                            {tool.label || tool.description || tool.promptSnippet}
                          </span>
                        </div>
                      ))}
                      {inactiveTools.length > 0 && (
                        <>
                          <button
                            onClick={() => setShowInactiveTools((v) => !v)}
                            className="text-od-text-dim transition-colors hover:text-od-text-bright"
                          >
                            {showInactiveTools
                              ? t.collapse
                              : t.expandInactiveTools(inactiveTools.length)}
                          </button>
                          {showInactiveTools && (
                            <div className="space-y-1 pl-3">
                              {inactiveTools.map((tool) => (
                                <div
                                  key={tool.name}
                                  className="flex items-start gap-2 rounded border border-od-border/60 bg-od-bg-dark/60 px-2 py-1.5 opacity-70"
                                >
                                  {/* 左栏：工具名 + 来源路径 */}
                                  <div className="shrink-0 w-[40%] min-w-0">
                                    <span className="inline-block break-all rounded bg-od-bg-hover px-1 py-0.5 font-mono text-xs text-od-text-dim">
                                      {tool.name}
                                    </span>
                                    {tool.source && (
                                      <div
                                        className="mt-0.5 break-all font-mono text-xs text-od-text-dim"
                                        title={tool.source}
                                      >
                                        {tool.source}
                                      </div>
                                    )}
                                  </div>
                                  {/* 右栏：描述填满剩余空间 */}
                                  <span className="min-w-0 flex-1 text-od-text-dim">
                                    {tool.label || tool.description || tool.promptSnippet}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: 技能（Skills + Prompts 模板 + 扩展命令） ── */}
              {activeTab === 'skills' && (
                <div className="space-y-4">
                  {/* Skills */}
                  <div>
                    <h3 className="mb-1 flex items-center gap-1 font-medium text-od-text-bright">
                      <Icon name="brain" className="w-3 text-od-accent" />
                      {t.sessionInfoSkills} ({info.skills.length})
                    </h3>
                    {info.skills.length === 0 ? (
                      <div className="rounded border border-od-border bg-od-bg-dark p-2 text-od-text-dim">
                        {t.sessionInfoNoSkills}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {info.skills.map((s) => {
                          const isPlugin = s.origin === 'package';
                          const isBuiltin = !!s.builtin;
                          const scopeLabel = isBuiltin
                            ? t.skillScopeBuiltin
                            : isPlugin
                              ? t.skillScopePlugin
                              : s.scope === 'project'
                                ? t.skillScopeProject
                                : s.scope === 'temporary'
                                  ? t.skillScopeTemporary
                                  : t.skillScopeUser;
                          const scopeColor = isBuiltin
                            ? 'bg-od-accent/20 text-od-accent'
                            : isPlugin
                              ? 'bg-od-orange/20 text-od-orange'
                              : s.scope === 'project'
                                ? 'bg-od-purple/20 text-od-purple'
                                : s.scope === 'temporary'
                                  ? 'bg-od-orange/20 text-od-orange'
                                  : 'bg-od-accent/20 text-od-accent';
                          return (
                            <div
                              key={s.filePath}
                              className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                            >
                              {/* 左栏：名称 + tag + 路径 */}
                              <div className="shrink-0 w-[40%] min-w-0">
                                <div className="break-all font-mono text-xs text-od-yellow">
                                  {s.name}
                                </div>
                                <div className="mt-0.5">
                                  <span
                                    className={`inline-block rounded px-1.5 py-0.5 text-xs ${scopeColor}`}
                                  >
                                    {scopeLabel}
                                  </span>
                                </div>
                                <div
                                  className="mt-0.5 break-all font-mono text-xs text-od-text-dim"
                                  title={s.filePath}
                                >
                                  {s.filePath}
                                </div>
                              </div>
                              {/* 右栏：描述填满剩余空间 */}
                              <span className="min-w-0 flex-1 text-od-text">
                                {s.description}
                                {s.disableModelInvocation && (
                                  <span className="ml-1 text-od-text-dim">
                                    ({t.sessionInfoSkillManual})
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Prompts 模板 */}
                  {info.prompts.length > 0 && (
                    <div>
                      <h3 className="mb-1 flex items-center gap-1 font-medium text-od-text-bright">
                        <Icon name="heading" className="w-3 text-od-accent" />
                        {t.sessionInfoPrompts} ({info.prompts.length})
                      </h3>
                      <div className="space-y-1">
                        {info.prompts.map((p) => (
                          <div
                            key={p.filePath}
                            className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                          >
                            {/* 左栏：名称 + 参数提示 + 路径 */}
                            <div className="shrink-0 w-[40%] min-w-0">
                              <span className="inline-block break-all font-mono text-xs text-od-purple">
                                /{p.name}
                              </span>
                              {p.argumentHint && (
                                <div className="mt-0.5 break-all font-mono text-xs text-od-text-dim">
                                  {p.argumentHint}
                                </div>
                              )}
                              <div
                                className="mt-0.5 break-all font-mono text-xs text-od-text-dim"
                                title={p.filePath}
                              >
                                {p.filePath}
                              </div>
                            </div>
                            {/* 右栏：描述填满剩余空间 */}
                            <span className="min-w-0 flex-1 text-od-text">{p.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 扩展命令 */}
                  {info.extCommands.length > 0 && (
                    <div>
                      <h3 className="mb-1 flex items-center gap-1 font-medium text-od-text-bright">
                        <Icon name="terminal" className="w-3 text-od-accent" />
                        {t.sessionInfoCommands} ({info.extCommands.length})
                      </h3>
                      <div className="space-y-1">
                        {info.extCommands.map((c) => (
                          <div
                            key={c.name}
                            className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                          >
                            {/* 左栏：命令名 */}
                            <div className="shrink-0 w-[40%] min-w-0">
                              <span className="inline-block break-all font-mono text-xs text-od-green">
                                /{c.name}
                              </span>
                            </div>
                            {/* 右栏：描述填满剩余空间 */}
                            <span className="min-w-0 flex-1 text-od-text">{c.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: MCP ── */}
              {activeTab === 'mcp' && (
                <div>
                  <h3 className="mb-1 flex items-center gap-1 font-medium text-od-text-bright">
                    <McpIcon className="h-3 w-3 text-od-accent" />
                    {t.tabMcp} ({mcpStatuses.filter((s) => s.connected).length}/{mcpStatuses.length}
                    )
                  </h3>
                  {mcpStatuses.length === 0 ? (
                    <div className="rounded border border-od-border bg-od-bg-dark p-2 text-od-text-dim">
                      {t.mcpNoServers}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {mcpStatuses.map((s) => (
                        <div
                          key={s.name}
                          className="flex items-start gap-2 rounded border border-od-border bg-od-bg-dark px-2 py-1.5"
                        >
                          {/* 左栏：名称 + 类型 + 状态 */}
                          <div className="shrink-0 w-[40%] min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="break-all font-mono text-xs text-od-green">
                                {s.name}
                              </span>
                              <span className="shrink-0 rounded bg-od-bg-hover px-1 text-xs text-od-text-dim">
                                {s.entry.builtin ? '内置' : s.entry.url ? 'HTTP' : 'stdio'}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1 text-xs ${
                                  s.connected
                                    ? 'bg-od-green/20 text-od-green'
                                    : 'bg-od-bg-hover text-od-text-dim'
                                }`}
                              >
                                {s.connected ? t.mcpConnected : t.mcpDisconnected}
                              </span>
                            </div>
                          </div>
                          {/* 右栏：工具数 / 错误 */}
                          <span className="min-w-0 flex-1 text-xs text-od-text">
                            {s.connected
                              ? t.mcpToolCount(s.toolCount)
                              : s.error || s.entry.url || s.entry.command || ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
