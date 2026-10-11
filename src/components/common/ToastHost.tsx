import { usePiStore, type ToastVariant } from '../../store/pi-store';
import Icon from './Icon';
import type { IconName } from './icons';

/** variant → 图标 + 配色 */
const VARIANT_STYLE: Record<ToastVariant, { icon: IconName; className: string }> = {
  info: { icon: 'info', className: 'border-od-border-light bg-od-bg-alt text-od-text-bright' },
  error: { icon: 'circleExclamation', className: 'border-od-red bg-od-bg-alt text-od-red' },
  success: { icon: 'circleCheck', className: 'border-od-green bg-od-bg-alt text-od-green' },
  warning: { icon: 'warning', className: 'border-od-yellow bg-od-bg-alt text-od-yellow' }
};

/**
 * 全局 Toast 提示：右上角堆叠展示 store.toasts，自动消失，可手动关闭。
 * 与聊天内容解耦，用于文件上传拒绝等非阻断性反馈。
 *
 * z-[200] 是故意的：设置页与各类内层弹窗用到 z-50 / z-[100] / z-[110] / z-[120]，
 * 而 ToastHost 在 App 里渲染在设置页**之前**（同级 z-index 下靠后者盖住先者），
 * 保持默认的 z-50 会让「设置页里的操作」弹出的 toast 被设置页盖住。
 */
export default function ToastHost() {
  const toasts = usePiStore((s) => s.toasts);
  const dismissToast = usePiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[200] flex flex-col items-center gap-2">
      {toasts.map((toast) => {
        const style = VARIANT_STYLE[toast.variant];
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex max-w-lg items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl ${style.className}`}
          >
            <Icon name={style.icon} size="sm" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            <button
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 text-od-text-dim transition-colors hover:text-od-text-bright"
              aria-label="关闭"
            >
              <Icon name="close" size="xs" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
