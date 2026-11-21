/**
 * 「引用批注」的数据层与提示词拼装。
 *
 * 用户选中 agent 回复里的一段文字 → 点悬浮的「添加到对话」→ 输入框上方生成一张
 * 引用卡片，可以补一句自己的说明（想改哪儿、为什么问）。发送时引用原文 + 批注拼成
 * 一个固定块跟在正文后面，模型据此知道「用户指的是我上面哪句话」。
 *
 * 与「页面元素批注」（src/lib/element-annotations.ts）平行的第二类批注：
 * 那个带截图和选择器（浏览器场景），这个只有纯文本（对话场景），所以分开放。
 */

/** 单条引用原文的上限：整段复制几千字既没用又费 token */
export const MAX_QUOTE_CHARS = 4000;

export interface QuoteAnnotation {
  id: string;
  createdAt: number;
  /** 选中的原文片段（已折叠空白、超长截断） */
  quote: string;
  /** 用户补充的说明（可为空） */
  comment: string;
}

let quoteSeq = 0;

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** 从选区文本构造引用批注；空选区/只剩空白返回 null */
export function createQuoteAnnotation(text: string): QuoteAnnotation | null {
  const quote = collapse(text);
  if (!quote) return null;
  quoteSeq += 1;
  const truncated = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  return {
    id: `quote-${Date.now().toString(36)}-${quoteSeq}`,
    createdAt: Date.now(),
    quote: truncated,
    comment: ''
  };
}

/** 卡片上一行摘要（放不下完整引用时截断） */
export function quoteSummary(quote: string): string {
  return quote.length > 160 ? `${quote.slice(0, 160)}…` : quote;
}

/** 把引用批注拼成提示词块；没有批注返回空串 */
export function buildQuotePrompt(annotations: QuoteAnnotation[]): string {
  const list = annotations.filter((item) => item.quote);
  if (list.length === 0) return '';
  const head = [
    '### 对话引用批注',
    '',
    `用户引用了你上面回答里的 ${list.length} 处文字，逐条给出诉求（「> 」开头是引用原文）。`
  ];
  const blocks = list.map((item, index) => {
    const lines = [
      '',
      `**引用 ${index + 1}**`,
      `> ${item.quote}`,
      `- 用户批注：${item.comment.trim() || '(只引用了原文，没有额外说明)'}`
    ];
    return lines.join('\n');
  });
  return [head.join('\n'), ...blocks].join('\n');
}

/** 把正文与引用块拼成最终 prompt */
export function withQuotePrompt(text: string, annotations: QuoteAnnotation[]): string {
  const block = buildQuotePrompt(annotations);
  if (!block) return text;
  return text ? `${text}\n\n${block}` : block;
}
