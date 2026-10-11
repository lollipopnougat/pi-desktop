/**
 * 格式化工具（token 数、费用等）
 */

/** 格式化 token 数：>=1000 用 k 单位 */
export function formatTokens(n: number): string {
  if (!n || n < 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
