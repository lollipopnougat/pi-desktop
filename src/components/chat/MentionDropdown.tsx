/**
 * Mention 下拉列表子组件：纯展示 + 点击选中。
 * 状态与键盘导航在 useMention hook 里。
 */
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
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
  if (!active) return null;
  void type; // 预留：可按类型显示不同前缀
  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-2 mb-1 w-128 max-w-[90vw] rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl z-20 max-h-48 overflow-y-auto"
    >
      {items.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-od-text-dim">{t.mentionNoItems}</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.value}
            onClick={() => onSelect(item)}
            className={`flex w-full flex-col px-3 py-1.5 text-left text-xs ${
              i === index ? 'bg-od-accent/20' : 'hover:bg-od-bg-hover'
            }`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon
                name={item.isDirectory ? 'folder' : 'file'}
                className="w-3 shrink-0 text-od-text-dim"
              />
              <span className="truncate text-od-text-bright">{item.label}</span>
            </span>
            {item.detail && (
              <span className="truncate pl-[1.1rem] text-od-text-dim">{item.detail}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
