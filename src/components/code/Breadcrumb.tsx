import { useState, useRef, useEffect, useMemo } from 'react';
import Icon from '../common/Icon';
import FileTree from './FileTree';
import ExternalAppIcon from './ExternalAppIcon';
import { computeBreadcrumbPath } from './breadcrumb-path';
import { t } from '../../i18n/zh';
import type { ExternalApp } from '../../types/shared';
import { usePiStore } from '../../store/pi-store';

/** 家目录（主进程经 preload 暴露），用于把项目外绝对路径显示成 ~/... */
const HOME_DIR: string = window.pi?.homeDir || '';

interface BreadcrumbProps {
  /** 当前打开的文件路径：相对 cwd（项目文件）或绝对路径（技能等项目外文件） */
  filePath: string;
  /** 工作区根目录，用于计算相对路径与展开定位 */
  cwd: string;
  /** 选中文件时打开（新 tab） */
  onFileOpen: (path: string) => void;
  /** 是否为 markdown 文件 */
  isMarkdown?: boolean;
  /** markdown 当前是否为预览模式 */
  mdPreview?: boolean;
  /** 切换 markdown 源码/预览 */
  onToggleMdPreview?: () => void;
}

/**
 * 编辑器上方的面包屑路径栏 + 右侧工具区。
 * 每一段可点击，弹出可展开的文件树浮层（默认展开到该段目录），点击文件项以新 tab 打开。
 * 右侧：markdown 源码/预览切换、"打开"下拉（外部程序 / 所在文件夹）。
 */
export default function Breadcrumb({
  filePath,
  cwd,
  onFileOpen,
  isMarkdown,
  mdPreview,
  onToggleMdPreview
}: BreadcrumbProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const [apps, setApps] = useState<ExternalApp[]>([{ id: 'default', name: t.defaultApp }]);
  const barRef = useRef<HTMLDivElement>(null);
  const openBtnRef = useRef<HTMLDivElement>(null);
  const showToast = usePiStore((state) => state.showToast);

  useEffect(() => {
    if (openIdx === null) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenIdx(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIdx(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [openIdx]);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (openBtnRef.current && !openBtnRef.current.contains(e.target as Node)) setOpenMenu(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [openMenu]);

  // 挂载及菜单切换时刷新，主进程短暂缓存；取消旧请求，避免关闭/卸载后覆盖状态。
  useEffect(() => {
    let cancelled = false;
    window.pi
      .detectApps()
      .then((detected) => {
        if (!cancelled) setApps(detected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openMenu]);

  // 项目内文件按相对 cwd 展示；项目外文件（技能等）以 ~ / 起头展示绝对路径
  const { segments, activePath } = useMemo(
    () => computeBreadcrumbPath(filePath, cwd, HOME_DIR),
    [filePath, cwd]
  );

  const handlePick = (path: string) => {
    onFileOpen(path);
    setOpenIdx(null);
  };

  const handleOpenWith = (appId: string) => {
    window.pi.openWith(filePath, appId).catch((error) => {
      showToast(t.externalOpenFailed(error instanceof Error ? error.message : String(error)), {
        variant: 'error'
      });
    });
    setOpenMenu(false);
  };

  const primaryApp = apps.find((a) => a.id !== 'default') || apps[0];

  return (
    <div
      ref={barRef}
      data-breadcrumb
      className="relative flex items-center gap-1 border-b border-od-border bg-od-bg-dark px-3 py-1 text-xs text-od-text-dim"
    >
      {/* 面包屑段 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          const clickable = seg.treeRoot !== null;
          return (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevronRight" className="w-2.5 text-od-text-dim/60" />}
              {clickable ? (
                <button
                  onClick={() => setOpenIdx(openIdx === i ? null : i)}
                  title={seg.title}
                  data-breadcrumb-segment={i}
                  className={`truncate rounded px-1 py-0.5 hover:bg-od-bg-hover hover:text-od-text-bright ${
                    isLast ? 'text-od-text-bright' : ''
                  } ${openIdx === i ? 'bg-od-bg-hover text-od-text-bright' : ''}`}
                >
                  {seg.label}
                </button>
              ) : (
                <span
                  title={seg.title}
                  data-breadcrumb-segment={i}
                  className={`truncate px-1 py-0.5 ${isLast ? 'text-od-text-bright' : ''}`}
                >
                  {seg.label}
                </span>
              )}
              {clickable && openIdx === i && (
                <div
                  data-breadcrumb-tree
                  className="absolute left-3 top-full z-50 mt-0.5 max-h-[360px] w-[280px] overflow-y-auto rounded-md border border-od-border-light bg-od-bg-alt py-1 shadow-xl"
                >
                  <FileTree
                    cwd={cwd}
                    rootPath={seg.treeRoot || undefined}
                    onFileOpen={handlePick}
                    expandToPath={seg.expandToPath}
                    activePath={activePath}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 右侧工具区 */}
      <div className="flex shrink-0 items-center gap-1">
        {/* markdown 源码/预览切换 */}
        {isMarkdown && (
          <button
            onClick={onToggleMdPreview}
            className="rounded px-1.5 py-0.5 hover:bg-od-bg-hover hover:text-od-text-bright"
            title={mdPreview ? t.viewSource : t.viewPreview}
          >
            {mdPreview ? t.viewSource : t.viewPreview}
          </button>
        )}

        {/* "打开"下拉（分段按钮） */}
        <div ref={openBtnRef} className="relative flex items-stretch">
          <button
            onClick={() => primaryApp && handleOpenWith(primaryApp.id)}
            className="flex h-6 items-center gap-1 rounded-l bg-od-accent pl-2 pr-1.5 text-od-text-bright hover:brightness-110"
            title={t.openWith}
          >
            <ExternalAppIcon app={primaryApp} />
            <span className="leading-none">{t.open}</span>
          </button>
          <div className="w-px bg-black/20" />
          <button
            onClick={() => setOpenMenu((v) => !v)}
            className="flex h-6 w-6 items-center justify-center rounded-r bg-od-accent text-od-text-bright hover:brightness-110"
            aria-label={t.openWith}
            aria-expanded={openMenu}
          >
            <Icon name="chevronDown" className="w-3" />
          </button>
          {openMenu && (
            <div
              data-external-app-menu
              className="absolute right-0 top-full z-50 mt-1 flex max-h-[min(24rem,calc(100dvh-10rem))] min-w-56 flex-col rounded-md border border-od-border-light bg-od-bg-alt py-1 shadow-xl"
            >
              <div data-external-app-list className="min-h-0 overflow-y-auto overscroll-contain">
                {apps.map((app) => (
                  <button
                    key={app.id}
                    onClick={() => handleOpenWith(app.id)}
                    className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs text-od-text hover:bg-od-bg-hover"
                  >
                    <ExternalAppIcon app={app} />
                    {app.name}
                  </button>
                ))}
              </div>
              <div className="my-1 shrink-0 border-t border-od-border" />
              <button
                onClick={() => {
                  window.pi.showInFolder(filePath).catch(() => {});
                  setOpenMenu(false);
                }}
                className="flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-od-text hover:bg-od-bg-hover"
              >
                <Icon name="folder" className="w-3" />
                {t.openInFolder}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
