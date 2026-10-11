import { useState, useCallback } from 'react';
import { usePiStore } from '../../../store/pi-store';
import { t } from '../../../i18n/zh';
import { renderTextWithSkillChips } from '../chat-utils';
import ImageLightbox from '../ImageLightbox';

/**
 * 渲染用户消息内容：支持纯文本与 content blocks（文本 + 图片）。
 * SDK 合成的 content 顺序固定为 [text, image1, image2, ...]。
 * 文本在上方，多张图片在下方横向 wrap 排布成网格，点击缩略图全屏查看。
 */
export default function UserMessageContent({ content }: { content: any }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const setRightPanelOpen = usePiStore((s) => s.setRightPanelOpen);
  const setPendingFile = usePiStore((s) => s.setPendingFile);
  const handleOpenSkill = useCallback(
    (location: string) => {
      setRightPanelOpen(true);
      setPendingFile({ path: location, mode: 'file' });
    },
    [setRightPanelOpen, setPendingFile]
  );

  // 纯文本直接返回（含技能块时折叠为 chip）
  if (typeof content === 'string') {
    return (
      <span className="whitespace-pre-wrap break-words">
        {renderTextWithSkillChips(content, handleOpenSkill)}
      </span>
    );
  }
  if (!Array.isArray(content)) return null;

  const textBlocks = content.filter((c: any) => c && c.type === 'text' && c.text);
  const imageBlocks = content.filter((c: any) => c && c.type === 'image');
  if (textBlocks.length === 0 && imageBlocks.length === 0) return null;

  // 预拼 data URL，避免在 JSX 里重复拼接
  const imageSrcs = imageBlocks.map((b: any) => `data:${b.mimeType};base64,${b.data}`);

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        {/* 文本：合并所有 text block，在上方 */}
        {textBlocks.length > 0 && (
          <span className="whitespace-pre-wrap break-words">
            {renderTextWithSkillChips(
              textBlocks.map((b: any) => b.text).join('\n\n'),
              handleOpenSkill
            )}
          </span>
        )}
        {/* 图片：横向 wrap 排布，多图时形成紧凑网格 */}
        {imageBlocks.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {imageSrcs.map((src, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setLightboxIndex(i)}
                className="block h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-od-border transition-opacity hover:opacity-80"
                title={t.image.preview}
              >
                <img src={src} alt="image" className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 全屏查看 */}
      {lightboxIndex !== null && imageSrcs.length > 0 && (
        <ImageLightbox
          srcs={imageSrcs}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
