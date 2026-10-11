/**
 * Dropdown 面板定位计算（纯函数，便于单测）。
 *
 * 面板用 position: fixed 渲染而不是 absolute：设置页内容区与弹窗主体都是 overflow-y-auto，
 * absolute 面板会被祖先裁掉，fixed 不受祖先 overflow 影响（前提：祖先不得有 transform / filter /
 * will-change 这类会生成 containing block 的属性，本项目已确认没有）。
 */

/** 面板坐标：top/bottom 二选一，left/right 二选一 */
export interface PanelGeometry {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  /** 仅在「面板宽度跟随触发按钮」时有值（panelWidth === 'w-full'） */
  width?: number;
  /** 面板不窄于触发按钮 */
  minWidth: number;
  /** 面板最大高度，超出则内部列表滚动 */
  maxHeight: number;
}

export interface TriggerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PanelGeometryOptions {
  /** 面板水平对齐：left 用触发按钮左边，right 用右边 */
  align: 'left' | 'right';
  /** 期望的展开方向；该方向空间不足且反向更宽裕时会翻转 */
  placement: 'bottom' | 'top';
  /** 面板宽度是否等于触发按钮宽度（panelWidth === 'w-full'） */
  matchTriggerWidth: boolean;
}

/** 面板希望的最小可用高度，低于它就考虑翻转到另一侧 */
export const MIN_PANEL_ROOM = 160;
/** 面板高度下限：空间再小也保留这么高，靠内部滚动查看 */
export const MIN_PANEL_HEIGHT = 120;
/** 面板与触发按钮、与窗口边缘的间距 */
export const PANEL_GAP = 4;
export const PANEL_MARGIN = 8;

export function computePanelGeometry(
  rect: TriggerRect,
  viewport: ViewportSize,
  opts: PanelGeometryOptions
): PanelGeometry {
  const below = viewport.height - rect.bottom - PANEL_MARGIN - PANEL_GAP;
  const above = rect.top - PANEL_MARGIN - PANEL_GAP;
  // 默认方向空间不足、且反方向更宽裕时翻转
  const flip =
    opts.placement === 'top'
      ? above >= MIN_PANEL_ROOM || above > below
      : below < MIN_PANEL_ROOM && above > below;
  return {
    top: flip ? undefined : Math.round(rect.bottom + PANEL_GAP),
    bottom: flip ? Math.round(viewport.height - rect.top + PANEL_GAP) : undefined,
    left: opts.align === 'left' ? Math.round(rect.left) : undefined,
    right: opts.align === 'right' ? Math.round(viewport.width - rect.right) : undefined,
    width: opts.matchTriggerWidth ? Math.round(rect.width) : undefined,
    minWidth: Math.round(rect.width),
    maxHeight: Math.max(MIN_PANEL_HEIGHT, Math.floor(flip ? above : below))
  };
}

/** 滚动/缩放时会反复测量，坐标没变就复用旧对象，避免无谓重渲染 */
export function samePanelGeometry(a: PanelGeometry, b: PanelGeometry): boolean {
  return (
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.right === b.right &&
    a.width === b.width &&
    a.minWidth === b.minWidth &&
    a.maxHeight === b.maxHeight
  );
}

/** 分组选项的最小结构（DropdownGroup 的结构子集，避免这里反向依赖组件文件） */
export interface TruncatableGroup {
  label: string;
  options: unknown[];
}

/**
 * 渲染上限截断（纯函数，便于单测）。
 *
 * 选项数量很大时（如内置模型目录的 1000+ 条预设）一次性挂载所有按钮会明显卡顿。
 * 注意：过滤/搜索始终在「全量选项」上进行，这里只截断要渲染的部分，
 * 命中上限时按组顺序保留前 maxVisible 个选项，返回隐藏条数供 UI 提示。
 */
export function truncateGroups<T extends TruncatableGroup>(
  groups: T[],
  maxVisible?: number
): { groups: T[]; hidden: number } {
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  if (!maxVisible || maxVisible <= 0 || total <= maxVisible) {
    return { groups, hidden: 0 };
  }
  let budget = maxVisible;
  const out: T[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const options = g.options.slice(0, budget);
    budget -= options.length;
    out.push({ ...g, options } as T);
  }
  return { groups: out, hidden: total - (maxVisible - budget) };
}
