import ConfirmDialog from './ConfirmDialog';
import { usePiStore } from '../../store/pi-store';
import { resolveStopRunning } from '../../lib/stopRunningConfirm';

/**
 * 全局「会话正在运行」停止执行确认框（App 根挂载，全应用唯一实例）。
 *
 * 由 src/lib/stopRunningConfirm.ts 打开：
 * - 渲染进程侧动作（切换/新建会话、fork、切换项目目录）
 * - 主进程退出/关窗请求（pi:quitConfirmRequest → handleQuitConfirmRequest）
 *
 * danger=true：确认按钮红色，明确这是「会掐断当前回复」的操作。
 */
export default function StopRunningConfirm() {
  const payload = usePiStore((s) => s.stopRunningConfirm);

  return (
    <ConfirmDialog
      open={payload !== null}
      title={payload?.title ?? ''}
      message={payload?.message}
      confirmText={payload?.confirmText}
      danger
      onConfirm={() => resolveStopRunning(true)}
      onClose={() => resolveStopRunning(false)}
    />
  );
}
