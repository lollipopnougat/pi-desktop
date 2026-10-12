import { useEffect, useRef } from 'react';
import Icon from './Icon';
import type { IconName } from './icons';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  /** 作为不可点击的分组标题渲染（不响应点击、不关闭菜单） */
  header?: boolean;
  /** 在标签前显示选中对勾图标（FontAwesome） */
  active?: boolean;
  /** 在标签前显示图标（FontAwesome，名字见 src/components/common/icons.ts 的 IconName） */
  icon?: IconName;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 通用右键菜单组件。在 (x, y) 位置渲染，点击外部或选项后关闭。
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  // 边界调整，避免超出窗口
  const style: React.CSSProperties = { left: x, top: y };

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-50 min-w-[140px] rounded-md border border-od-border-light bg-od-bg-alt py-1 shadow-xl"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 border-t border-od-border" />
        ) : item.header ? (
          <div
            key={i}
            className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-od-text-dim"
          >
            {item.label}
          </div>
        ) : (
          <button
            key={i}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-od-bg-hover ${
              item.danger ? 'text-od-red' : 'text-od-text'
            }`}
          >
            <span className="flex w-3 items-center justify-center">
              {item.active ? (
                <Icon name="check" className="w-3 text-od-accent" />
              ) : item.icon ? (
                // danger 项不指定颜色，跟随标签的红色
                <Icon name={item.icon} className={`w-3 ${item.danger ? '' : 'text-od-text-dim'}`} />
              ) : null}
            </span>
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
