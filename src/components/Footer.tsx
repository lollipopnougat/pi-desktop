import { usePiStore } from '../store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useState } from 'react';
import Icon from './common/Icon';
import GitBranchButton from './GitBranchButton';
import { t } from '../i18n/zh';
import { formatTokens } from '../utils/format';

export default function Footer() {
  const { stats, model, thinkingLevel, cwd, setSettingsOpen } = usePiStore(
    useShallow((s) => ({
      stats: s.stats,
      model: s.model,
      thinkingLevel: s.thinkingLevel,
      cwd: s.cwd,
      setSettingsOpen: s.setSettingsOpen
    }))
  );
  const [cwdName, setCwdName] = useState(cwd);

  // 跨平台取项目名（renderer 无法直接用 node path.basename）
  useEffect(() => {
    let alive = true;
    window.pi
      .baseName(cwd)
      .then((n) => {
        if (alive && n) setCwdName(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cwd]);

  /** 点击路径：在 Finder/文件资源管理器中直接打开该目录
   *  （openPath 进入目录内部，非父级选中） */
  const openInFinder = () => {
    if (cwd) window.pi.openWith(cwd, 'default').catch(() => {});
  };

  return (
    <div className="flex items-center justify-between border-t border-od-border px-4 py-1.5 text-xs text-od-text-dim">
      {/* 毛玻璃：底部状态栏不铺底色，露出原生 vibrancy 材质 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-od-bg-hover hover:text-od-text-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-od-accent"
          title={t.settings}
          aria-label={t.settings}
        >
          <Icon name="settings" className="w-3" />
        </button>
        <button
          onClick={openInFinder}
          className="flex items-center gap-1.5 truncate max-w-[220px] rounded px-1 py-0.5 text-od-text transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          title={cwd ? `${cwd}（点击在文件管理器中打开）` : undefined}
        >
          <Icon name="folder" className="w-3 shrink-0 text-od-text-dim" />
          <span className="truncate">{cwdName || cwd}</span>
        </button>
        {/* Git 分支：路径右侧，点击弹列表切换（用会话 cwd，加载历史会话时是其他项目） */}
        <GitBranchButton cwd={cwd} />
        {model && (
          <>
            <span className="text-od-border-light">·</span>
            <span className="text-od-text">
              {model.provider}/{model.id}
            </span>
          </>
        )}
        {thinkingLevel !== 'off' && (
          <>
            <span className="text-od-border-light">·</span>
            <span className="text-od-yellow">thinking: {thinkingLevel}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        {stats && (
          <>
            <span className="flex items-center gap-2 font-mono text-od-text">
              <span title={t.tokensIn}>↑{formatTokens(stats.tokens.input)}</span>
              <span title={t.tokensOut}>↓{formatTokens(stats.tokens.output)}</span>
              {stats.tokens.cacheRead > 0 && (
                <span className="text-od-text-dim" title={t.cacheRead}>
                  R{formatTokens(stats.tokens.cacheRead)}
                </span>
              )}
              {stats.tokens.cacheWrite > 0 && (
                <span className="text-od-text-dim" title={t.cacheWrite}>
                  W{formatTokens(stats.tokens.cacheWrite)}
                </span>
              )}
            </span>
            <span className="text-od-border-light">·</span>
            <span className="text-od-green">{t.cost(stats.cost)}</span>
            <span className="text-od-border-light">·</span>
            <span className="text-od-text">{t.context(stats.contextPercent)}</span>
          </>
        )}
      </div>
    </div>
  );
}
