import type { IconName } from '../../common/icons';
import { t } from '../../../i18n/zh';

const toolIcons: Record<string, IconName> = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  bash: 'bash',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
  task: 'agents'
};
export const toolIcon = (name: string): IconName => toolIcons[name] ?? 'tool';

export function toolActivityLabel(name: string): string {
  if (name === 'read' || name === 'ls') return t.toolActivityRead;
  if (name === 'write' || name === 'edit') return t.toolActivityWrite;
  if (name === 'bash') return t.toolActivityRun;
  if (name === 'grep' || name === 'find') return t.toolActivitySearch;
  return t.toolActivityOther;
}

export function getToolLabel(name: string, args: Record<string, unknown>): string {
  if (name === 'task' && Array.isArray(args.tasks)) return t.toolSubtasks(args.tasks.length);
  const value =
    name === 'bash'
      ? args.command
      : name === 'grep' || name === 'find'
        ? (args.pattern ?? args.path)
        : (args.path ?? args.file ?? args.query ?? args.description ?? args.agent);
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
}

/** 不截断文本输出；结构化和非文本结果保留其信息，图片由详情组件展示。 */
export function formatToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
    return result.content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'text' && 'text' in block) return String(block.text ?? '');
          if (block.type === 'image') return '';
        }
        return JSON.stringify(block, null, 2);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(result, null, 2) ?? '';
}
