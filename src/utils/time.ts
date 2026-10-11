/**
 * 时间格式化工具
 */

/** 格式化时间戳为 YYYY-MM-DD HH:mm:ss（24 小时制） */
export function formatTime(ts: any): string {
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
