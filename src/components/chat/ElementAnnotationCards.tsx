import { useEffect, useRef } from 'react';
import { usePiStore } from '../../store/pi-store';
import { elementLabel, elementSummary } from '../../lib/element-annotations';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * 输入框上方的「页面元素批注」卡片。
 *
 * 一条批注 = 元素矩形缩略图 + 标签/尺寸 + 批注输入框。选中元素后立刻出现并自动聚焦
 * 批注框（用户点完元素就是来写批注的），回车保存（失焦），随时可改可删。
 *
 * 数据在 store 而不是组件 state：点选发生在右侧浏览器面板，卡片渲染在聊天输入框，
 * 两边不是一个组件树；同时它也和输入框草稿同性质，切会话不该丢。
 */
export default function ElementAnnotationCards() {
  const annotations = usePiStore((state) => state.elementAnnotations);
  const updateAnnotation = usePiStore((state) => state.updateElementAnnotation);
  const removeAnnotation = usePiStore((state) => state.removeElementAnnotation);
  const clearAnnotations = usePiStore((state) => state.clearElementAnnotations);
  const lastInputRef = useRef<HTMLInputElement>(null);
  const prevCountRef = useRef(annotations.length);

  const lastId = annotations.length > 0 ? annotations[annotations.length - 1].id : null;

  // 只在「新增了一条」时抢焦点：重新挂载 / 编辑已有批注不打扰
  useEffect(() => {
    const grew = annotations.length > prevCountRef.current;
    prevCountRef.current = annotations.length;
    if (grew) lastInputRef.current?.focus();
  }, [annotations.length, lastId]);

  if (annotations.length === 0) return null;

  return (
    <div className="mb-2 rounded-lg border border-od-border-light bg-od-bg-alt/40">
      <div className="flex items-center justify-between border-b border-od-border px-2 py-1">
        <span className="flex items-center gap-1.5 text-xs text-od-text-dim">
          <Icon name="crosshairs" className="w-3" />
          {t.annotationTitle(annotations.length)}
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
            {annotation.image ? (
              <img
                src={`data:${annotation.image.mimeType};base64,${annotation.image.data}`}
                alt=""
                className="h-11 w-11 shrink-0 rounded border border-od-border-light object-cover"
              />
            ) : (
              <div
                title={t.annotationNoScreenshot}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-od-border-light text-od-text-dim"
              >
                <Icon name="crosshairs" className="w-3" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="shrink-0 rounded bg-od-accent/15 px-1 text-od-accent">
                  {elementLabel(annotation.element)}
                </span>
                <span className="min-w-0 flex-1 truncate text-od-text-dim">
                  {elementSummary(annotation.element)}
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
                placeholder={t.annotationPlaceholder}
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
