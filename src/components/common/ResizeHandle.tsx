import { useState, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  /** 拖拽时回调，参数为本次鼠标位移 delta（向右为正） */
  onResize: (delta: number) => void;
  /** 拖拽方向：向右拖增加宽度（左侧面板用 right），向左拖增加宽度（右侧面板用 left） */
  side?: 'left' | 'right';
  /** 父面板在拖拽期间关闭宽度过渡，避免拖拽延迟。 */
  onDraggingChange?: (dragging: boolean) => void;
}

/**
 * 可复用的垂直拖拽分隔条。
 * - side="left"：拖把在面板左侧，向右拖 delta 为正（用于右侧面板，宽度 = 当前 - delta）
 * - side="right"：拖把在面板右侧，向右拖 delta 为正（用于左侧面板，宽度 = 当前 + delta）
 * 默认 side="left"（用于右侧代码面板）。
 */
export default function ResizeHandle({
  onResize,
  side = 'left',
  onDraggingChange
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    onDraggingChange?.(true);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      onDraggingChange?.(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging, onDraggingChange]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startXRef.current;
      if (delta !== 0) onResize(delta);
      startXRef.current = ev.clientX;
    };
    const onUp = () => {
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onResize]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startXRef.current = e.clientX;
    setDragging(true);
  };

  return (
    <div
      onMouseDown={startResize}
      className={`relative w-1 shrink-0 cursor-col-resize bg-od-border transition-colors hover:bg-od-accent/50 ${
        dragging ? 'bg-od-accent/60' : ''
      } ${side === 'left' ? '' : ''}`}
    >
      {/* 放大命中区域，方便鼠标对准 */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
