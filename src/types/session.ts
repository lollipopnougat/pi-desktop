/** 同一会话再次打开或跳转分支时，revision 也必须变化。 */
export interface SessionIdentity {
  sessionId: string;
  sessionRevision: number;
}

export interface MessageSnapshot extends SessionIdentity {
  snapshotId: string;
  total: number;
}

export function sameSession(
  a: { sessionId: string | null; sessionRevision: number | null },
  b: { sessionId: string | null; sessionRevision: number | null }
): boolean {
  return (
    typeof a.sessionRevision === 'number' &&
    a.sessionId !== null &&
    a.sessionId === b.sessionId &&
    a.sessionRevision === b.sessionRevision
  );
}
