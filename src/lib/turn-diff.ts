/**
 * 「本次改动」的完整前后内容还原。
 *
 * 一轮里同一文件可能被 edit 多次，每个 patch 都基于各自时刻的文件内容生成，
 * 因此不能拼接。这里从当前文件内容出发，按时间倒序把 patch 逐个反应用回去，
 * 得到这一轮开始时（或上一个改动点）的完整内容 —— 两侧都是整份文件，
 * Monaco DiffEditor 才能像 IDE 一样展示未受影响的区域。
 *
 * 任一 patch 反应用失败（文件在这轮之后又被改过 / 内容被外部工具重写）
 * 返回 null，调用方退回 patch 片段渲染（`reconstructFromPatch`）。
 */
import type { TurnFileChange } from '../types/shared';
import { revertPatch } from './patch-utils';

export interface ResolvedFileDiff {
  original: string;
  modified: string;
}

/**
 * 还原一个文件的「本轮改动前后」完整内容。
 * @param readFile 读取当前文件内容（渲染进程传 `window.pi.readFile`，测试可注入替身）
 */
export async function resolveTurnFileDiff(
  change: TurnFileChange,
  readFile: (path: string) => Promise<string>
): Promise<ResolvedFileDiff | null> {
  let current: string;
  try {
    current = await readFile(change.path);
  } catch {
    return null;
  }
  // write 是整文件写入：工具没留下改动前内容，只能按「整份文件新增」展示
  if (change.kind === 'write') return { original: '', modified: current };

  let before = current;
  for (let index = change.patches.length - 1; index >= 0; index -= 1) {
    const reverted = revertPatch(before, change.patches[index]);
    if (reverted == null) return null;
    before = reverted;
  }
  return { original: before, modified: current };
}
