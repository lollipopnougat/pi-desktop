import { useState, useEffect, useRef } from 'react';

interface PromptModalProps {
  open: boolean;
  title: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/**
 * 文本输入模态框，替代 Electron 中不支持的 window.prompt()。
 * 打开时自动聚焦并全选输入内容，支持 Enter 提交 / Esc 取消。
 */
export default function PromptModal({
  open,
  title,
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onClose
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      // 延迟聚焦，确保 DOM 已渲染
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(value);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-80 rounded-lg border border-od-border bg-od-bg-alt p-4 shadow-2xl"
      >
        <div className="mb-3 text-sm font-semibold text-od-text-bright">{title}</div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-od-border bg-od-bg-dark px-2 py-1.5 text-sm text-od-text outline-none focus:border-od-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text"
          >
            {cancelText}
          </button>
          <button
            type="submit"
            className="rounded-md bg-od-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-od-accent/80"
          >
            {confirmText}
          </button>
        </div>
      </form>
    </div>
  );
}
