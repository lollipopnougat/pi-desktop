/**
 * 运行中「停止执行」确认闸门测试（src/lib/stopRunningConfirm.ts）
 *
 * 覆盖：
 * - 没在跑 → 直接放行、不弹窗
 * - 在跑 → 弹窗并等待回答（确认 / 取消）
 * - store 说没在跑但主进程 session 在跑 → 仍要弹窗（覆盖关窗重开后 store 滞后）
 * - 主进程核对失败 → 不阻断原操作
 * - 弹窗单例：已有确认框在等回答时，后继动作不覆盖、不继续
 * - 主进程退出确认：回答会回传给主进程
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  confirmStopRunning,
  resolveStopRunning,
  handleQuitConfirmRequest,
  abortRunningTurn
} from '../../src/lib/stopRunningConfirm';
import { usePiStore } from '../../src/store/pi-store';

const getStateMock = vi.fn();
const resolveQuitMock = vi.fn();
const abortMock = vi.fn();

beforeEach(() => {
  getStateMock.mockReset().mockResolvedValue({ isStreaming: false } as any);
  resolveQuitMock.mockReset().mockResolvedValue(undefined);
  abortMock.mockReset().mockResolvedValue(undefined);
  (globalThis as any).window = {
    pi: { getState: getStateMock, resolveQuitConfirm: resolveQuitMock, abort: abortMock }
  };
  usePiStore.setState({ isStreaming: false, stopRunningConfirm: null });
});

/** 取出当前弹窗文案（无弹窗时为 null） */
function dialog() {
  return usePiStore.getState().stopRunningConfirm;
}

/** 等一轮宏任务：confirmStopRunning 内部有 await（store 检查 / 主进程核对），弹窗要几跳微任务后才挂上 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('confirmStopRunning', () => {
  it('不在运行：直接放行且不弹窗', async () => {
    await expect(confirmStopRunning('切换会话')).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(getStateMock).toHaveBeenCalled();
  });

  it('运行中（store 已知）：弹窗并等待回答', async () => {
    usePiStore.setState({ isStreaming: true });
    const p = confirmStopRunning('切换会话');
    await flush();
    expect(getStateMock).not.toHaveBeenCalled();
    expect(dialog()?.message).toContain('切换会话');
    expect(dialog()?.confirmText).toBe('继续切换会话');
    resolveStopRunning(true);
    await expect(p).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it('用户取消：不放行', async () => {
    usePiStore.setState({ isStreaming: true });
    const p = confirmStopRunning('新建会话');
    await flush();
    resolveStopRunning(false);
    await expect(p).resolves.toBe(false);
  });

  it('store 滞后（主进程说在跑）：仍弹窗确认', async () => {
    getStateMock.mockResolvedValue({ isStreaming: true } as any);
    const p = confirmStopRunning('切换项目目录');
    await flush();
    expect(dialog()?.message).toContain('切换项目目录');
    resolveStopRunning(false);
    await expect(p).resolves.toBe(false);
  });

  it('主进程核对抛错：不阻断原操作', async () => {
    getStateMock.mockRejectedValue(new Error('ipc dead'));
    await expect(confirmStopRunning('切换会话')).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it('弹窗单例：已有确认框在等回答时，后继动作不覆盖且不继续', async () => {
    usePiStore.setState({ isStreaming: true });
    const first = confirmStopRunning('切换会话');
    await flush();
    const firstMessage = dialog()?.message;

    await expect(confirmStopRunning('新建会话')).resolves.toBe(false);
    expect(dialog()?.message).toBe(firstMessage);

    resolveStopRunning(true);
    await expect(first).resolves.toBe(true);
  });
});

describe('handleQuitConfirmRequest', () => {
  it('弹退出确认框，回答回传主进程', async () => {
    handleQuitConfirmRequest();
    expect(dialog()?.message).toContain('退出应用');
    resolveStopRunning(true);
    await flush();
    expect(resolveQuitMock).toHaveBeenCalledWith(true);
  });

  it('取消退出：主进程收到 false，窗口不关', async () => {
    handleQuitConfirmRequest();
    resolveStopRunning(false);
    await flush();
    expect(resolveQuitMock).toHaveBeenCalledWith(false);
  });

  it('已有其它确认框在等回答：不覆盖，直接回 false', async () => {
    usePiStore.setState({ isStreaming: true });
    const p = confirmStopRunning('切换会话');
    await flush();

    handleQuitConfirmRequest();
    expect(resolveQuitMock).toHaveBeenCalledWith(false);
    expect(dialog()?.message).toContain('切换会话');

    resolveStopRunning(true);
    await expect(p).resolves.toBe(true);
  });
});

describe('abortRunningTurn', () => {
  it('调用 abort 等待落盘，失败不抛出', async () => {
    await abortRunningTurn();
    expect(abortMock).toHaveBeenCalled();
    abortMock.mockRejectedValue(new Error('boom'));
    await expect(abortRunningTurn()).resolves.toBeUndefined();
  });
});
