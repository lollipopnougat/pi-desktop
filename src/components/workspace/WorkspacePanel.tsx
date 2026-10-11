import { useState, type ReactNode } from 'react';
import ResizeHandle from '../common/ResizeHandle';

/** 保持工作区挂载；只过渡外层宽度，编辑器和原生浏览器跟随实际布局更新。 */
export default function WorkspacePanel({
  open,
  maximized,
  width,
  onResize,
  children
}: {
  open: boolean;
  maximized: boolean;
  width: number;
  onResize: (delta: number) => void;
  children: ReactNode;
}) {
  const [resizing, setResizing] = useState(false);

  return (
    <div
      ref={(element) => {
        if (element) element.inert = !open;
      }}
      data-workspace-panel
      aria-hidden={!open}
      className={`flex min-w-0 shrink-0 overflow-hidden bg-od-bg ${
        resizing ? '' : 'workspace-panel-anim'
      }`}
      style={{
        width: open ? (maximized ? '100%' : `min(${width}px, max(0px, calc(100% - 260px)))`) : 0
      }}
    >
      {!maximized && <ResizeHandle onResize={onResize} onDraggingChange={setResizing} />}
      {children}
    </div>
  );
}
