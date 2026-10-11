import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/** 把换行/制表符折叠为单空格，便于单行预览 */
export function normalizeWhitespace(s: string): string {
  return (s || '').replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * 将文本中的 <skill name="xxx" location="...">...</skill> 块替换为蓝色可点击 chip。
 * chip 显示技能名，点击在右侧代码边栏打开对应 SKILL.md。
 * 其余文本原样保留（whitespace-pre-wrap）。
 */
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"\s+location="([^"]+)"\s*>[\s\S]*?<\/skill>/g;

export function renderTextWithSkillChips(
  text: string,
  onOpenSkill: (location: string) => void
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // 重置 lastIndex（全局正则复用）
  SKILL_BLOCK_RE.lastIndex = 0;
  let key = 0;
  while ((m = SKILL_BLOCK_RE.exec(text)) !== null) {
    const start = m.index;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    const name = m[1];
    const location = m[2];
    nodes.push(
      <button
        key={`skill-${key++}`}
        onClick={() => onOpenSkill(location)}
        className="mx-0.5 inline-flex items-center gap-1 rounded bg-od-accent/15 px-1.5 py-0.5 align-baseline text-od-accent transition-colors hover:bg-od-accent/25"
        title={t.skillOpenInPanel(name)}
      >
        <Icon name="cube" className="w-3" />
        <span>{name}</span>
      </button>
    );
    lastIndex = start + m[0].length;
    // 跳过技能块结尾后的首个换行（SDK 展开后 </skill> 与后续 args 之间有一个 \n），
    // 避免 chip 与后续消息文本之间出现多余空行。
    if (text[lastIndex] === '\n') {
      lastIndex += 1;
      // 若紧跟的是换行+空格开头的行，再跳过前导空白（保留其余内容）
      while (lastIndex < text.length && (text[lastIndex] === ' ' || text[lastIndex] === '\t')) {
        lastIndex += 1;
      }
    }
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}
