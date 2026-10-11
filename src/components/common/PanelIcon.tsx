/**
 * VSCode 风格面板图标（自绘 SVG）
 *
 * 设计：圆角矩形外框 + 内部竖线/横线，与 VSCode 标题栏的侧边栏/面板/辅助面板图标一致。
 * 这三个图标在 FontAwesome free 中无精确对应，按用户要求破例自绘 SVG。
 * 仅在此处集中维护，其它代码通过 <PanelIcon name="sidebar|panel|auxiliary" /> 引用。
 */
import type { CSSProperties } from 'react';

export type PanelIconName = 'sidebar' | 'panel' | 'auxiliary';

interface PanelIconProps {
  name: PanelIconName;
  className?: string;
  /** SVG 宽高（正方形），默认 1em */
  size?: number | string;
  title?: string;
  style?: CSSProperties;
}

/**
 * 统一画布 24x24，描边继承 currentColor。
 * - sidebar：外框 + 左侧竖线（靠左）
 * - panel：外框 + 底部横线（靠底）
 * - auxiliary：外框 + 右侧竖线（靠右）
 */
export default function PanelIcon({ name, className, size = '1em', title, style }: PanelIconProps) {
  const stroke = 'currentColor';
  const sw = 1.6;
  const inner: Record<PanelIconName, JSX.Element> = {
    sidebar: (
      <line x1="9" y1="4" x2="9" y2="20" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
    ),
    panel: (
      <line x1="4" y1="14" x2="20" y2="14" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
    ),
    auxiliary: (
      <line x1="15" y1="4" x2="15" y2="20" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
    )
  };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={style}
      fill="none"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke={stroke} strokeWidth={sw} />
      {inner[name]}
    </svg>
  );
}
