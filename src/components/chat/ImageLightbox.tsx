import { useEffect } from 'react';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * 图片全屏查看器：黑色遮罩层居中显示原图。
 * - ESC / 点击遮罩空白处关闭
 * - 左右箭头 + 键盘 ←→ 切换多图
 * - 点击图片不关闭（避免误触）；点击遮罩区域才关闭
 */
export default function ImageLightbox({
  srcs,
  index,
  onChange,
  onClose
}: {
  srcs: string[];
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  // 键盘导航：ESC 关闭，←→ 切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onChange(index - 1);
      else if (e.key === 'ArrowRight' && index < srcs.length - 1) onChange(index + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, srcs.length, onChange, onClose]);

  const hasPrev = index > 0;
  const hasNext = index < srcs.length - 1;

  return (
    <div
      // 弹窗整层盖住标题栏（App.tsx:109 的 40px drag 区），而 app-region: drag 的区域会吞掉
      // 所有指针事件（不触发 click / mouseenter，光标也不走 CSS）——关闭按钮在 top-4 + h-9
      // 纵向占 16~52px，正好压在 0~40px 的 drag 带内，就是它点不动、光标变箭头的原因。
      // 整个弹窗标 no-drag，把这块矩形从 drag 区里挖出来。
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* 关闭按钮 */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        title={t.image.close}
      >
        <Icon name="close" className="w-4" />
      </button>
      {/* 计数器（多图时显示） */}
      {srcs.length > 1 && (
        <span className="absolute top-5 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
          {index + 1} / {srcs.length}
        </span>
      )}
      {/* 上一张 */}
      {hasPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(index - 1);
          }}
          className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
          title={t.image.prev}
        >
          <Icon name="chevronLeft" className="w-5" />
        </button>
      )}
      {/* 图片本体：点击不关闭（stopPropagation），避免查看时误触 */}
      <img
        src={srcs[index]}
        alt="image"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />
      {/* 下一张 */}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(index + 1);
          }}
          className="absolute right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
          title={t.image.next}
        >
          <Icon name="chevronRight" className="w-5" />
        </button>
      )}
    </div>
  );
}
