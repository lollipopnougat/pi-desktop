/**
 * unified patch 的通用解析工具。
 *
 * 三种用途：
 * - `countPatchChanges`：统计 +/- 行数（聊天「本次改动」卡片的 +A/−D）
 * - `reconstructFromPatch`：只有 patch、没有文件内容时，从 hunk 还原改动区域两侧的片段
 *   （历史会话的 diff tab 走这条；patch 自带 context 行，不需要读磁盘）
 * - `revertPatch`：把 patch 反向应用回内容 —— 一轮里同一文件被改多次时，
 *   从当前文件内容倒序回退，才能得到「这一轮开始时」的完整内容
 */
import { applyPatch, parsePatch, type ParsedDiff } from 'diff';

/** patch 里的行前缀：'+' 新增、'-' 删除、' ' 上下文、'\' 表示「文件末尾没有换行」 */
const ADDED = '+';
const REMOVED = '-';
const CONTEXT = ' ';

/** 统计 patch 的新增/删除行数（跳过 `+++`/`---` 文件头行） */
export function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith(ADDED)) additions += 1;
    else if (line.startsWith(REMOVED)) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * 从 unified patch 的 hunk 重建 original/modified 片段。
 * 上下文行（空格前缀）进两侧；删除行（-）只进 original；新增行（+）只进 modified。
 * 返回的是改动区域附近的片段（含 context 行），非完整文件。
 */
export function reconstructFromPatch(patch: string): { original: string; modified: string } {
  const parsed = parsePatch(patch);
  if (parsed.length === 0) return { original: '', modified: '' };
  const origLines: string[] = [];
  const modLines: string[] = [];
  for (const file of parsed) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const prefix = line[0];
        const content = line.slice(1);
        if (prefix === CONTEXT) {
          origLines.push(content);
          modLines.push(content);
        } else if (prefix === REMOVED) {
          origLines.push(content);
        } else if (prefix === ADDED) {
          modLines.push(content);
        }
      }
    }
  }
  return { original: origLines.join('\n'), modified: modLines.join('\n') };
}

/** 行号与 +/- 前缀互换后的 patch（用于回退）；`\` 行原样保留 */
function reverseParsedPatch(parsed: ParsedDiff[]): ParsedDiff[] {
  return parsed.map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      oldLines: hunk.newLines,
      newStart: hunk.oldStart,
      newLines: hunk.oldLines,
      lines: hunk.lines.map((line) => {
        if (line.startsWith(ADDED)) return REMOVED + line.slice(1);
        if (line.startsWith(REMOVED)) return ADDED + line.slice(1);
        return line;
      })
    }))
  }));
}

/**
 * 把 patch 反向应用回 `content`，返回应用前的内容；任何不匹配（文件在这一轮之后
 * 又被改过、patch 损坏等）都返回 null，调用方自行退回片段渲染。
 */
export function revertPatch(content: string, patch: string): string | null {
  try {
    const parsed = parsePatch(patch);
    if (parsed.length === 0) return null;
    const reversed = reverseParsedPatch(parsed);
    // @types 只声明了 [ParsedDiff]，运行时 applyPatch 支持任意长度的数组
    const result = applyPatch(content, reversed as unknown as [ParsedDiff]);
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}
