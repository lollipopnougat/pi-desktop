import { useState } from 'react';
import Icon from '../common/Icon';
import type { ExternalApp } from '../../types/shared';

/** 图标加载失败时保留占位尺寸，菜单与打开按钮使用同一展示。 */
export default function ExternalAppIcon({ app }: { app?: ExternalApp }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const icon = app?.icon;

  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      {icon && icon !== failedIcon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          className="h-full w-full object-contain"
          onError={() => setFailedIcon(icon)}
        />
      ) : (
        <Icon name={app?.id === 'default' ? 'file' : 'code'} className="w-3" />
      )}
    </span>
  );
}
