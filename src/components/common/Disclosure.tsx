import { useState, type ReactNode } from 'react';
import Icon from './Icon';

/**
 * 统一的可折叠区块标题（记忆面板 / 审核区块 / 项目记忆共用）：
 * 收起用 `chevronRight`、展开用 `chevronDown`，与聊天面板的注入明细保持同一套图标，
 * 不再依赖原生 `<details>` 的三角标记（各平台渲染不一致，也不符合图标规范）。
 */
export default function Disclosure({
  title,
  extra,
  tone = 'normal',
  disabled = false,
  defaultOpen = false,
  indent = false,
  truncate = true,
  className = '',
  children
}: {
  title: ReactNode;
  /** 右侧元信息（来源文件、字符数等） */
  extra?: ReactNode;
  tone?: 'normal' | 'warning';
  /** 不可展开（无内容）时置灰且不响应点击 */
  disabled?: boolean;
  defaultOpen?: boolean;
  /** 展开内容左侧缩进，与标题箭头对齐 */
  indent?: boolean;
  /** 标题单行省略（默认开）；关掉时允许换行断词 */
  truncate?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !disabled && open;
  return (
    <div className={`space-y-0.5 ${className}`}>
      <button
        type="button"
        aria-expanded={expanded}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-od-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          className={`w-2.5 shrink-0 text-od-text-dim ${disabled ? 'opacity-40' : ''}`}
        />
        <span
          className={`shrink-0 ${truncate ? 'truncate' : 'break-all'} max-w-[60%] ${tone === 'warning' ? 'text-od-orange' : 'text-od-text-bright'}`}
        >
          {title}
        </span>
        {extra != null && (
          <span className="ml-auto min-w-0 shrink truncate pl-2 text-od-text-dim">{extra}</span>
        )}
      </button>
      {expanded && <div className={indent ? 'pl-4' : undefined}>{children}</div>}
    </div>
  );
}
