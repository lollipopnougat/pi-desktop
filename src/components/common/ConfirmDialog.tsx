import Icon from './Icon';
import { t } from '../../i18n/zh';

interface ConfirmDialogProps {
  open: boolean;
  /** 标题（带 warning 图标） */
  title: string;
  /** 正文说明 */
  message?: string;
  /** 确认按钮文字（默认「确定」） */
  confirmText?: string;
  /** 取消按钮文字（默认「取消」） */
  cancelText?: string;
  /** 危险操作：确认按钮显示红色 */
  danger?: boolean;
  /** 确认中（按钮 disabled + spinner） */
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 通用确认弹窗。
 *
 * 遮罩 + 居中卡片，标题带 warning 图标，底部取消/确认按钮。
 * 危险操作（danger=true）时确认按钮为红色。loading 时禁用按钮并显示 spinner。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
  loading = false,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-96 rounded-lg border border-od-border-light bg-od-bg-alt p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
          <Icon name="warning" className="w-4 text-od-yellow" />
          {title}
        </div>
        {message && <div className="mb-3 text-xs text-od-text-dim">{message}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded px-3 py-1 text-xs text-od-text hover:bg-od-bg-hover disabled:opacity-50"
          >
            {cancelText ?? t.cancel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`flex items-center gap-1 rounded px-3 py-1 text-xs text-white transition-colors disabled:opacity-50 ${
              danger ? 'bg-od-red hover:bg-od-red/80' : 'bg-od-accent hover:bg-od-accent/80'
            }`}
          >
            {loading && <Icon name="spinner" spin className="w-3" />}
            {confirmText ?? t.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
