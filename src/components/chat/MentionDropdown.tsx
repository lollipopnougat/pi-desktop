/**
 * Mention 下拉列表子组件：纯展示 + 点击选中。
 * 状态与键盘导航在 useMention hook 里。
 */
import type { MentionItem } from '../../types/shared';
import type { MentionType } from '../../hooks/useMention';

interface MentionDropdownProps {
  active: boolean;
  items: MentionItem[];
  index: number;
  type: MentionType | null;
  listRef: React.RefObject<HTMLDivElement>;
  onSelect: (item: MentionItem) => void;
}

export default function MentionDropdown({
  active,
  items,
  index,
  type,
  listRef,
  onSelect
}: MentionDropdownProps) {
  if (!active || items.length === 0) return null;
  void type; // 预留：可按类型显示不同图标/前缀
  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-2 mb-1 w-128 max-w-[90vw] rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl z-20 max-h-48 overflow-y-auto"
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => onSelect(item)}
          className={`flex w-full flex-col px-3 py-1.5 text-left text-xs ${
            i === index ? 'bg-od-accent/20' : 'hover:bg-od-bg-hover'
          }`}
        >
          <span className="text-od-text-bright">{item.label}</span>
          {item.detail && <span className="text-od-text-dim break-words">{item.detail}</span>}
        </button>
      ))}
    </div>
  );
}
