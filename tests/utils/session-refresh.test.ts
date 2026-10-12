import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSessionRefresh,
  scheduleSessionRefresh,
  subscribeSessionRefresh
} from '../../src/lib/session-refresh';

describe('session refresh scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // 清掉可能挂起的定时器，避免影响下一个用例
    flushSessionRefresh();
    vi.useRealTimers();
  });

  it('coalesces a burst into a single refresh', () => {
    const listener = vi.fn();
    const off = subscribeSessionRefresh(listener);
    scheduleSessionRefresh();
    scheduleSessionRefresh();
    scheduleSessionRefresh();
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('still refreshes within a second even if requests keep coming', () => {
    const listener = vi.fn();
    const off = subscribeSessionRefresh(listener);
    // 每 100ms 请求一次（纯去抖会被无限推迟，最长等待保证会在 1s 内刷一次）
    for (let i = 0; i < 10; i += 1) {
      scheduleSessionRefresh();
      vi.advanceTimersByTime(100);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('flushes immediately and cancels the pending timer', () => {
    const listener = vi.fn();
    const off = subscribeSessionRefresh(listener);
    scheduleSessionRefresh();
    flushSessionRefresh();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    const healthy = vi.fn();
    const offFailing = subscribeSessionRefresh(failing);
    const offHealthy = subscribeSessionRefresh(healthy);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    flushSessionRefresh();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    offFailing();
    offHealthy();
  });
});
