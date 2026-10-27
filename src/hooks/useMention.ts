/**
 * Mention 自动补全 hook：在 ChatInput 的 textarea 中检测 @ / $ / / 触发词，
 * 拉取对应候选项（文件 / skill / 命令），提供键盘导航与插入。
 *
 * 从 ChatInput 抽出，降低主组件耦合。textareaRef 由父组件传入用于读取光标位置。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { usePiStore } from '../store/pi-store';
import { t } from '../i18n/zh';
import { buildFileMentionItems, splitMentionPath } from '../lib/mention-paths';
import type { MentionItem } from '../types/shared';

export type MentionType = 'file' | 'skill' | 'command';

export interface UseMentionApi {
  mentionActive: boolean;
  mentionItems: MentionItem[];
  mentionIndex: number;
  mentionType: MentionType | null;
  listRef: React.RefObject<HTMLDivElement>;
  /** textarea onChange 时调：检测光标前是否命中触发词 */
  detect: (text: string, cursorPos: number) => void;
  /** textarea onKeyDown 时调：返回 true 表示已消费该按键（父组件应 return） */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 插入选中项到 textarea（需父组件传入 setText 与读取光标的 ref） */
  insert: (item: MentionItem) => void;
  /** 关闭（外部点击/Esc 由 onKeyDown 处理） */
  close: () => void;
}

export function useMention(
  text: string,
  setText: (v: string) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement>
): UseMentionApi {
  const commands = usePiStore((s) => s.commands);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionType, setMentionType] = useState<MentionType | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // 候选项加载（file 类型按路径逐层列目录：@ → @src/ → @src/components/ …）
  const reqSeq = useRef(0);
  useEffect(() => {
    if (!mentionActive || !mentionType) return;
    const reqId = ++reqSeq.current;
    const loadItems = async () => {
      try {
        if (mentionType === 'file') {
          const { dir, partial } = splitMentionPath(mentionQuery);
          const entries = await window.pi.listFiles(dir || undefined);
          // 快速输入 / 连续下钻时只认最后一次请求，避免旧结果盖新结果
          if (reqId !== reqSeq.current) return;
          setMentionItems(buildFileMentionItems(entries, partial));
        } else if (mentionType === 'skill' || mentionType === 'command') {
          const builtinCommands = [
            { name: 'mcp', description: t.tabMcp + '：查看 MCP 服务器状态', source: 'builtin' }
          ];
          const filtered =
            mentionType === 'skill'
              ? commands.filter((c) => c.source === 'skill')
              : [...builtinCommands, ...commands];
          const q = mentionQuery || '';
          const matched = q ? filtered.filter((c) => c.name.includes(q)) : filtered;
          const sorted = [...matched].sort((a, b) => {
            const aExact = a.name === q ? 0 : 1;
            const bExact = b.name === q ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;
            return 0;
          });
          const items = sorted.slice(0, 20).map((c: any) => ({
            label: c.name,
            detail: c.description,
            value: c.name
          }));
          if (reqId !== reqSeq.current) return;
          setMentionItems(items);
        }
      } catch {
        if (reqId === reqSeq.current) setMentionItems([]);
      }
    };
    loadItems();
  }, [mentionActive, mentionType, mentionQuery, commands]);

  // 候选变少时直接用钳制后的下标（不在 effect 里 setState，避免多余重渲染）
  const activeIndex = mentionItems.length === 0 ? 0 : Math.min(mentionIndex, mentionItems.length - 1);

  // 选中项滚动到可见区
  useEffect(() => {
    if (!mentionActive) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, mentionActive]);

  const close = useCallback(() => {
    setMentionActive(false);
    setMentionType(null);
    setMentionQuery('');
  }, []);

  const detect = useCallback((newText: string, cursorPos: number) => {
    const beforeCursor = newText.substring(0, cursorPos);
    const mentionMatch = beforeCursor.match(/(?:^|\s)([@$/])([\w\-/.]*)$/);
    if (mentionMatch) {
      const trigger = mentionMatch[1];
      const query = mentionMatch[2];
      const start = cursorPos - query.length - 1;
      setMentionActive(true);
      setMentionStart(start);
      setMentionQuery(query);
      if (trigger === '@') setMentionType('file');
      else if (trigger === '$') setMentionType('skill');
      else if (trigger === '/') setMentionType('command');
      setMentionIndex(0);
    } else {
      setMentionActive(false);
      setMentionType(null);
    }
  }, []);

  const insert = useCallback(
    (item: MentionItem) => {
      const before = text.substring(0, mentionStart);
      const after = text.substring(textareaRef.current?.selectionStart || text.length);
      let prefix = '';
      if (mentionType === 'file') prefix = '@';
      else if (mentionType === 'skill') prefix = '$';
      else if (mentionType === 'command') prefix = '/';

      // 目录：只把 token 补全成 `@dir/`，下拉保持打开继续列该目录的子项（不关闭、不插入空格）
      if (item.isDirectory) {
        const token = `${item.value}/`;
        setText(`${before}${prefix}${token}${after}`);
        setMentionType('file');
        setMentionQuery(token);
        setMentionIndex(0);
        setMentionActive(true);
        setMentionStart(mentionStart);
        setTimeout(() => {
          const ta = textareaRef.current;
          if (ta) {
            const pos = before.length + prefix.length + token.length;
            ta.focus();
            ta.setSelectionRange(pos, pos);
          }
        }, 0);
        return;
      }

      // 文件（或 skill / 命令）：插入并关闭下拉
      const newText = `${before}${prefix}${item.value} ${after}`;
      setText(newText);
      close();
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = before.length + prefix.length + item.value.length + 1;
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      }, 0);
    },
    [text, mentionStart, mentionType, setText, close, textareaRef]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mentionActive || mentionItems.length === 0) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return true;
      }
      if (e.key === 'Escape') {
        close();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems[activeIndex];
        if (item) insert(item);
        return true;
      }
      return false;
    },
    [mentionActive, mentionItems, activeIndex, insert, close]
  );

  return {
    mentionActive,
    mentionItems,
    mentionIndex: activeIndex,
    mentionType,
    listRef,
    detect,
    onKeyDown,
    insert,
    close
  };
}
