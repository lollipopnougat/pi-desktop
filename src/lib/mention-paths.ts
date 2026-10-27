/**
 * @ 提及（mention）的路径解析与候选构建（纯函数，便于单测）。
 *
 * 输入框里 `@` 之后是「项目内相对路径 + 可选的前缀」，例如：
 * - `@`            → 列项目根目录
 * - `@src`         → 列项目根目录下以 src 开头的条目
 * - `@src/`        → 列 src 目录的子项（选中目录后就是这种形态）
 * - `@src/co`      → 列 src 目录下以 co 开头的条目
 */
import type { MentionItem } from '../types/shared';

export interface MentionEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * 候选里默认隐藏的目录：依赖 / 版本库 / 构建产物。
 * 这些目录进 @ 提及基本没有意义，而且一层就能把真正的源码顶没。
 * 只挡目录，同名文件（如 `dist` 二进制）照常出现。
 */
const HIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'target',
  'vendor'
]);

/** 把 `@` 之后的输入拆成「要列出的目录」+「该目录下要匹配的前缀」 */
export function splitMentionPath(query: string): { dir: string; partial: string } {
  const slash = query.lastIndexOf('/');
  if (slash < 0) return { dir: '', partial: query };
  return { dir: query.slice(0, slash), partial: query.slice(slash + 1) };
}

/** 目录条目在候选列表里怎么显示（补一个尾斜杠，和文件区分开） */
export function mentionItemLabel(entry: MentionEntry): string {
  return entry.isDirectory ? `${entry.name}/` : entry.name;
}

/**
 * 由某个目录的条目构建候选：目录优先（可继续下钻），再按名称排序。
 * `partial` 为按名称前缀过滤的条件（空则不过滤）。
 */
export function buildFileMentionItems(
  entries: MentionEntry[],
  partial: string,
  limit = 30
): MentionItem[] {
  const q = partial.toLowerCase();
  return entries
    .filter((e) => !(e.isDirectory && HIDDEN_DIRS.has(e.name)))
    .filter((e) => !q || e.name.toLowerCase().startsWith(q))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((e) => ({
      label: mentionItemLabel(e),
      detail: e.path,
      value: e.path,
      isDirectory: e.isDirectory
    }));
}
