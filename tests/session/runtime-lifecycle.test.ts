import { describe, expect, it, vi } from 'vitest';
import { disposeRuntime } from '../../electron/runtime-lifecycle';

describe('disposeRuntime', () => {
  it('waits for abort and shutdown in order', async () => {
    const order: string[] = [];
    let finishAbort!: () => void;
    const abort = new Promise<void>((resolve) => {
      finishAbort = resolve;
    });
    const runtime = {
      session: {
        abort: async () => {
          order.push('abort');
          await abort;
          order.push('idle');
        },
        dispose: vi.fn()
      },
      dispose: vi.fn(async () => {
        order.push('shutdown');
      })
    };
    const result = disposeRuntime(runtime);
    expect(runtime.dispose).not.toHaveBeenCalled();
    finishAbort();
    await result;
    expect(order).toEqual(['abort', 'idle', 'shutdown']);
    expect(runtime.session.dispose).not.toHaveBeenCalled();
  });

  it('still calls SDK dispose when abort fails', async () => {
    const runtime = {
      session: { abort: vi.fn().mockRejectedValue(new Error('abort failed')), dispose: vi.fn() },
      dispose: vi.fn().mockResolvedValue(undefined)
    };
    await expect(disposeRuntime(runtime)).rejects.toThrow('Runtime cleanup failed');
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('falls back to session disposal if a shutdown extension throws', async () => {
    const runtime = {
      session: { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
      dispose: vi.fn().mockRejectedValue(new Error('shutdown failed'))
    };
    await expect(disposeRuntime(runtime)).rejects.toThrow('Runtime cleanup failed');
    expect(runtime.session.dispose).toHaveBeenCalledOnce();
  });
});
