import { usePiStore, type PermissionReviewNotice } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * PermissionApprovalPanel：展示在输入框上方，当权限闸门拦截工具调用时出现。
 * 显示工具名 + 命令/参数预览，用户允许/拒绝后经 window.pi.permissionResponse
 * 回传主进程，主进程 resolve beforeToolCall 的挂起 promise。
 *
 * 三个决策：
 * - deny：拒绝本次调用
 * - allow：放行本次调用（下次同类调用仍会弹审批）
 * - allow-session：放行本次 + 本次会话内同名工具自动通过，无需人工确认
 *   （mcp 代理工具按工具名整体放行，含 list/connect/call，切换会话后失效）
 *   仅 ask-all / auto-safe 提供此选项。危险命令（rm -rf、dd、mkfs 等命中 denylist）不享受
 *   静默放行 —— 主进程会在会话级放行路径上强制弹审批（危险命令每次都要过目）。
 *
 * 无挂起请求但本会话存在「已会话级放行」的工具时，显示提示条 + 撤销按钮。
 * 同理，无挂起请求但有「帮我审批」的最近结论时，显示一条结论条（自动放行不需要用户点确认，
 * 但必须让用户看得见刚才被自动放行/拒绝的是什么），可手动关闭。
 *
 * classifier-auto 策略下只提供单次允许/拒绝，主进程把决策模型的判定随请求推来：
 * 展示在工具名下方，让用户在"模型说安全但置信度不够"时能看出为什么要问。
 * reviewer-auto 同理：回退人工时带 `reviewerNote` 说明评审员为什么没给出结论。
 */

/** 决策模型判定等级的徽章样式（与危险命令警示区分：这是模型意见，不是 denylist 命中） */
const CLASSIFIER_LEVEL_STYLE: Record<'safe' | 'risky' | 'dangerous', string> = {
  safe: 'bg-od-green/15 text-od-green',
  risky: 'bg-od-orange/15 text-od-orange',
  dangerous: 'bg-od-red/15 text-od-red'
};

const CLASSIFIER_LEVEL_ICON: Record<'safe' | 'risky' | 'dangerous', string> = {
  safe: 'text-od-green',
  risky: 'text-od-orange',
  dangerous: 'text-od-red'
};

/** 评审结论的三态色板（allow 绿 / deny 红 / fallback 黄） */
const REVIEW_OUTCOME_STYLE: Record<PermissionReviewNotice['outcome'], string> = {
  allow: 'bg-od-green/15 text-od-green',
  deny: 'bg-od-red/15 text-od-red',
  fallback: 'bg-od-yellow/15 text-od-yellow'
};

/**
 * 「帮我审批」结论条：一行展示最近一次自动评审的结果。
 * 自动放行不需要用户点确认（这正是第 5 档的意义），但必须可见、可关闭。
 */
function ReviewerNoticeStrip({
  notice,
  onDismiss
}: {
  notice: PermissionReviewNotice;
  onDismiss: () => void;
}) {
  const detail = notice.note ?? notice.rationale ?? '';
  return (
    <div className="flex items-center justify-between rounded-xl border border-od-border-light bg-od-bg-alt px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="reviewer" size="xs" className="shrink-0 text-od-cyan" />
        <span className="shrink-0 text-xs text-od-text-dim">
          {t.permissionReviewerNoticeTitle}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${REVIEW_OUTCOME_STYLE[notice.outcome]}`}
        >
          {t.permissionReviewerOutcome[notice.outcome]}
        </span>
        <span className="shrink-0 rounded bg-od-bg-hover px-1.5 py-0.5 text-xs font-medium text-od-text-bright">
          {notice.toolName}
        </span>
        {notice.riskLevel && (
          <span className="shrink-0 text-xs text-od-text-dim">
            {t.permissionReviewerRisk[notice.riskLevel]}
          </span>
        )}
        {notice.coerced && (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-od-yellow">
            <Icon name="warning" className="w-3 shrink-0" />
            {t.permissionReviewerCoerced[notice.coerced]}
          </span>
        )}
        {detail && <span className="truncate text-xs text-od-text-dim">{detail}</span>}
        <span className="shrink-0 text-xs text-od-text-dim">
          {t.permissionReviewerElapsed((notice.elapsedMs / 1000).toFixed(1))}
        </span>
      </div>
      <button
        onClick={onDismiss}
        className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
        title={t.permissionReviewerReviewsLabel}
      >
        <Icon name="close" size="xs" />
      </button>
    </div>
  );
}

export default function PermissionApprovalPanel() {
  const request = usePiStore((s) => s.pendingPermissionRequest);
  const setPendingPermissionRequest = usePiStore((s) => s.setPendingPermissionRequest);
  const sessionAllowedTools = usePiStore((s) => s.sessionAllowedTools);
  const setSessionAllowedTools = usePiStore((s) => s.setSessionAllowedTools);
  const permissionPolicy = usePiStore((s) => s.permissionPolicy);
  const recentReviews = usePiStore((s) => s.recentPermissionReviews);
  const setRecentPermissionReviews = usePiStore((s) => s.setRecentPermissionReviews);

  /** 回传决策（allow-session 时本地同步登记，避免等主进程回包的窗口期） */
  const respond = (decision: 'allow' | 'deny' | 'allow-session') => {
    if (!request) return;
    const effectiveDecision =
      request.classifier && decision === 'allow-session' ? 'allow' : decision;
    window.pi.permissionResponse(request.id, effectiveDecision);
    if (effectiveDecision === 'allow-session' && !sessionAllowedTools.includes(request.toolName)) {
      setSessionAllowedTools([...sessionAllowedTools, request.toolName]);
    }
    setPendingPermissionRequest(null);
  };

  /** 撤销「本次会话允许」（恢复逐次审批） */
  const revokeSessionAllow = () => {
    window.pi.clearSessionAllowedTools().catch(() => {});
    setSessionAllowedTools([]);
  };

  // 无挂起请求：显示最近一次评审结论 +（可选）本会话已放行提示条；两者都无则不渲染
  if (!request) {
    const latest = recentReviews[0];
    const showSessionStrip =
      permissionPolicy !== 'classifier-auto' && sessionAllowedTools.length > 0;
    if (!latest && !showSessionStrip) return null;
    return (
      <div className="mb-2 space-y-1.5">
        {latest && (
          <ReviewerNoticeStrip notice={latest} onDismiss={() => setRecentPermissionReviews([])} />
        )}
        {showSessionStrip && (
          <div className="flex items-center justify-between rounded-xl border border-od-border-light bg-od-bg-alt px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Icon name="unlock" size="xs" className="text-od-green" />
              <span className="truncate text-xs text-od-text-dim">
                {t.permissionSessionAllowed(toolsLabel(sessionAllowedTools))}
              </span>
            </div>
            <button
              onClick={revokeSessionAllow}
              className="ml-2 flex-shrink-0 rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
              title={t.permissionSessionRevokeDesc}
            >
              {t.permissionSessionRevoke}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`mb-2 rounded-xl border shadow-lg ${
        request.danger ? 'border-od-red/70 bg-od-bg-alt' : 'border-od-orange/60 bg-od-bg-alt'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-od-border px-3 py-2">
        <div className="flex items-center gap-2">
          {request.danger ? (
            <>
              <Icon name="warning" className="w-3 text-od-red" />
              <span className="text-xs font-medium text-od-red">{t.permissionDangerTitle}</span>
              <span className="rounded bg-od-red/15 px-1.5 py-0.5 text-xs text-od-red">
                {t.permissionDangerCategory[request.danger.category] ??
                  t.permissionDangerCategory.unknown}
              </span>
            </>
          ) : (
            <>
              <Icon name="shield" className="w-3 text-od-orange" />
              <span className="text-xs font-medium text-od-text-bright">{t.permissionTitle}</span>
            </>
          )}
        </div>
        <button
          onClick={() => respond('deny')}
          className="flex h-5 w-5 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-red"
          title={t.permissionDeny}
        >
          <Icon name="close" size="xs" />
        </button>
      </div>

      {/* Body: 工具名 + 预览 */}
      <div className="px-3 py-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded bg-od-bg-hover px-1.5 py-0.5 text-xs font-medium text-od-text-bright">
            {request.toolName}
          </span>
          <span className="text-xs text-od-text-dim">
            {request.danger ? t.permissionDangerHint : t.permissionRequestHint}
          </span>
        </div>
        {request.classifier && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
            <Icon
              name="classifier"
              className={`w-3 ${
                request.classifier.ok && request.classifier.level
                  ? CLASSIFIER_LEVEL_ICON[request.classifier.level]
                  : 'text-od-text-dim'
              }`}
            />
            <span className="text-od-text-dim">{t.permissionClassifierVerdictLabel}</span>
            {request.classifier.ok && request.classifier.level ? (
              <span
                className={`rounded px-1.5 py-0.5 ${CLASSIFIER_LEVEL_STYLE[request.classifier.level]}`}
              >
                {t.permissionClassifierLevel[request.classifier.level]}
              </span>
            ) : (
              <span className="rounded bg-od-bg-hover px-1.5 py-0.5 text-od-text-dim">
                {t.permissionClassifierUnavailable}· {t.permissionClassifierUnavailableHint}
              </span>
            )}
            {typeof request.classifier.confidence === 'number' && (
              <span className="text-od-text-dim">
                {t.permissionClassifierConfidence(Math.round(request.classifier.confidence * 100))}
              </span>
            )}
            {request.classifier.note &&
              (request.classifier.ok ? (
                <span className="text-od-text-dim">· {request.classifier.note}</span>
              ) : (
                /* 未判定：把原因（超时/未配模型/端点报错…）用警示色完整显示，别让用户猜 */
                <span className="inline-flex items-center gap-1 text-od-yellow">
                  <Icon name="warning" className="w-3 shrink-0" />
                  {request.classifier.note}
                </span>
              ))}
          </div>
        )}
        {request.reviewerNote && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
            <Icon name="reviewer" className="w-3 shrink-0 text-od-cyan" />
            <span className="text-od-text-dim">{t.permissionReviewerNoteLabel}</span>
            {/* 回退原因用警示色完整显示（超时/未配模型/熔断/不可自动放行的危险类目） */}
            <span className="inline-flex items-center gap-1 text-od-yellow">
              <Icon name="warning" className="w-3 shrink-0" />
              {request.reviewerNote}
            </span>
          </div>
        )}
        {request.preview && (
          /* 超长命令不截断：给一个限高 + 滚动条，完整命令靠滚动查看 */
          <pre
            className={`max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded-lg border bg-od-bg-dark px-2 py-1.5 text-xs text-od-text ${
              request.danger ? 'border-od-red/50' : 'border-od-border-light'
            }`}
          >
            {request.preview}
          </pre>
        )}
      </div>

      {/* Footer: 拒绝 / 允许 / 本次会话允许 */}
      <div className="flex items-center justify-end gap-2 border-t border-od-border px-3 py-2">
        <button
          onClick={() => respond('deny')}
          className="rounded border border-od-border-light px-3 py-1 text-xs text-od-text-dim transition-colors hover:border-od-red/50 hover:text-od-red"
        >
          {t.permissionDeny}
        </button>
        <button
          onClick={() => respond('allow')}
          className="rounded border border-od-border-light px-3 py-1 text-xs text-od-text-bright transition-colors hover:border-od-accent/50 hover:text-od-accent"
        >
          {t.permissionAllow}
        </button>
        {/* 「本次会话允许」仅在人工策略下提供：classifier-auto / reviewer-auto 里它等于把
            自动判定整个绕开（第 5 档会被退化成 allow-all 的子集） → 只给单次允许/拒绝 */}
        {!request.classifier && permissionPolicy !== 'reviewer-auto' && (
          <button
            onClick={() => respond('allow-session')}
            className="rounded bg-od-accent px-3 py-1 text-xs text-white transition-colors hover:bg-od-accent/80 active:bg-od-accent/65"
            title={t.permissionAllowSessionDesc}
          >
            {t.permissionAllowSession}
          </button>
        )}
      </div>
    </div>
  );
}

/** 工具列表展示文案（超过 3 个折叠为数量） */
function toolsLabel(tools: string[]): string {
  if (tools.length <= 3) return tools.join('、');
  return `${tools.slice(0, 3).join('、')} +${tools.length - 3}`;
}
