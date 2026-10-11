import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionAccess } from '../../electron/session-access';

afterEach(() => vi.useRealTimers());

describe('SessionAccess', () => {
  it('serializes replacements and reads, and continues after a failed replacement', async () => {
    const access = new SessionAccess();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = access.run(async () => {
      order.push('A:start');
      await gate;
      order.push('A:end');
      throw new Error('failed');
    });
    const failure = expect(first).rejects.toThrow('failed');
    const second = access.run(async () => {
      order.push('B');
    });
    const read = access.read(() => order.push('read'));
    await Promise.resolve();
    expect(order).toEqual(['A:start']);
    release();
    await Promise.all([failure, second, read]);
    expect(order).toEqual(['A:start', 'A:end', 'B', 'read']);
    expect(access.changing).toBe(false);
  });

  it('keeps a stable array when the live history is compacted or appended', () => {
    const access = new SessionAccess();
    const identity = { sessionId: 'A', sessionRevision: access.revision };
    const messages = ['one', 'two', 'three'];
    const snapshot = access.capture(identity, messages);
    messages.splice(0, 2, 'summary');
    messages.push('four');
    expect(access.page(identity, snapshot.snapshotId, 0, 200)).toEqual(['one', 'two', 'three']);
  });

  it('invalidates pages for A → B → A, even though the sessionId matches again', async () => {
    const access = new SessionAccess();
    const original = { sessionId: 'A', sessionRevision: access.revision };
    const snapshot = access.capture(original, ['A']);
    await access.run(async () => {});
    await access.run(async () => {});
    expect(() =>
      access.page({ ...original, sessionRevision: access.revision }, snapshot.snapshotId, 0, 200)
    ).toThrow('SESSION_CHANGED');
    expect(() => access.capture(original, [])).toThrow('SESSION_CHANGED');
  });

  it('rejects reads as soon as replacement begins, before it completes', async () => {
    const access = new SessionAccess();
    const identity = { sessionId: 'A', sessionRevision: 0 };
    const snapshot = access.capture(identity, ['A']);
    await access.run(async () => {
      expect(() => access.page(identity, snapshot.snapshotId, 0, 200)).toThrow('SESSION_CHANGED');
      expect(() => access.capture({ ...identity, sessionRevision: 1 }, [])).toThrow(
        'SESSION_CHANGED'
      );
    });
  });

  it('bounds abandoned snapshots and rejects invalid page ranges', () => {
    const access = new SessionAccess();
    const identity = { sessionId: 'A', sessionRevision: 0 };
    const old = access.capture(identity, ['old']);
    for (let i = 0; i < 4; i++) access.capture(identity, ['new']);
    expect(() => access.page(identity, old.snapshotId, 0, 1)).toThrow('SESSION_CHANGED');
    const latest = access.capture(identity, ['latest']);
    for (const [offset, limit] of [
      [-1, 1],
      [0.5, 1],
      [0, 0],
      [0, 201]
    ]) {
      expect(() => access.page(identity, latest.snapshotId, offset, limit)).toThrow(
        'INVALID_MESSAGE_PAGE'
      );
    }
    access.release(latest.snapshotId);
    expect(() => access.page(identity, latest.snapshotId, 0, 1)).toThrow('SESSION_CHANGED');
  });

  it('expires abandoned snapshots', () => {
    vi.useFakeTimers();
    const access = new SessionAccess();
    const identity = { sessionId: 'A', sessionRevision: 0 };
    const snapshot = access.capture(identity, ['A']);
    vi.advanceTimersByTime(60_001);
    expect(() => access.page(identity, snapshot.snapshotId, 0, 1)).toThrow('SESSION_CHANGED');
  });
});
