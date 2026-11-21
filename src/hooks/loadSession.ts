import { recordCurrentSessionNav, usePiStore } from '../store/pi-store';
import { sameSession, type SessionIdentity } from '../types/session';
import { mergeSessionMessages } from '../utils/session-messages';
import { t } from '../i18n/zh';

const MESSAGE_CHUNK = 200;
let transitionTail: Promise<unknown> = Promise.resolve();

/** 异步回调同时绑定 renderer 请求代次和主进程会话版本，覆盖 A → B → A。 */
export function captureSessionGuard(): () => boolean {
  const { sessionId, sessionRevision, sessionLoadVersion } = usePiStore.getState();
  return () => {
    const current = usePiStore.getState();
    return (
      current.sessionLoadVersion === sessionLoadVersion &&
      sameSession(current, { sessionId, sessionRevision })
    );
  };
}

export function isCurrentSession(identity: SessionIdentity): boolean {
  return sameSession(usePiStore.getState(), identity);
}

export async function loadSessionMessages(identity: SessionIdentity): Promise<any[]> {
  const snapshot = await window.pi.getMessageSnapshot(identity);
  try {
    const all: any[] = [];
    for (let offset = 0; offset < snapshot.total; offset += MESSAGE_CHUNK) {
      all.push(...(await window.pi.getMessages(snapshot.snapshotId, offset, MESSAGE_CHUNK)));
    }
    return all;
  } finally {
    await window.pi.releaseMessageSnapshot(snapshot.snapshotId).catch(() => {});
  }
}

export async function loadAndApplySessionMessages(identity: SessionIdentity): Promise<void> {
  const current = captureSessionGuard();
  const history = await loadSessionMessages(identity);
  if (!current()) return;
  const store = usePiStore.getState();
  const messages = mergeSessionMessages(history, store.messages);
  const liveTools = store.toolExecutions;
  store.setMessages(messages);
  store.rebuildToolExecutions(messages);
  // 正在加载历史时也可能收到当前会话的工具进度，不能被重建覆盖。
  usePiStore.setState((s) => ({ toolExecutions: { ...s.toolExecutions, ...liveTools } }));
}

async function refreshSession(version: number, label?: string): Promise<void> {
  const state = await window.pi.getState();
  if (usePiStore.getState().sessionLoadVersion !== version) return;
  usePiStore.getState().setSessionInfo(state);
  usePiStore.getState().setSessionLabel(label || state.sessionName || '');
  const current = captureSessionGuard();
  await loadAndApplySessionMessages(state);
  if (!current()) return;
  await Promise.all(
    [
      window.pi.getAvailableModels().then((models) => {
        if (current()) usePiStore.getState().setAvailableModels(models);
      }),
      window.pi.getCommands().then((commands) => {
        if (current()) usePiStore.getState().setCommands(commands);
      }),
      window.pi.goal.get().then((snapshot) => {
        if (current()) usePiStore.getState().setGoalSnapshot(snapshot);
      }),
      window.pi.plan.get().then((snapshot) => {
        if (current()) usePiStore.getState().setPlanSnapshot(snapshot);
      }),
      window.pi.subagents.getSnapshot().then((snapshot) => {
        if (current()) usePiStore.getState().setSubagentSnapshot(snapshot);
      }),
      window.pi.getTodoPhases().then((result) => {
        if (current()) usePiStore.getState().setTodoPhases(result?.phases ?? []);
      }),
      // 挂起交互（后台期间的提问/审批）用拉取而不是等推送：切换过程中的推送会被
      // isCurrentSession 过滤丢掉，切过去后必须主动补一次面板
      window.pi.getPendingInteractions().then((pending) => {
        if (!current()) return;
        usePiStore
          .getState()
          .setAskQuestions(pending?.ask?.questions ?? null, pending?.ask?.sessionId ?? null);
        usePiStore.getState().setPendingPermissionRequest(pending?.permission ?? null);
      }),
      // 评审结论同理：后台槽的事件不推渲染进程，切过去后主动补一次最近记录
      window.pi.getRecentPermissionReviews().then((list) => {
        if (current()) usePiStore.getState().setRecentPermissionReviews(list ?? []);
      })
    ].map((promise) =>
      promise.catch((error) => console.error('Failed to refresh session data:', error))
    )
  );
  if (current()) {
    usePiStore.getState().refreshStats();
    usePiStore.getState().bumpSessionVersion();
  }
}

/** 所有 UI 入口共用的切换事务。后发请求使旧加载失效，主进程操作不会交错。
 *
 * @param options.recordNav 默认 true：切完把新会话压入导航历史（标题栏前进/后退）。
 *   `navigateSessionHistory` 必须在后退/前进时传 false，否则后退键会把「退回来的那个会话」
 *   当成一次新导航再压一条，历史变成环。
 */
export function transitionSession(
  operation: () => Promise<unknown>,
  label?: string,
  options?: { recordNav?: boolean }
): Promise<boolean> {
  const version = usePiStore.getState().sessionLoadVersion + 1;
  usePiStore.setState({
    sessionLoadVersion: version,
    sessionRevision: null,
    isSessionLoading: true
  });
  const current = () => usePiStore.getState().sessionLoadVersion === version;
  const result = transitionTail.then(async () => {
    if (!current()) return false;
    let succeeded = true;
    try {
      try {
        await operation();
      } catch (error) {
        succeeded = false;
        if (current())
          usePiStore.getState().showToast(t.sessionLoadFailed(String(error)), { variant: 'error' });
      }
      if (!current()) return false;
      await window.pi.setPlanMode(false);
      if (!current()) return false;
      usePiStore.setState({ mode: 'standard' });
      // 失败/取消时也重读主进程，恢复显示仍然生效的会话。
      await refreshSession(version, succeeded ? label : undefined);
      // 导航历史只在切换成功后记（失败时停在原会话，不该多一条历史）；
      // 前进/后退自己传 recordNav:false 跳过（见 src/lib/session-nav.ts）
      if (succeeded && options?.recordNav !== false && current()) recordCurrentSessionNav();
      return current() && succeeded;
    } catch (error) {
      if (current()) {
        usePiStore.setState({
          sessionRevision: null,
          messages: [],
          toolExecutions: {},
          stats: null
        });
        usePiStore.getState().showToast(t.sessionLoadFailed(String(error)), { variant: 'error' });
      }
      return false;
    } finally {
      if (current()) usePiStore.setState({ isSessionLoading: false });
    }
  });
  transitionTail = result.catch(() => {});
  return result;
}
