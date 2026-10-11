/**
 * 公共单选框组件。
 *
 * 视觉规格（与 Switch / Checkbox 共用同一套语言）：
 * - 指示器为 14px 圆形（h-3.5 w-3.5），与 Checkbox 的方框、Switch 的 handle 同尺寸；
 *   圆角 rounded-full，选中态用 od-accent 实心 + 6px 白色内点，未选中态为空心描边。
 * - 垂直对齐：指示器上边距 0.1875rem（3px），正好让 14px 的圆在 text-sm 的 20px 行高里居中 ——
 *   与 Switch 的 handle 内边距 3px 同一节奏；尺寸与间距一律用 rem，跟随全局字号缩放。
 * - focus 态用圆形 ring（peer-focus-visible:ring-2）而非浏览器默认的方形 box-shadow，
 *   因为 ring 走 box-shadow + border-radius，圆形控件得到的也是圆环。
 *
 * 用法：隐藏原生 input 仅保留语义（同 name 成组、方向键切换、label 包裹即可点选），
 * 视觉由 span 承担。需要 hover 联动时给外层 label 加 `group`。
 * 调用方负责把本组件放进 <label> 里的 flex 容器（items-start）中。
 */
interface RadioProps {
  /** 同组 radio 的 name，原生分组与方向键切换依赖它 */
  name: string;
  checked: boolean;
  onChange: () => void;
  /** 禁用态 */
  disabled?: boolean;
  /** 可选无障碍标签（外层 label 已含可见文案时可省略） */
  ariaLabel?: string;
}

export default function Radio({ name, checked, onChange, disabled, ariaLabel }: RadioProps) {
  return (
    <>
      <input
        type="radio"
        name={name}
        className="peer sr-only"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
      />
      <span
        aria-hidden="true"
        className={`mt-[0.1875rem] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:border-od-accent peer-focus-visible:ring-2 peer-focus-visible:ring-od-accent/40 peer-disabled:opacity-50 ${
          checked
            ? 'border-od-accent bg-od-accent'
            : 'border-od-border-light bg-od-bg-dark group-hover:border-od-text-dim'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full bg-white transition-transform ${checked ? 'scale-100' : 'scale-0'}`}
        />
      </span>
    </>
  );
}
