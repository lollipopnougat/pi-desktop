import Icon from './Icon';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  /** 鼠标 hover 提示文案 */
  title?: string;
}

/**
 * 自定义复选框：用 div + FontAwesome check 图标替代原生 input[type=checkbox]。
 * 样式跟随 One Dark Pro 色板，勾选态高亮，未勾选态显示空心边框。
 *
 * 注意：不能用 <label> 包裹 <button>，否则点击时 label 会向 button 转发一次合成
 * click，导致 onClick 触发两次、状态互相抵消（看起来"点不动"）。
 * 这里用单个 div + role="checkbox" 承载点击，保证只触发一次。
 */
export default function Checkbox({
  checked,
  onChange,
  label,
  className = '',
  disabled = false,
  title
}: CheckboxProps) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={title}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      className={`flex select-none items-center gap-1 ${
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      } ${className}`}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
          checked
            ? 'border-od-accent bg-od-accent text-white'
            : 'border-od-border-light bg-od-bg-dark hover:border-od-text-dim'
        }`}
      >
        {checked && <Icon name="check" className="w-2.5" />}
      </span>
      {label && <span className="text-xs text-od-text-dim">{label}</span>}
    </div>
  );
}
