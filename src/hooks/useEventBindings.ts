/**
 * 全局事件订阅 hook：菜单 / ask / plan 提案 / 定时刷新 stats。
 *
 * 把 App.tsx 里几个只注册一次的事件订阅收编于此，退订在 cleanup 里统一处理。
 */
import { useEffect } from 'react';
import { usePiStore } from '../store/pi-store';
import { t } from '../i18n/zh';
import { transitionSession, captureSessionGuard, isCurrentSession } from './loadSession';
import { confirmStopRunning, handleQuitConfirmRequest } from '../lib/stopRunningConfirm';

/** 系统通知正文最多展示这么多字符（审批面板本身仍展示完整命令，可滚动） */
const NOTIFY_PREVIEW_LIMIT = 120;

function clipForNotify(text: string): string {
  return text.length > NOTIFY_PREVIEW_LIMIT ? `${text.slice(0, NOTIFY_PREVIEW_LIMIT)}…` : text;
}

export function useEventBindings() {
  const setSettingsOpen = usePiStore((s) => s.setSettingsOpen);
  const setAskQuestions = usePiStore((s) => s.setAskQuestions);
  const setPendingPermissionRequest = usePiStore((s) => s.setPendingPermissionRequest);
  const setPlanPendingProposal = usePiStore((s) => s.setPlanPendingProposal);
  const setStats = usePiStore((s) => s.setStats);

  useEffect(() => {
    // 菜单栏「设置」事件（macOS App 菜单 / Windows 帮助菜单）
    const unsubMenuSettings = window.pi.onMenuOpenSettings(() => setSettingsOpen(true));
    // 菜单栏「打开文件夹」事件：与 ChatInput 的「在新项目中开始会话」逻辑一致
    const unsubMenu = window.pi.onMenuOpenFolder(async () => {
      const dir = await window.pi.selectDirectory();
      if (!dir) return;
      // 切换项目目录会重建 runtime（中止当前轮），运行中先确认
      if (!(await confirmStopRunning(t.stopRunningActionCwd))) return;
      await transitionSession(() => window.pi.setCwd(dir));
    });
    return () => {
      unsubMenuSettings();
      unsubMenu();
    };
  }, [setSettingsOpen]);

  // 主进程请求退出/关窗确认（会话运行中时）：用应用内弹窗回答，回答后主进程才真正退出
  useEffect(() => {
    return window.pi.onQuitConfirmRequest(() => handleQuitConfirmRequest());
  }, []);

  // 监听 ask 工具提问请求（同时发系统通知提醒用户回答）
  useEffect(() => {
    return window.pi.onAskUser((questions, identity) => {
      if (!isCurrentSession(identity)) return;
      // 带上提问所属会话：多会话下答案必须回到发起提问的那个会话
      setAskQuestions(questions, identity.sessionId);
      const first = questions?.[0];
      const body =
        first?.question ||
        (Array.isArray(first?.options) && first.options.length ? first.options.join(' / ') : '');
      window.pi.notify('ask', t.notifyAskTitle, body).catch(() => {});
    });
  }, [setAskQuestions]);

  // 监听权限闸门审批请求（同时发系统通知提醒用户审批）
  useEffect(() => {
    return window.pi.onPermissionRequest((request, identity) => {
      if (!isCurrentSession(identity)) return;
      setPendingPermissionRequest(request);
      // 审批面板展示完整命令（可滚动）；系统通知正文有限宽，这里单独裁剪
      window.pi
        .notify(
          'ask',
          t.notifyPermissionTitle,
          `${request.toolName}: ${clipForNotify(request.preview)}`
        )
        .catch(() => {});
    });
  }, [setPendingPermissionRequest]);

  // 监听 plan 提案提交(propose_plan 工具 → 主进程 → 弹评审面板)
  useEffect(() => {
    return window.pi.onPlanProposal((proposal, identity) => {
      if (isCurrentSession(identity)) setPlanPendingProposal(proposal);
    });
  }, [setPlanPendingProposal]);

  // Periodically refresh stats (token/cost/context)
  useEffect(() => {
    const tick = async () => {
      if (usePiStore.getState().isStreaming) return;
      const current = captureSessionGuard();
      try {
        const stats = await window.pi.getSessionStats();
        if (stats && current()) {
          setStats({
            tokens: stats.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: stats.cost || 0,
            contextPercent: stats.contextUsage?.percent || 0
          });
        }
      } catch {}
    };
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [setStats]);
}
