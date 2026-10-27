import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import Icon from './Icon';
import {
  computePanelGeometry,
  samePanelGeometry,
  truncateGroups,
  type PanelGeometry
} from './dropdown-geometry';
import { t } from '../../i18n/zh';

/** 下拉项：label 是主文案（触发按钮上也显示它），hint 是第二行小字（如 provider/id、shell 路径） */
export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** 带分组标题的下拉项，对应原生 <optgroup> */
export interface DropdownGroup {
  label: string;
  options: DropdownOption[];
}

export interface DropdownProps {
  value: string;
  onChange: (value: string) => void;
  /** 平铺选项（与 groups 二选一，同时传时 groups 在前） */
  options?: DropdownOption[];
  /** 分组选项（对应 optgroup） */
  groups?: DropdownGroup[];
  /** 触发按钮文案；不传则自动取选中项的 label，再退到 placeholder */
  triggerLabel?: ReactNode;
  /** 无选中项（或选中值不在选项里）时触发按钮显示的文案 */
  placeholder?: string;
  /** 自定义触发按钮的完整 class（替换默认样式，如聊天框模型选择、Shell 的箭头按钮） */
  triggerClassName?: string;
  /** 默认触发样式下追加 w-full（设置页里占满一行的下拉用） */
  fullWidth?: boolean;
  /** 只显示箭头、不显示文案（配合 triggerClassName 做纯箭头触发按钮） */
  hideTriggerLabel?: boolean;
  /** 面板底部插槽，收到 close 以便自行关闭（如「选择文件…」、思考等级） */
  footer?: (close: () => void) => ReactNode;
  /** 根容器附加类（尺寸约束放这里，如 max-w-[55%] / w-52 / w-full） */
  className?: string;
  panelClassName?: string;
  /** 列表附加类，默认 max-h-56（传值即替换，如模型菜单的 max-h-48） */
  listClassName?: string;
  /** 面板宽度类，默认 w-64；'w-full' 表示与触发按钮等宽 */
  panelWidth?: string;
  /** 面板水平对齐（相对触发按钮），默认 right */
  align?: 'left' | 'right';
  /** 面板垂直方向，默认 bottom（向下展开） */
  placement?: 'bottom' | 'top';
  searchable?: boolean;
  searchPlaceholder?: string;
  /** 无选项 / 搜索无结果时的文案 */
  emptyText?: string;
  /**
   * 超过该数量时只渲染前 N 项（防止上千条选项一次性挂载卡顿），
   * 并在列表底部提示剩余条数；过滤/搜索仍在全量选项上进行，不会被截断。
   */
  maxVisibleOptions?: number;
  /** 选中后是否关闭面板（默认关闭；模型菜单需要在选模型/推理强度后保持打开，点外部才关） */
  closeOnSelect?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

/** 默认触发按钮样式（导出让个别调用点追加类名时复用），与项目既有菜单的写法保持一致 */
export const DROPDOWN_TRIGGER_CLASS =
  'flex items-center justify-between gap-2 rounded border border-od-border-light bg-od-bg-alt px-2 py-1 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover disabled:cursor-not-allowed disabled:opacity-50';

type Row =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'option'; key: string; option: DropdownOption; index: number };

/**
 * 统一的下拉选择组件：替换原生 <select>（系统样式与主题不搭），并收敛项目里两处手写菜单浮层
 * （设置页默认 Shell、聊天框模型选择）。外观沿用既有菜单：rounded-lg + border-od-border-light +
 * bg-od-bg-alt + shadow-xl，配 z-10 全屏遮罩点外关闭、z-20 面板、max-h 滚动、hover:bg-od-bg-hover、
 * 选中项 text-od-accent。
 *
 * 键盘：关闭时 ↑/↓/Enter/Space 打开，打开后 ↑/↓ 移动高亮（跳过 disabled、循环）、Home/End 跳首尾、
 * Enter 选中、Esc 关闭并回焦触发按钮、Tab 关闭并让焦点自然离开。焦点始终停在触发按钮或搜索框上
 * （不移入列表），高亮项通过 aria-activedescendant 暴露给屏幕阅读器。
 *
 * 面板用 position: fixed + 实测坐标渲染（而非 absolute）：设置页内容区与弹窗主体是
 * overflow-y-auto，absolute 面板会被裁掉；fixed 不受祖先 overflow 影响（祖先不得有
 * transform/filter/will-change 这类会生成 containing block 的属性）。空间不足时自动向上展开。
 */
export default function Dropdown({
  value,
  onChange,
  options,
  groups,
  triggerLabel,
  placeholder,
  triggerClassName,
  className,
  fullWidth = false,
  hideTriggerLabel = false,
  footer,
  panelClassName,
  listClassName,
  panelWidth = 'w-64',
  align = 'right',
  placement = 'bottom',
  searchable = false,
  searchPlaceholder,
  emptyText,
  maxVisibleOptions,
  closeOnSelect = true,
  disabled = false,
  title,
  ariaLabel
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [panelPos, setPanelPos] = useState<PanelGeometry | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // 高亮项要不要滚进视野：只有「打开面板 / 键盘导航」把高亮移走时才滚。
  // 鼠标悬停也改高亮，若跟着滚动就会连锁：悬停 → 滚动 → 新的一行滑到光标下 → 再悬停 → 再滚动，
  // 表现为光标停在列表上下边缘时内容自己一直滚。
  const scrollActiveRef = useRef(false);
  const listboxId = useId();

  // groups 在前 + 平铺 options，构成唯一的展示顺序（键盘导航也按这个平铺顺序）
  const allGroups = useMemo<DropdownGroup[]>(
    () => [...(groups ?? []), ...(options ? [{ label: '', options }] : [])],
    [groups, options]
  );

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            (o.hint ?? '').toLowerCase().includes(q)
        )
      }))
      .filter((g) => g.options.length > 0);
  }, [allGroups, search]);

  const flatOptionsAll = useMemo(() => filteredGroups.flatMap((g) => g.options), [filteredGroups]);

  // 渲染上限：过滤/搜索始终在全量选项上做，只是截断「渲染」部分，避免上千条选项一次性挂载
  const { groups: visibleGroups, hidden: hiddenOptionCount } = useMemo(
    () => truncateGroups(filteredGroups, maxVisibleOptions),
    [filteredGroups, maxVisibleOptions]
  );

  const flatOptions = useMemo(() => visibleGroups.flatMap((g) => g.options), [visibleGroups]);

  // 逐行数据（分组标题不可选），index 与 flatOptions 对齐
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let i = 0;
    for (const g of visibleGroups) {
      if (g.label) out.push({ kind: 'group', key: `g:${g.label}`, label: g.label });
      for (const o of g.options) {
        out.push({ kind: 'option', key: `o:${o.value}:${i}`, option: o, index: i });
        i += 1;
      }
    }
    return out;
  }, [visibleGroups]);

  const selectedOption = useMemo(
    () => flatOptionsAll.find((o) => o.value === value),
    [flatOptionsAll, value]
  );

  // 高亮下标：搜索过滤或选中项变化后可能失效，渲染期回退到第一个可选中的项（不在 effect 里 setState）
  const activeIdx =
    activeIndex >= 0 && activeIndex < flatOptions.length && !flatOptions[activeIndex]?.disabled
      ? activeIndex
      : flatOptions.findIndex((o) => !o.disabled);

  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  // 实测触发按钮位置：面板贴齐触发按钮，空间不足则向上展开（计算逻辑见 dropdown-geometry.ts）
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const next = computePanelGeometry(
      el.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      { align, placement, matchTriggerWidth: panelWidth === 'w-full' }
    );
    setPanelPos((prev) => (prev && samePanelGeometry(prev, next) ? prev : next));
  }, [align, placement, panelWidth]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  const openMenu = () => {
    const selected = flatOptions.findIndex((o) => o.value === value && !o.disabled);
    scrollActiveRef.current = true;
    setOpen(true);
    setActiveIndex(selected >= 0 ? selected : flatOptions.findIndex((o) => !o.disabled));
  };

  const pick = (v: string) => {
    onChange(v);
    // 有些菜单（模型选择）要在选完后继续停留，便于连续调整模型 + 推理强度
    if (!closeOnSelect) return;
    close();
    triggerRef.current?.focus();
  };

  const moveActive = (delta: 1 | -1) => {
    if (flatOptions.length === 0) return;
    let i = activeIdx;
    for (let n = 0; n < flatOptions.length; n++) {
      i = (i + delta + flatOptions.length) % flatOptions.length;
      if (!flatOptions[i].disabled) break;
    }
    scrollActiveRef.current = true;
    setActiveIndex(i);
  };

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        break;
      case 'Tab':
        // 不拦截：关掉面板，焦点自然移到下一个控件
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        scrollActiveRef.current = true;
        setActiveIndex(flatOptions.findIndex((o) => !o.disabled));
        break;
      case 'End':
        e.preventDefault();
        scrollActiveRef.current = true;
        setActiveIndex(
          flatOptions.length - 1 - [...flatOptions].reverse().findIndex((o) => !o.disabled)
        );
        break;
      case 'Enter': {
        const o = flatOptions[activeIdx];
        if (o && !o.disabled) {
          e.preventDefault();
          pick(o.value);
        }
        break;
      }
    }
  };

  // 打开时聚焦搜索框；键盘导航后高亮项滚进可视区（只滚列表，不用 scrollIntoView，避免连带滚动设置页容器）。
  // 鼠标悬停引起的高亮变化不滚动，见 scrollActiveRef 的注释。
  useEffect(() => {
    if (!open) return;
    measure();
    if (searchable) searchRef.current?.focus();
    if (!scrollActiveRef.current) return;
    scrollActiveRef.current = false;
    const list = listRef.current;
    const item = itemRefs.current[activeIdx];
    if (list && item) {
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight;
      }
    }
  }, [open, activeIdx, searchable, measure]);

  // 打开期间跟随触发按钮：窗口缩放或任意祖先滚动（capture）都重新测量
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  return (
    // display:flex 而非 block：当根容器处于 align-items:stretch 的 flex 行里（如设置页 Shell 的
    // input + 箭头按钮）时，触发按钮会跟着拉伸到同行控件的高度，否则会保持内容高度而顶端对齐
    <div className={`relative flex ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIdx >= 0 ? optionId(activeIdx) : undefined}
        className={triggerClassName ?? `${DROPDOWN_TRIGGER_CLASS}${fullWidth ? ' w-full' : ''}`}
      >
        {!hideTriggerLabel && (
          <span className="min-w-0 flex-1 truncate text-left">
            {triggerLabel ?? selectedOption?.label ?? placeholder ?? ''}
          </span>
        )}
        <Icon name="chevronDown" size="xs" className="shrink-0 text-od-text-dim" />
      </button>

      {open && panelPos && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            onKeyDown={handleKeyDown}
            style={{
              top: panelPos.top,
              bottom: panelPos.bottom,
              left: panelPos.left,
              right: panelPos.right,
              width: panelPos.width,
              minWidth: panelPos.minWidth,
              maxHeight: panelPos.maxHeight
            }}
            className={`fixed z-20 flex flex-col overflow-hidden ${
              panelWidth === 'w-full' ? '' : panelWidth
            } rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl ${panelClassName ?? ''}`}
          >
            {searchable && (
              <div className="shrink-0 border-b border-od-border p-2">
                <div className="flex items-center gap-2 rounded-md bg-od-bg px-2 py-1">
                  <Icon name="search" size="xs" className="shrink-0 text-od-text-dim" />
                  <input
                    ref={searchRef}
                    role="combobox"
                    aria-expanded
                    aria-controls={listboxId}
                    aria-autocomplete="list"
                    aria-activedescendant={activeIdx >= 0 ? optionId(activeIdx) : undefined}
                    aria-label={searchPlaceholder ?? ariaLabel}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={searchPlaceholder ?? t.dropdownSearchPlaceholder}
                    spellCheck={false}
                    className="w-full min-w-0 bg-transparent text-xs text-od-text-bright outline-none placeholder:text-od-text-dim focus:border-none focus:shadow-none focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              className={`relative min-h-0 flex-1 overflow-y-auto py-1 ${listClassName ?? 'max-h-56'}`}
            >
              {flatOptions.length === 0 && (
                <div className="px-3 py-2 text-xs text-od-text-dim">
                  {emptyText ?? t.dropdownEmpty}
                </div>
              )}
              {rows.map((row) =>
                row.kind === 'group' ? (
                  <div key={row.key} className="px-3 py-1 text-xs text-od-text-dim">
                    {row.label}
                  </div>
                ) : (
                  <button
                    key={row.key}
                    id={optionId(row.index)}
                    ref={(el) => {
                      itemRefs.current[row.index] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={row.option.value === value}
                    disabled={row.option.disabled}
                    onMouseEnter={() => {
                      // 只改高亮，不滚动列表（滚动位置由用户自己的滚轮/滚动条决定）
                      scrollActiveRef.current = false;
                      if (!row.option.disabled) setActiveIndex(row.index);
                    }}
                    onClick={() => pick(row.option.value)}
                    className={`flex w-full flex-col px-3 py-1.5 text-left text-xs hover:bg-od-bg-hover ${
                      row.option.value === value ? 'text-od-accent' : 'text-od-text-bright'
                    } ${row.index === activeIdx ? 'bg-od-bg-hover' : ''} ${
                      row.option.disabled ? 'cursor-not-allowed opacity-50' : ''
                    }`}
                  >
                    <span className="truncate">{row.option.label}</span>
                    {row.option.hint && (
                      <span className="truncate text-od-text-dim">{row.option.hint}</span>
                    )}
                  </button>
                )
              )}
            </div>

            {hiddenOptionCount > 0 && (
              <div className="border-t border-od-border px-3 py-1.5 text-xs text-od-text-dim">
                {t.dropdownMoreOptions(hiddenOptionCount)}
              </div>
            )}

            {footer && (
              <div className="shrink-0 border-t border-od-border py-1">{footer(close)}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
