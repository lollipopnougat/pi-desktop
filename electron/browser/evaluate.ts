/**
 * 任意 JS 执行：脚本包装与结果规范化（纯函数，便于单测；执行本身在 controller 里）。
 *
 * 为什么要把用户代码包一层：
 * - 页面代码的返回值必须能被 Electron 结构化克隆回主进程，函数/DOM 节点/Symbol 之类
 *   会直接抛 “An object could not be cloned”。这里在页面内先做一次安全序列化，
 *   把不可克隆的值降级成字符串或 JSON。
 * - 顺带解决两种写法：表达式（`document.title`）与语句体（`const a = 1; return a;`）。
 *   先按表达式解析，失败再按函数体解析。
 */

/** 单次执行允许的代码长度上限（防止把主进程/页面内存打爆） */
export const MAX_EVALUATE_CODE_CHARS = 200_000;
/** 返回给 Agent 的结果字符上限 */
export const MAX_EVALUATE_OUTPUT_CHARS = 20_000;
export const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;
export const MAX_EVALUATE_TIMEOUT_MS = 30_000;

export type EvaluateMode = 'expression' | 'body';

/**
 * 页面内的安全序列化助手。注意：
 * - 必须在页面主世界执行，且不能污染全局（包在 IIFE 里）
 * - Map/Set/Error/DOM 节点单独处理，否则 JSON.stringify 会丢信息或得到 '{}'
 */
const SAFE_HELPER = [
  '  const __piSafe = (v) => {',
  "    if (v === undefined) return { kind: 'undefined' };",
  "    if (v === null) return { kind: 'json', value: null };",
  '    const type = typeof v;',
  "    if (type === 'string' || type === 'number' || type === 'boolean') return { kind: 'json', value: v };",
  "    if (type === 'function') return { kind: 'string', value: String(v).slice(0, 500) };",
  "    if (type === 'symbol' || type === 'bigint') return { kind: 'string', value: String(v) };",
  "    if (v instanceof Error) return { kind: 'string', value: String(v.stack || v).slice(0, 2000) };",
  "    if (v instanceof Map) return { kind: 'json', value: Array.from(v.entries()) };",
  "    if (v instanceof Set) return { kind: 'json', value: Array.from(v.values()) };",
  "    if (typeof v.nodeType === 'number') return { kind: 'string', value: v.nodeType === 1 ? String(v.outerHTML || '').slice(0, 2000) : '<#document>' };",
  "    try { return { kind: 'json', value: JSON.parse(JSON.stringify(v)) }; }",
  "    catch (error) { return { kind: 'string', value: String(v) }; }",
  '  };'
].join('\n');

/** 表达式模式：`document.title`、`await fetch(...)`、`({a: 1})` */
export function buildExpressionScript(code: string): string {
  return `(async () => {\n${SAFE_HELPER}\n  const __piValue = await (\n${code}\n);\n  return __piSafe(__piValue);\n})()`;
}

/** 语句体模式：`const a = 1; return a * 2;`（支持 return 与 await） */
export function buildBodyScript(code: string): string {
  return `(async () => {\n${SAFE_HELPER}\n  const __piValue = await (async () => {\n${code}\n  })();\n  return __piSafe(__piValue);\n})()`;
}

export function buildEvaluateScript(code: string, mode: EvaluateMode): string {
  return mode === 'expression' ? buildExpressionScript(code) : buildBodyScript(code);
}

/**
 * 判断代码该按表达式还是函数体包装。
 * 用 `new Function` 只做解析、绝不执行：探测环境与实际表达式模板保持一致（外面再包一层
 * async 箭头函数，所以顶层的 `await` 合法）。这样就不会出现「先执行一次猜错了再执行第二次」
 * 带来的副作用翻倍问题。
 */
export function detectEvaluateMode(code: string): EvaluateMode {
  try {
    new Function(`return (async () => (\n${code}\n));`);
    return 'expression';
  } catch {
    return 'body';
  }
}

export function clampEvaluateTimeout(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EVALUATE_TIMEOUT_MS;
  }
  return Math.min(MAX_EVALUATE_TIMEOUT_MS, Math.max(100, Math.round(value)));
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（已截断，完整长度 ${text.length} 字符）`;
}

/**
 * 把页面返回的 `{ kind, value }` 包成可读文本。
 * raw 不是预期结构时（例如页面被导航打断），退化为 JSON 字符串。
 */
export function formatEvaluateResult(raw: unknown, maxChars = MAX_EVALUATE_OUTPUT_CHARS): string {
  if (raw === undefined || raw === null) return 'undefined';
  if (typeof raw === 'object') {
    const envelope = raw as { kind?: string; value?: unknown };
    if (envelope.kind === 'undefined') return 'undefined';
    if (envelope.kind === 'string') return truncateOutput(String(envelope.value ?? ''), maxChars);
    if (envelope.kind === 'json') {
      const value = envelope.value;
      if (value === undefined) return 'undefined';
      const text =
        typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'undefined');
      return truncateOutput(text, maxChars);
    }
  }
  if (typeof raw === 'string') return truncateOutput(raw, maxChars);
  return truncateOutput(JSON.stringify(raw, null, 2) ?? String(raw), maxChars);
}
