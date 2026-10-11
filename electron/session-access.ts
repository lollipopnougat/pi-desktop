import type { MessageSnapshot, SessionIdentity } from '../src/types/session';
import { sameSession } from '../src/types/session';

/** 会话替换串行执行；读取快照固定消息数组，并在替换开始时全部失效。 */
export class SessionAccess {
  private tail: Promise<unknown> = Promise.resolve();
  private snapshots = new Map<
    string,
    { identity: SessionIdentity; messages: unknown[]; expires: number }
  >();
  private nextSnapshot = 0;
  revision = 0;
  changing = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.changing = true;
      this.revision++;
      this.snapshots.clear();
      try {
        return await operation();
      } finally {
        this.changing = false;
      }
    });
    // 一次失败不能阻断后续切换/退出。
    this.tail = result.catch(() => {});
    return result;
  }

  read<T>(read: () => T): Promise<T> {
    return this.tail.then(read);
  }

  capture(identity: SessionIdentity, messages: unknown[]): MessageSnapshot {
    if (this.changing || identity.sessionRevision !== this.revision) {
      throw new Error('SESSION_CHANGED');
    }
    // renderer 异常退出时也不能无限保留历史。正常读取在 finally 主动 release。
    while (this.snapshots.size >= 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    const snapshotId = String(++this.nextSnapshot);
    this.snapshots.set(snapshotId, {
      identity,
      messages: messages.slice(),
      expires: Date.now() + 60_000
    });
    return { ...identity, snapshotId, total: messages.length };
  }

  page(identity: SessionIdentity, snapshotId: string, offset: number, limit: number): unknown[] {
    const snapshot = this.snapshots.get(snapshotId);
    if (
      this.changing ||
      !snapshot ||
      Date.now() > snapshot.expires ||
      !sameSession(identity, snapshot.identity) ||
      identity.sessionRevision !== this.revision
    ) {
      this.release(snapshotId);
      throw new Error('SESSION_CHANGED');
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new Error('INVALID_MESSAGE_PAGE');
    }
    return snapshot.messages.slice(offset, offset + limit);
  }

  release(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
  }
}
