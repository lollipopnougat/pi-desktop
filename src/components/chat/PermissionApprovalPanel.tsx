import { usePiStore } from '../../store/pi-store';
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
 *
 * classifier-auto 策略下只提供单次允许/拒绝，主进程把决策模型的判定随请求推来：
 * 展示在工具名下方，让用户在"模型说安全但置信度不够"时能看出为什么要问。
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

export default function PermissionApprovalPanel() {
  const request = usePiStore((s) => s.pendingPermissionRequest);
  const setPendingPermissionRequest = usePiStore((s) => s.setPendingPermissionRequest);
  const sessionAllowedTools = usePiStore((s) => s.sessionAllowedTools);
  const setSessionAllowedTools = usePiStore((s) => s.setSessionAllowedTools);
  const permissionPolicy = usePiStore((s) => s.permissionPolicy);

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

  // 无挂起请求：若本会话有已放行工具，显示可撤销提示条；否则不渲染
  if (!request) {
    if (permissionPolicy === 'classifier-auto' || sessionAllowedTools.length === 0) return null;
    return (
      <div className="mb-2 flex items-center justify-between rounded-xl border border-od-border-light bg-od-bg-alt px-3 py-1.5">
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
        {!request.classifier && (
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
