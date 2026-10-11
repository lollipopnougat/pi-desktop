/**
 * 文本处理工具函数（统一各组件重复实现）
 */

/** 从 message content 提取纯文本 */
export function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c && c.type === 'text')
    .map((c: any) => c.text)
    .join('');
}

/** 截断字符串，超过 n 加省略号 */
export function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.substring(0, n) + '…' : s;
}

/** 规范化字符串：换行/制表符转空格并 trim */
export function normalize(s: string): string {
  return (s || '').replace(/[\n\t]/g, ' ').trim();
}

/** 缩短 home 路径为 ~ */
export function shortenPath(p: string): string {
  if (!p) return '';
  // renderer 无 process.env.HOME，尝试常见前缀
  return p;
}
