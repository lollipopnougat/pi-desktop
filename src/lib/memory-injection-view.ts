/**
 * 记忆注入明细的展示层转换（纯函数，便于单测）。
 *
 * 注入串本身是给模型看的分段 XML（`<user-profile>…</user-profile>`、`<memory-topics>…`），
 * 面板展开时只应展示正文：外层包裹标签对用户没有信息量，还会让人误以为要自己写标记。
 */

const OPEN_TAG = /^<([\w-]+)>$/;
const CLOSE_TAG = /^<\/([\w-]+)>$/;

/**
 * 去掉注入分段最外层的包裹标签行（只处理独立成行的首尾标签，正文里的普通尖括号不动）。
 * 例：`<user-profile>\n- 回答用中文\n</user-profile>` → `- 回答用中文`
 */
export function stripInjectionWrapper(content: string): string {
  const lines = content.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first >= 0 && OPEN_TAG.test(lines[first].trim())) {
    lines.splice(first, 1);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    if (CLOSE_TAG.test(lines[i].trim())) lines.splice(i, 1);
    break;
  }
  return lines.join('\n').trim();
}

/** 分段 id → 中文展示名（缺省回退注入模板里的原始 label） */
export function injectionSectionTitle(
  id: string,
  labels: {
    standing: string;
    profile: string;
    topics: string;
    policy: string;
  },
  fallback: string
): string {
  switch (id) {
    case 'standing':
      return labels.standing;
    case 'user-profile':
      return labels.profile;
    case 'topics':
      return labels.topics;
    case 'policy':
      return labels.policy;
    default:
      return fallback;
  }
}
