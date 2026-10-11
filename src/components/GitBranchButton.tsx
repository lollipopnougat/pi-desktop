import { useEffect, useState, useRef, useCallback } from 'react';
import { usePiStore } from '../store/pi-store';
import Icon from './common/Icon';
import { t } from '../i18n/zh';

/** 用户家目录（主进程经 preload 暴露；注意不能用 window.__X__ —— preload 在隔离世界里） */
const HOME_DIR: string = window.pi?.homeDir || '';

/**
 * Git 分支按钮（ChatHeader 路径右侧 / Footer 状态栏共用）：
 * - 有 git 且在 repo 中：分支图标 + 当前分支名，点击弹出分支列表可切换
 * - 有 git 非 repo：图标 + 「非 Git 仓库」（禁用态）
 * - 无 git：图标 + 「未安装 Git」（禁用态）
 * - 用户家目录不探测（避免 dotfiles 的 .git 误报，直接按非 repo 处理）
 *
 * cwd 从外部传入（会话 cwd，加载历史会话时是其他项目路径），变化时重新探测。
 */
export default function GitBranchButton({
  cwd,
  onBranchChanged
}: {
  cwd?: string;
  onBranchChanged?: () => void;
}) {
  const [status, setStatus] = useState<{
    installed: boolean;
    isRepo: boolean;
    currentBranch: string | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 跨实例同步：状态栏与聊天区两处按钮共用本组件，任一处切换分支成功后
  // bump gitBranchVersion，所有实例在此重新探测当前分支
  const gitBranchVersion = usePiStore((s) => s.gitBranchVersion);

  const loadStatus = useCallback(async () => {
    // 家目录不探测（dotfiles .git 误报），直接按非 repo 处理
    if (cwd && cwd.replace(/[/\\]$/, '') === HOME_DIR) {
      setStatus({ installed: true, isRepo: false, currentBranch: null });
      return;
    }
    try {
      const s = await window.pi.gitStatus(cwd);
      setStatus(s);
    } catch {
      setStatus({ installed: false, isRepo: false, currentBranch: null });
    }
  }, [cwd]);

  useEffect(() => {
    loadStatus();
    // cwd 变化时关闭已开的下拉
    setOpen(false);
  }, [loadStatus]);

  // 其他实例切换分支后重新拉取当前分支名
  useEffect(() => {
    if (gitBranchVersion > 0) loadStatus();
  }, [gitBranchVersion]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openList = async () => {
    if (!status?.isRepo) return;
    setOpen((v) => !v);
    if (!open) {
      setLoadingList(true);
      setError(null);
      try {
        const r = await window.pi.gitBranches(cwd);
        setBranches(r.branches || []);
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoadingList(false);
      }
    }
  };

  const switchBranch = async (name: string) => {
    if (switching || name === status?.currentBranch) return;
    setSwitching(name);
    setError(null);
    try {
      const r = await window.pi.gitSwitchBranch(name, cwd);
      if (r.ok) {
        setStatus((s) => (s ? { ...s, currentBranch: name } : s));
        setOpen(false);
        // 通知其他实例（状态栏/聊天区另一处按钮）重新探测
        usePiStore.getState().bumpGitBranchVersion();
        onBranchChanged?.();
      } else {
        setError(r.error || t.gitSwitchFailed);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSwitching(null);
    }
  };

  const label = !status
    ? ''
    : !status.installed
      ? t.gitNotInstalled
      : !status.isRepo
        ? t.gitNoRepo
        : status.currentBranch || t.gitNoBranch;

  const disabled = !status || !status.installed || !status.isRepo;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        onClick={openList}
        disabled={disabled}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors ${
          disabled
            ? 'cursor-default text-od-text-dim/60'
            : 'text-od-green hover:bg-od-bg-hover hover:text-od-text-bright'
        }`}
        title={
          !status
            ? ''
            : !status.installed
              ? t.gitNotInstalled
              : !status.isRepo
                ? t.gitNoRepo
                : t.gitSwitchHint
        }
      >
        <Icon name="branch" className="w-3" />
        <span className="max-w-[160px] truncate">{label}</span>
      </button>

      {/* 分支列表下拉 */}
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 max-h-64 w-56 overflow-y-auto rounded-lg border border-od-border-light bg-od-bg-alt py-1 shadow-xl">
          <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-od-text-dim">
            {t.gitBranchList}
          </div>
          {loadingList ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-od-text-dim">
              <Icon name="spinner" spin className="w-3" />
              {t.loading}
            </div>
          ) : (
            branches.map((b) => (
              <button
                key={b.name}
                onClick={() => switchBranch(b.name)}
                disabled={!!switching}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-od-bg-hover disabled:opacity-50 ${
                  b.current ? 'text-od-green' : 'text-od-text'
                }`}
              >
                <Icon name="branch" className="w-3 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
                {b.current ? (
                  <Icon name="check" className="w-3 shrink-0" />
                ) : switching === b.name ? (
                  <Icon name="spinner" spin className="w-3 shrink-0" />
                ) : null}
              </button>
            ))
          )}
          {!loadingList && branches.length === 0 && (
            <div className="px-3 py-2 text-xs text-od-text-dim">{t.gitNoBranch}</div>
          )}
          {error && (
            <div className="border-t border-od-border px-3 py-1.5 text-xs text-od-red">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
