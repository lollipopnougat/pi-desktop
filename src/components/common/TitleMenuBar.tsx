import { useState, useRef, useEffect } from 'react';
import { t } from '../../i18n/zh';

interface MenuItemDef {
  label: string;
  accelerator?: string;
  onClick?: () => void;
  separator?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

interface TitleMenuBarProps {
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onAbout: () => void;
}

/**
 * Windows/Linux 自定义标题栏菜单（显示在标题后面）。
 * macOS 不显示（用系统原生菜单栏）。
 *
 * 快捷键由 Electron 原生菜单注册（autoHideMenuBar 隐藏了菜单栏但快捷键仍生效），
 * 这里只提供 UI 触发。
 */
export default function TitleMenuBar({ onOpenFolder, onOpenSettings, onAbout }: TitleMenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const menus: MenuDef[] = [
    {
      label: '文件',
      items: [
        { label: '打开文件夹...', accelerator: 'Ctrl+O', onClick: onOpenFolder },
        { separator: true, label: '' },
        { label: '设置...', accelerator: 'Ctrl+,', onClick: onOpenSettings }
      ]
    },
    {
      label: '视图',
      items: [
        { label: '重新加载', accelerator: 'Ctrl+R', onClick: () => window.location.reload() },
        {
          label: '强制重新加载',
          accelerator: 'Ctrl+Shift+R',
          onClick: () => window.location.reload()
        }
      ]
    },
    {
      label: '帮助',
      items: [
        { label: `关于 ${t.appName}`, onClick: onAbout },
        { label: t.openSourceLicenses, onClick: () => void window.pi.openThirdPartyNotices() }
      ]
    }
  ];

  return (
    <div
      ref={containerRef}
      className="flex items-center"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {menus.map((menu) => (
        <div key={menu.label} className="relative">
          {/* 菜单打开时按钮提升到 z-40（与下拉同级、高于全屏遮罩 z-30）：
              再次点击按钮直接命中按钮本身走 toggle 关闭，而非被遮罩盖住；
              同时 onMouseEnter 悬停切换菜单也才能收到事件 */}
          <button
            onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
            onMouseEnter={() => {
              if (openMenu !== null) setOpenMenu(menu.label);
            }}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              openMenu !== null ? 'relative z-40' : ''
            } ${
              openMenu === menu.label
                ? 'bg-od-bg-hover text-od-text-bright'
                : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright'
            }`}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setOpenMenu(null)} />
              <div className="absolute left-0 top-full z-40 mt-0.5 min-w-[180px] rounded border border-od-border-light bg-od-bg-alt py-1 shadow-xl">
                {menu.items.map((item, i) => {
                  if (item.separator) {
                    return <div key={i} className="my-1 border-t border-od-border" />;
                  }
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        item.onClick?.();
                        setOpenMenu(null);
                      }}
                      className="flex w-full items-center justify-between px-3 py-1 text-left text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
                    >
                      <span>{item.label}</span>
                      {item.accelerator && (
                        <span className="ml-4 text-xs text-od-text-dim opacity-60">
                          {item.accelerator}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
