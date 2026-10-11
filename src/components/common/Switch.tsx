/**
 * 公共开关组件。
 *
 * 视觉规格：w-10 圆角矩形轨道（h-5，圆角 5px = 轨高的 1/4），
 * 白色圆角矩形 handle（h-3.5 w-3.5 = 14px，圆角 3.5px = 边高的 1/4），四边内边距 3px，
 * 开启时向右平移 20px。两者圆角各占自身边高的 25%，属于同一套圆角语言 ——
 * 若按严格同心圆角（handle r = 5 - 3 = 2px）handle 会明显偏方，与轨道不协调。
 * 尺寸与圆角一律用 rem，与 h-5/w-10 一起跟随全局字号缩放。
 * 颜色一律走主题变量（od-*），不写死。
 * 用于设置页各处「开关 + 标题 + 描述」的行布局，避免各 tab 自行复刻样式导致不一致。
 */
interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 可选无障碍标签 */
  ariaLabel?: string;
  /** 禁用态 */
  disabled?: boolean;
}

export default function Switch({ checked, onChange, ariaLabel, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      aria-label={ariaLabel}
      className={`relative h-5 w-10 shrink-0 rounded-[0.3125rem] transition-colors ${
        checked ? 'bg-od-accent' : 'bg-od-bg-hover'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span
        className={`absolute top-[0.1875rem] left-[0.1875rem] h-3.5 w-3.5 rounded-[0.21875rem] bg-white transition-transform ${
          checked ? 'translate-x-[20px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
