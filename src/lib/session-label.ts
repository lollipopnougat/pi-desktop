/**
 * 会话显示名（侧栏 / 搜索弹窗 / 右键菜单共用）。
 * 优先级：用户命名 → 首条消息（截断）→ 会话 id 前缀 → 路径 basename。
 */
import { t } from '../i18n/zh';

export function sessionLabel(session: {
  name?: string | null;
  firstMessage?: string | null;
  id?: string | null;
  pathBase?: string | null;
}): string {
  return (
    session.name ||
    // 空会话 SDK 给的是字面量 "(no messages)"，别把它当标题显示
    (session.firstMessage && session.firstMessage !== '(no messages)'
      ? session.firstMessage.substring(0, 40)
      : t.sessionUnnamed) ||
    session.id?.substring(0, 8) ||
    session.pathBase ||
    '会话'
  );
}
