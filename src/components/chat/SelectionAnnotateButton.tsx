import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { createQuoteAnnotation } from '../../lib/quote-annotations';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/** 悬浮工具条与选区之间的间距（px） */
const GAP = 8;
/** 工具条最小宽度估计：只在还没量到真实宽度时用于夹边 */
const FALLBACK_WIDTH = 150;

/**
 * 选中 agent 回复里的文字 → 选区上方浮出「添加到对话」。
 *
 * 只对 `[data-annotatable="assistant"]`（AssistantMessage 的正文）里的选区生效：
 * 输入框、工具卡片、侧栏、右侧工作区的选区一律不弹——否则用户复制个路径都会被拦住。
 *
 * 按钮是 `fixed` 定位的浮层，必须 `onMouseDown` 阻止默认行为：否则按下时浏览器先折叠
 * 选区，`selectionchange` 一触发浮层就自己消失了，点击永远落空。
 */
export default function SelectionAnnotateButton() {
  const addQuoteAnnotation = usePiStore((s) => s.addQuoteAnnotation);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [left, setLeft] = useState(0);
  const pillRef = useRef<HTMLDivElement>(null);
  // 选区文本缓存在 ref：点击时选区可能已经被浏览器折叠，不能现取
  const quoteRef = useRef('');

  useEffect(() => {
    const hide = () => setAnchor(null);

    const evaluate = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hide();
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        hide();
        return;
      }
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element =
        node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
      if (!element?.closest('[data-annotatable="assistant"]')) {
        hide();
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) {
        hide();
        return;
      }
      quoteRef.current = text;
      setAnchor({ left: rect.left + rect.width / 2, top: rect.top - GAP });
    };

    // mouseup 之后再取：浏览器要等默认行为走完才更新选区
    const onMouseUp = () => window.setTimeout(evaluate, 0);
    const onSelectionChange = () => {
      if (!window.getSelection()?.isCollapsed) return;
      hide();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // 键盘选文字（Shift+方向键 / Shift+Home）也要弹，否则只有鼠标能用
      if (event.shiftKey) window.setTimeout(evaluate, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    // 按下别处（包括开始新的选择）先收起，避免浮层跟着旧选区晃
    const onMouseDown = (event: MouseEvent) => {
      if (pillRef.current?.contains(event.target as Node)) return;
      hide();
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    // 选区坐标是相对视口的：滚动/改窗口大小它就过期了，直接收起
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // 量到真实宽度后再夹进视口，避免贴边时工具条被切掉一半
  useLayoutEffect(() => {
    if (!anchor) return;
    const width = pillRef.current?.offsetWidth ?? FALLBACK_WIDTH;
    const half = width / 2 + 8;
    setLeft(Math.min(Math.max(anchor.left, half), window.innerWidth - half));
  }, [anchor]);

  if (!anchor) return null;

  const addToChat = () => {
    const annotation = createQuoteAnnotation(quoteRef.current);
    window.getSelection()?.removeAllRanges();
    if (annotation) addQuoteAnnotation(annotation);
    setAnchor(null);
  };

  return (
    <div
      ref={pillRef}
      className="fixed z-[70] flex items-center gap-1 rounded-lg border border-od-border-light bg-od-bg-dark/95 px-1 py-1 text-xs text-od-text shadow-xl backdrop-blur"
      style={{ left, top: anchor.top, transform: 'translate(-50%, -100%)' }}
      // 按下就折叠选区的话按钮永远点不到（见组件注释）
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={addToChat}
        className="flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors hover:bg-od-bg-hover hover:text-od-text-bright active:bg-od-border"
      >
        <Icon name="quote" className="w-3" />
        {t.quoteAddToChat}
      </button>
    </div>
  );
}
