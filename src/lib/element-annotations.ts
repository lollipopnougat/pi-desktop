/**
 * 「页面元素批注」的数据层与提示词拼装。
 *
 * 一条批注 = 元素快照（选择器/样式/文本/HTML）+ 元素矩形截图 + 用户写的批注。
 * 发送时拼成一段固定的 markdown 块，截图作为普通图片附件跟在后面 —— 顺序必须与块内
 * 「批注 1 / 批注 2」一一对应，否则模型会把截图配错元素。
 *
 * 为什么放渲染进程（而不是主进程）：批注与输入框里的草稿是同一份 UI 状态，主进程拿不到
 * 渲染端 state；主进程只负责「点选 + 截元素图」这两件只有它能做的事。
 */
import type { BrowserPickedElement, BrowserPickResult } from '../types/pi';

/** HTML 在提示词里的上限：整段 outerHTML 常常几千字符，而模型通常只需要看标签与关键属性 */
const MAX_HTML_IN_PROMPT = 600;

export interface ElementAnnotation {
  id: string;
  createdAt: number;
  /** 主进程采集到的元素快照 */
  element: BrowserPickedElement;
  /** 用户写的批注（可为空 —— 只标注不说话也算一种提问） */
  comment: string;
  /** 元素矩形截图（base64，不带 data: 前缀）；面板不可见等原因截不到时没有 */
  image?: { data: string; mimeType: string };
}

let annotationSeq = 0;

/** 从一次点选结果构造批注；用户取消（element 为 null）返回 null */
export function createAnnotation(result: BrowserPickResult): ElementAnnotation | null {
  if (!result?.element) return null;
  annotationSeq += 1;
  return {
    id: `el-${Date.now().toString(36)}-${annotationSeq}`,
    createdAt: Date.now(),
    element: result.element,
    comment: '',
    ...(result.image && result.image.data ? { image: result.image } : {})
  };
}

/** chip / 列表里显示的简短标签：div / a.nav-link */
export function elementLabel(element: BrowserPickedElement): string {
  const selector = element.selector || '';
  const last = selector.split(' > ').pop() ?? '';
  return last || element.tagName;
}

/** 一行摘要：尺寸 + 文本（chip 上放不下完整信息） */
export function elementSummary(element: BrowserPickedElement): string {
  const size = `${Math.round(element.rect.width)}×${Math.round(element.rect.height)}`;
  const text = element.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return text ? `${size} · ${text}` : size;
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * 把批注拼成提示词块。没有批注返回空串，调用方据此跳过拼接。
 * 块内不使用行内代码包裹选择器（选择器里可能含反引号），改用缩进式项目符号。
 */
export function buildAnnotationPrompt(annotations: ElementAnnotation[]): string {
  const list = annotations.filter((item) => item.element);
  if (list.length === 0) return '';
  const withImage = list.filter((item) => item.image).length;
  const head = [
    '### 页面元素批注',
    '',
    `用户在右侧内置浏览器里标注了 ${list.length} 个页面元素，请针对每条批注的诉求修改或回答。` +
      (withImage > 0
        ? `其中 ${withImage} 条附了元素截图，是本条消息最前面的 ${withImage} 张图片，顺序与下面的编号一一对应。`
        : '这些批注没有附带截图，元素信息以文字为准。')
  ];
  const blocks = list.map((item, index) => {
    const el = item.element;
    const lines = [
      '',
      `**批注 ${index + 1}**${item.image ? `（附截图 ${index + 1}）` : ''}`,
      `- 页面：${collapse(el.title) || '(无标题)'} — ${el.url}`,
      `- 元素：<${el.tagName}> 选择器 ${el.selector}`,
      `- 尺寸：${Math.round(el.rect.width)}×${Math.round(el.rect.height)}（位置 ${Math.round(
        el.rect.x
      )},${Math.round(el.rect.y)}）`
    ];
    if (el.text) lines.push(`- 文本：${JSON.stringify(collapse(el.text))}`);
    const styleParts: string[] = [];
    if (el.styles.color) styleParts.push(`color ${el.styles.color}`);
    if (el.styles.background && el.styles.background !== 'rgba(0, 0, 0, 0)') {
      styleParts.push(`background ${el.styles.background}`);
    }
    if (el.styles.fontSize || el.styles.font) {
      styleParts.push(`font ${el.styles.fontSize} ${el.styles.font}`.trim());
    }
    if (styleParts.length > 0) lines.push(`- 样式：${styleParts.join(' · ')}`);
    if (el.html) lines.push(`- HTML：${collapse(el.html).slice(0, MAX_HTML_IN_PROMPT)}`);
    lines.push(`- 用户批注：${item.comment.trim() || '(只标注了元素，没有额外说明)'}`);
    return lines.join('\n');
  });
  return [head.join('\n'), ...blocks].join('\n');
}

/** 批注截图 → 图片附件（保持顺序，供 SDK 追加为 image 内容块） */
export function annotationImages(
  annotations: ElementAnnotation[]
): Array<{ type: 'image'; data: string; mimeType: string }> {
  return annotations
    .filter((item) => item.image && item.image.data.length > 0)
    .map((item) => ({
      type: 'image' as const,
      data: item.image!.data,
      mimeType: item.image!.mimeType || 'image/png'
    }));
}

/** 把文本与批注块拼成最终 prompt（文本为空时只有批注块） */
export function withAnnotationPrompt(text: string, annotations: ElementAnnotation[]): string {
  const block = buildAnnotationPrompt(annotations);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}
