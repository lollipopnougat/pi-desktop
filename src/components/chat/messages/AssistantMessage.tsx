import { memo, useState, useEffect } from 'react';
import { usePiStore } from '../../../store/pi-store';
import Icon from '../../common/Icon';
import Markdown from '../../common/Markdown';
import { t } from '../../../i18n/zh';
import ToolCard from '../ToolCard';
import ThinkingBlock from '../ThinkingBlock';
import MessageActions from '../MessageActions';

function AssistantMessage({
  message,
  isStreaming = false,
  timestamp,
  badge,
  compact = false,
  showActions = true,
  showStreamingStatus = true,
  copyText
}: {
  message: any;
  isStreaming?: boolean;
  timestamp?: number;
  badge?: string;
  /** 收起 true 时嵌套在折叠块内部（屏蔽 mb-3 外边距，由折叠块自己控制间距） */
  compact?: boolean;
  showActions?: boolean;
  showStreamingStatus?: boolean;
  copyText?: string;
}) {
  // 历史消息订阅整个 store 会逐 token 重渲染，这里只在流式消息（回答条）上取速率/起点
  const streamRate = usePiStore((s) => (isStreaming && showStreamingStatus ? s.streamRate : 0));
  const replyStartedAt = usePiStore((s) =>
    isStreaming && showStreamingStatus ? s.replyStartedAt : null
  );
  // 设置页「显示模型思考块」开关：关闭时对话中不渲染 thinking block
  const showThinkingBlocks = usePiStore((s) => s.showThinkingBlocks);
  // 每秒 tick 驱动耗时刷新；历史消息不启动 timer
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming || replyStartedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming, replyStartedAt]);
  const elapsedSec =
    isStreaming && replyStartedAt != null
      ? Math.max(0, Math.floor((now - replyStartedAt) / 1000))
      : 0;
  const content = message.content || [];

  // 提取原始 markdown 文本（合并所有 text block）
  const textBlocks = content.filter((b: any) => b.type === 'text');
  const rawMarkdown = textBlocks.map((b: any) => b.text).join('\n\n');
  // 只有包含 text block（正常文本回复）时才显示复制/fork 操作栏
  const hasText = textBlocks.length > 0;

  if (
    !(isStreaming && showStreamingStatus) &&
    !message.errorMessage &&
    !content.some(
      (block: any) =>
        block.type === 'text' ||
        block.type === 'toolCall' ||
        (block.type === 'thinking' && showThinkingBlocks)
    )
  )
    return null;

  // ChatStream 按内容块划分正文与工具活动；这里保留独立消息的展示能力。
  return (
    <div className={compact ? '' : 'mb-3'}>
      {/* 请求失败（API 类型不匹配 / 网络错误等）时显示错误信息 */}
      {!isStreaming && message.stopReason === 'error' && message.errorMessage && (
        <div
          className={`rounded border border-od-red/30 bg-od-red/10 px-3 py-2 text-xs text-od-red ${compact ? '' : 'mb-2'}`}
        >
          {message.errorMessage}
        </div>
      )}
      <div className="space-y-2">
        {content.map((block: any, i: number) => {
          if (block.type === 'text') {
            return (
              <Markdown
                key={i}
                content={block.text}
                openLinksInBrowser
                // 只有「本块正在增长」才走流式分块渲染：闭合的块仍整篇高亮
                streaming={isStreaming && i === content.length - 1}
              />
            );
          }
          if (block.type === 'thinking') {
            if (!showThinkingBlocks) return null;
            // 预览仅出现在「本块还在流式输出」时：思考块后面还有块才说明本块已写完
            const thinkingDone = isStreaming && i < content.length - 1;
            return (
              <ThinkingBlock
                key={i}
                text={block.thinking}
                showPreview={isStreaming && !thinkingDone}
              />
            );
          }
          if (block.type === 'toolCall') {
            return <ToolCard key={block.id ?? i} toolCall={block} />;
          }
          return null;
        })}
      </div>
      {!isStreaming && hasText && showActions && (
        <MessageActions
          timestamp={timestamp}
          copyText={copyText ?? rawMarkdown}
          showFork
          align="left"
          badge={badge}
        />
      )}
      {/* 流式：状态行放在块底部，贴近输入框；内容增长时跟随下移 */}
      {isStreaming && showStreamingStatus && (
        <div className="mt-1.5 flex items-center text-xs text-od-text-dim">
          {/* 左：助手 回答中… + 耗时；耗时起始于用户点击发送（agent_start），到回答结束 */}
          <span className="flex items-center gap-1.5 text-od-text">
            <Icon name="robot" className="w-3" />
            {t.assistantStreaming}
            <span className="font-mono tabular-nums text-od-text-dim">{t.elapsed(elapsedSec)}</span>
          </span>
          {/* 右：输出速率；行始终占位、min-w 防位数变化抖动；<0.1 token/s 视为 0 灰显 */}
          <span
            className={`ml-auto inline-block min-w-[7.5ch] text-right font-mono tabular-nums ${
              streamRate > 0.1 ? 'text-od-green' : 'text-od-text-dim'
            }`}
            title="输出速率"
          >
            {t.tokenRate(streamRate > 0.1 ? streamRate : 0)}
          </span>
        </div>
      )}
    </div>
  );
}

// memo：历史条目 props 引用稳定时整条跳过，流式期间不再逐帧重渲染全部回答
export default memo(AssistantMessage);
