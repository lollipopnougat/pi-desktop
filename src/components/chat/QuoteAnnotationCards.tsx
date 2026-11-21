import { useEffect, useRef } from 'react';
import { usePiStore } from '../../store/pi-store';
import { quoteSummary } from '../../lib/quote-annotations';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * 输入框上方的「对话引用」卡片：用户选中 agent 回复里的文字后点「添加到对话」生成。
 * 与页面元素批注（ElementAnnotationCards）同构，只是没有缩略图、正文换成引用原文。
 */
export default function QuoteAnnotationCards() {
  const annotations = usePiStore((state) => state.quoteAnnotations);
  const updateAnnotation = usePiStore((state) => state.updateQuoteAnnotation);
  const removeAnnotation = usePiStore((state) => state.removeQuoteAnnotation);
  const clearAnnotations = usePiStore((state) => state.clearQuoteAnnotations);
  const lastInputRef = useRef<HTMLInputElement>(null);
  const prevCountRef = useRef(annotations.length);

  // 只在「新增了一条」时抢焦点（引用一落下就该写想改什么）
  useEffect(() => {
    const grew = annotations.length > prevCountRef.current;
    prevCountRef.current = annotations.length;
    if (grew) lastInputRef.current?.focus();
  }, [annotations.length]);

  if (annotations.length === 0) return null;

  return (
    <div className="mb-2 rounded-lg border border-od-border-light bg-od-bg-alt/40">
      <div className="flex items-center justify-between border-b border-od-border px-2 py-1">
        <span className="flex items-center gap-1.5 text-xs text-od-text-dim">
          <Icon name="quote" className="w-3" />
          {t.quoteTitle(annotations.length)}
        </span>
        <button
          type="button"
          onClick={() => clearAnnotations()}
          className="rounded px-1.5 py-0.5 text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
        >
          {t.annotationClear}
        </button>
      </div>
      <div className="space-y-1.5 p-2">
        {annotations.map((annotation, index) => (
          <div key={annotation.id} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 border-l-2 border-od-accent/50 pl-2 text-xs leading-5 text-od-text-dim">
                  {quoteSummary(annotation.quote)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAnnotation(annotation.id)}
                  aria-label={t.annotationRemove}
                  className="shrink-0 rounded p-0.5 text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
                >
                  <Icon name="close" size="xs" />
                </button>
              </div>
              <input
                ref={index === annotations.length - 1 ? lastInputRef : undefined}
                value={annotation.comment}
                onChange={(event) => updateAnnotation(annotation.id, event.target.value)}
                onKeyDown={(event) => {
                  // 回车 = 写完这条（失焦），不直接发送整条消息
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                placeholder={t.quoteCommentPlaceholder}
                className={`mt-1 w-full rounded border bg-od-bg-dark px-1.5 py-0.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:outline-none ${
                  annotation.comment.trim()
                    ? 'border-transparent focus:border-od-border-light'
                    : 'border-od-yellow/40 focus:border-od-yellow/70'
                }`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
