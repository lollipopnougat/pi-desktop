import { useState, useMemo } from 'react';
import { usePiStore, type PendingProposal } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';
import { type PlanAnnotation, buildAnnotation } from './annotation';
import Markdown from '../common/Markdown';

/**
 * PlanReviewPanel:agent 调 propose_plan 后,主进程 pi:planProposal 推过来
 * store.planPendingProposal,这里展示方案全文 + 选中加批注 + 批准/驳回。
 *
 * 批准/驳回经 window.pi.plan.submitResponse 回灌主进程,主进程解锁 propose_plan
 * 工具的 await promise(批准 → controller 切 executing+续跑;驳回 → 同回合反馈回模型)。
 *
 * 渲染策略:用纯文本 pre 块(等宽白底)渲染方案,确保 window.getSelection() 拿到的
 * originalText 与方案原文逐字一致。富文本 markdown 渲染会因跨节点选区导致 toString
 * 与原文偏移/换行不一致。后续如需排版带高亮,可改用基于源位置的可批注渲染器。
 */
export default function PlanReviewPanel() {
  const proposal = usePiStore((s) => s.planPendingProposal) as PendingProposal | null;
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string>('');
  const [commentText, setCommentText] = useState('');
  const [showGlobal, setShowGlobal] = useState(false);
  const [globalText, setGlobalText] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectText, setRejectText] = useState('');
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [approveNotes, setApproveNotes] = useState('');
  // 浮层:选中后弹「加批注/建议删除」操作气泡
  const [popover, setPopover] = useState<{ x: number; y: number; text: string } | null>(null);

  const hasAnnotations = useMemo(() => annotations.length > 0, [annotations]);

  if (!proposal) return null;

  const captureSelection = (): string => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const raw = sel.toString();
    if (!raw.trim()) return '';
    // 选区落到方案渲染区(避免选到批注等面板其他文字)
    const range = sel.getRangeAt(0);
    const container = document.getElementById('plan-content-block');
    if (!container) return '';
    if (!container.contains(range.commonAncestorContainer)) return '';
    // markdown 渲染成 HTML 后,Selection.toString() 返回可见文本(去标签保留换行),
    // 与方案原文可能有空白差异;规一化为单空格便于模型据锚点语义检索定位
    return raw.replace(/\s+/g, ' ').trim();
  };

  // 在方案区块内 mouseup 时:若有选区,弹加批注浮层
  const handleMouseUp = (e: React.MouseEvent) => {
    const text = captureSelection();
    if (!text) {
      setPopover(null);
      return;
    }
    setPendingSelection(text);
    // 浮层位置:鼠标附近
    setPopover({ x: e.clientX, y: e.clientY, text: text });
  };

  const addCommentAnnotation = () => {
    if (!pendingSelection.trim() || !commentText.trim()) return;
    const ann = buildAnnotation('COMMENT', commentText.trim(), pendingSelection.trim());
    setAnnotations([...annotations, ann]);
    setCommentText('');
    setPendingSelection('');
    setPopover(null);
    setShowAdd(false);
    clearSelection();
  };

  const addDeletionAnnotation = () => {
    if (!pendingSelection.trim()) return;
    const ann = buildAnnotation('DELETION', '建议删除', pendingSelection.trim());
    setAnnotations([...annotations, ann]);
    setPendingSelection('');
    setPopover(null);
    clearSelection();
  };

  const addGlobalAnnotation = () => {
    if (!globalText.trim()) return;
    const ann = buildAnnotation('GLOBAL_COMMENT', globalText.trim(), '');
    setAnnotations([...annotations, ann]);
    setGlobalText('');
    setShowGlobal(false);
  };

  const removeAnnotation = (id: string) => {
    setAnnotations(annotations.filter((a) => a.id !== id));
  };

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
  };

  /**
   * 把批注编译成带原文锚点的反馈串(照 plannotator external-annotation 格式)。
   * 批准附注 + 驳回都走这个编译,模型可在反馈里据「原文「...」」锚点定位修改。
   */
  const compileFeedback = (extraGlobal?: string): string => {
    const lines: string[] = [];
    const globalNotes = [
      extraGlobal,
      ...annotations.filter((a) => a.type === 'GLOBAL_COMMENT').map((a) => a.text)
    ].filter(Boolean);
    const anchored = annotations.filter((a) => a.type === 'COMMENT' || a.type === 'DELETION');

    if (globalNotes.length > 0) {
      lines.push(`### 全局意见`);
      for (const g of globalNotes) lines.push(`- ${g}`);
      if (anchored.length > 0) lines.push('');
    }
    if (anchored.length > 0) {
      lines.push(`### 针对方案的批注`);
      for (const a of anchored) {
        if (a.type === 'COMMENT') {
          lines.push(`- ${t.planFeedbackOn(a.originalText)} 修改意见:${a.text}`);
        } else {
          lines.push(`- 建议删除原文:「${a.originalText}」`);
        }
      }
    }
    return lines.join('\n');
  };

  const handleApprove = () => {
    // 批准:即使有批注也直接进入实现(批注不回灌);仅把当前输入框的可选全局附注带走
    const notes = approveNotes.trim();
    window.pi.plan.submitResponse(proposal.id, {
      approved: true,
      feedback: notes || undefined
    });
    reset();
  };

  const handleReject = () => {
    const feedback = compileFeedback(rejectText.trim() || undefined);
    // 至少有一条反馈才有意义;若无任何批注也无理由,用一个默认理由
    const finalFeedback = feedback || '方案被驳回,请修订后重新提交。';
    window.pi.plan.submitResponse(proposal.id, {
      approved: false,
      feedback: finalFeedback
    });
    reset();
  };

  const reset = () => {
    setAnnotations([]);
    setCommentText('');
    setGlobalText('');
    setRejectText('');
    setApproveNotes('');
    setPendingSelection('');
    setPopover(null);
    setShowAdd(false);
    setShowGlobal(false);
    setShowReject(false);
    setShowApproveConfirm(false);
  };

  return (
    <div className="mb-2 rounded-xl border border-od-purple/50 bg-od-bg-alt shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-od-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="clipboardList" className="w-3 shrink-0 text-od-purple" />
          <span className="text-xs font-medium text-od-text-bright">{t.planReviewTitle}</span>
          <span className="text-xs text-od-text-dim">{t.planVersion(proposal.variant)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowGlobal((v) => !v)}
            className="rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.planGlobalComment}
          >
            <Icon name="comment" className="w-3" />
          </button>
          <button
            onClick={clearSelection}
            className="rounded px-2 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
          >
            {annotations.length}
          </button>
        </div>
      </div>

      {/* 描述与提示 */}
      <div className="px-3 py-1.5 text-xs text-od-text-dim">{t.planReviewDesc}</div>

      <div className="flex min-h-0 flex-col md:flex-row">
        {/* 方案内容(markdown 渲染,可选中加批注) */}
        <div className="min-w-0 flex-1 px-3 pb-2">
          <div
            id="plan-content-block"
            onMouseUp={handleMouseUp}
            className="plan-content max-h-[40vh] overflow-auto rounded-lg border border-od-border bg-od-bg-dark px-3 py-2 text-xs leading-relaxed selection:bg-od-purple/40"
          >
            <Markdown content={proposal.content} />
          </div>
        </div>

        {/* 批注列表 */}
        <div className="min-w-0 shrink-0 px-3 pb-2 md:w-64">
          <div className="mb-1 text-xs font-medium text-od-text">批注 ({annotations.length})</div>
          <div className="max-h-[36vh] space-y-1.5 overflow-auto">
            {annotations.length === 0 && (
              <div className="rounded border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-dim">
                {t.planCommentListEmpty}
              </div>
            )}
            {annotations.map((a) => (
              <div
                key={a.id}
                className="rounded border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-od-purple">
                    {a.type === 'COMMENT'
                      ? t.planAnnotationComment
                      : a.type === 'DELETION'
                        ? t.planAnnotationDeletion
                        : t.planAnnotationGlobal}
                  </span>
                  <button
                    onClick={() => removeAnnotation(a.id)}
                    className="text-od-text-dim hover:text-od-red"
                    title={t.askCancel}
                  >
                    <Icon name="close" className="w-2.5" />
                  </button>
                </div>
                {a.originalText && (
                  <div className="mb-1 rounded bg-od-bg/40 px-1.5 py-0.5 text-od-text-dim">
                    「
                    {a.originalText.length > 60
                      ? a.originalText.slice(0, 60) + '…'
                      : a.originalText}
                    」
                  </div>
                )}
                {a.text && <div className="text-od-text-bright">{a.text}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 选中后的浮层操作气泡 */}
      {popover && (
        <div
          className="fixed z-50 flex gap-1 rounded-lg border border-od-border-light bg-od-bg-alt py-1 shadow-xl"
          style={{ left: popover.x, top: popover.y - 40 }}
        >
          <button
            onClick={() => {
              setShowAdd(true);
              setPopover(null);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-od-text-bright hover:bg-od-bg-hover"
          >
            <Icon name="pencil" className="w-3" />
            {t.planAddComment}
          </button>
          <button
            onClick={addDeletionAnnotation}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-od-text-bright hover:bg-od-bg-hover"
          >
            <Icon name="delete" className="w-3" />
            {t.planSuggestDelete}
          </button>
          <button
            onClick={() => {
              setPopover(null);
              clearSelection();
              setPendingSelection('');
            }}
            className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover"
          >
            <Icon name="close" className="w-3" />
          </button>
        </div>
      )}

      {/* 批注输入弹层(选中后点「加批注」触发) */}
      {showAdd && (
        <div className="border-t border-od-border px-3 py-2">
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder={t.planCommentInputPlaceholder}
            rows={2}
            className="mb-2 w-full rounded-lg border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-od-purple/60 focus:outline-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAdd(false);
                setCommentText('');
                setPendingSelection('');
              }}
              className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover"
            >
              {t.askCancel}
            </button>
            <button
              onClick={addCommentAnnotation}
              disabled={!commentText.trim()}
              className="rounded bg-od-purple px-3 py-1 text-xs text-white transition-colors hover:bg-od-purple/80 disabled:opacity-40"
            >
              {t.planAddComment}
            </button>
          </div>
        </div>
      )}

      {/* 全局批注输入 */}
      {showGlobal && (
        <div className="border-t border-od-border px-3 py-2">
          <textarea
            value={globalText}
            onChange={(e) => setGlobalText(e.target.value)}
            placeholder={t.planCommentInputPlaceholder}
            rows={2}
            className="mb-2 w-full rounded-lg border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-od-purple/60 focus:outline-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowGlobal(false);
                setGlobalText('');
              }}
              className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover"
            >
              {t.askCancel}
            </button>
            <button
              onClick={addGlobalAnnotation}
              disabled={!globalText.trim()}
              className="rounded bg-od-purple px-3 py-1 text-xs text-white transition-colors hover:bg-od-purple/80 disabled:opacity-40"
            >
              {t.planAddComment}
            </button>
          </div>
        </div>
      )}

      {/* 驳回/提交反馈输入(两者闭环一致:让模型据反随籂改重交方案) */}
      {showReject && (
        <div className="border-t border-od-border px-3 py-2">
          <div className="mb-1 text-xs text-od-text-dim">
            {hasAnnotations ? t.planSubmitFeedbackPrompt : t.planRejectPrompt}
          </div>
          <textarea
            value={rejectText}
            onChange={(e) => setRejectText(e.target.value)}
            placeholder={hasAnnotations ? t.planSubmitFeedbackPlaceholder : undefined}
            rows={2}
            className="mb-2 w-full rounded-lg border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-od-purple/60 focus:outline-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowReject(false);
                setRejectText('');
              }}
              className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover"
            >
              {t.askCancel}
            </button>
            <button
              onClick={handleReject}
              className="rounded bg-od-purple px-3 py-1 text-xs text-white transition-colors hover:bg-od-purple/80"
            >
              {hasAnnotations ? t.planSubmitFeedback : t.planReject}
            </button>
          </div>
        </div>
      )}

      {/* 批准确认弹框(无批注→可选附注;有批注→据「将忽略批注」确认,仍可输全局意见) */}
      {showApproveConfirm && (
        <div className="border-t border-od-border px-3 py-2">
          <div className="mb-1 text-xs text-od-text-dim">
            {hasAnnotations ? t.planApproveWithAnnotationsPrompt : t.planApprovePrompt}
          </div>
          <textarea
            value={approveNotes}
            onChange={(e) => setApproveNotes(e.target.value)}
            placeholder={
              hasAnnotations ? t.planApproveNotesPlaceholderOptional : t.planApproveNotesPlaceholder
            }
            rows={2}
            className="mb-2 w-full rounded-lg border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-od-purple/60 focus:outline-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowApproveConfirm(false);
                setApproveNotes('');
              }}
              className="rounded px-2 py-1 text-xs text-od-text-dim hover:bg-od-bg-hover"
            >
              {t.askCancel}
            </button>
            <button
              onClick={handleApprove}
              className="rounded bg-od-green/80 px-3 py-1 text-xs text-white transition-colors hover:bg-od-green"
            >
              {t.planApprove}
            </button>
          </div>
        </div>
      )}

      {/* 底部动作按钮:批准(右) + 提交反馈(有批注时并列右侧) */}
      {!showAdd && !showGlobal && !showReject && !showApproveConfirm && (
        <div className="flex items-center justify-end gap-2 border-t border-od-border px-3 py-2">
          {hasAnnotations && (
            <button
              onClick={() => setShowReject(true)}
              className="rounded bg-od-purple px-3 py-1 text-xs text-white transition-colors hover:bg-od-purple/80"
            >
              {t.planSubmitFeedback}
            </button>
          )}
          <button
            onClick={() => setShowApproveConfirm(true)}
            className="rounded bg-od-green/80 px-3 py-1 text-xs text-white transition-colors hover:bg-od-green"
          >
            {t.planApprove}
          </button>
        </div>
      )}
    </div>
  );
}
