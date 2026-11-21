import type { HTMLAttributes, ReactNode } from 'react';

/**
 * 键帽（keycap）：项目里所有「按键胶囊」统一用这个组件渲染，字体与字号保持一致。
 *
 * 字体走 `font-kbd`（`tailwind.config.ts` 里的比例系统字体栈），**刻意不跟随**
 * 设置页的 UI 字号族（`--ui-font`，默认 SF Mono）：
 * - `⌘ / ⇧ / ⌥ / ⌫` 这类修饰键符号在等宽字体里笔画细、字宽不一，看着发虚
 * - 比例字体 + `tabular-nums` 更清楚，`F1`–`F12` 也不会前后跳动
 *
 * 字号用 `text-sm`（0.875rem），比改造前的 `text-xs` 大一档；rem 单位随设置页
 * 的全局字号一起缩放。新增按键展示时请直接用它，不要另写 `<kbd>`。
 */
export default function Kbd({
  children,
  tone = 'dim',
  className = '',
  ...rest
}: {
  children: ReactNode;
  /** dim：设置页 / 搜索列表里的次要键帽；bright：tooltip 等前景场景 */
  tone?: 'dim' | 'bright';
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'>) {
  return (
    <kbd
      className={`inline-flex shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5 py-0.5 font-kbd text-sm font-medium leading-tight tracking-wide tabular-nums ${
        tone === 'bright'
          ? 'border-od-border bg-od-bg-hover text-od-text'
          : 'border-od-border-light text-od-text-dim'
      } ${className}`}
      {...rest}
    >
      {children}
    </kbd>
  );
}
