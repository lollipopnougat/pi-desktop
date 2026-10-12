/**
 * 把 Markdown 正文按「安全块边界」切成若干片段，供流式渲染分块解析 + 块级缓存。
 *
 * 只切确定属于块边界的位置，规则保守：
 * - 紧跟在空白行之后的行；
 * - 该行顶格（无缩进），且不是列表标记（`-`/`*`/`+`/`1.`/`1)`）、不是引用（`>`）、
 *   不是表格行（`|`）、不是分隔线（`---` 等）——这些都可能跨空白行续接上一个块；
 * - 不在围栏代码块内部（``` / ~~~，行首 0~3 空格）。
 *
 * 这样「松列表」「引用块续段」不会被错误截断，分块解析结果与整篇解析一致；
 * 调用方另需对参考式链接定义（文档级作用域）退化为整篇解析。
 */
export function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let sawBlank = false;

  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    // 切点判定必须用「本行之前」的围栏状态：开围栏那一行本身是合法切点，围栏内部不是
    const atBlockBoundary =
      !inFence &&
      sawBlank &&
      line.trim() !== '' &&
      /^\S/.test(line) &&
      !/^([-*+]|\d+[.)])\s/.test(line) &&
      !/^[>|]/.test(line) &&
      !/^(---+|\*\*\*+|___+)\s*$/.test(line);
    if (atBlockBoundary) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
    }
    sawBlank = !inFence && line.trim() === '';
  }
  blocks.push(current.join('\n'));

  // 去首尾换行而不是 trim()：行首缩进（缩进代码块）与行尾空格（breaks 的硬换行）都有语义
  return blocks
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block.trim() !== '');
}
