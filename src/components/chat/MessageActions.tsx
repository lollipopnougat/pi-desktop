import { useState } from 'react';
import { transitionSession, captureSessionGuard } from '../../hooks/loadSession';
import { confirmStopRunning } from '../../lib/stopRunningConfirm';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { formatTime } from '../../utils/time';
import { copyToClipboard } from '../../utils/clipboard';

/**
 * 消息操作栏：复制按钮 + (可选)fork 按钮 + 发送时间
 */
export default function MessageActions({
  timestamp,
  copyText,
  showFork,
  align,
  badge
}: {
  timestamp?: number;
  copyText: string;
  showFork?: boolean;
  align: 'left' | 'right';
  badge?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(copyText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleFork = async () => {
    if (!timestamp) return;
    const current = captureSessionGuard();
    // fork 会替换 session（中止当前轮），运行中先确认
    if (!(await confirmStopRunning(t.stopRunningActionFork))) return;
    if (!current()) return;
    try {
      await transitionSession(() => window.pi.forkByTimestamp(timestamp, 'at'));
    } catch (e) {
      console.error('fork failed:', e);
    }
  };

  return (
    <div
      className={`mt-1 flex items-center gap-1 text-xs text-od-text-dim ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
        title={copied ? t.copied : t.copyMessage}
      >
        <Icon name={copied ? 'check' : 'copy'} className="w-3" />
      </button>
      {showFork && (
        <button
          onClick={handleFork}
          className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          title={t.forkFromHere}
        >
          <Icon name="branch" className="w-3" />
        </button>
      )}
      {badge && (
        <span className="ml-1 rounded bg-od-orange/20 px-1.5 py-0.5 text-xs text-od-orange">
          {badge}
        </span>
      )}
      {timestamp ? <span className="ml-1 font-mono">{formatTime(timestamp)}</span> : null}
    </div>
  );
}
