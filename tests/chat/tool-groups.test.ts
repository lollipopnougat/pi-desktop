import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildChatItems,
  type ChatMessage,
  type ChatRenderItem,
  type ToolCallBlock
} from '../../src/components/chat/chat-items';
import { formatToolResult } from '../../src/components/chat/tool-calls/tool-presentation';
import { loadUiSettings, normalizeUiSettings, usePiStore } from '../../src/store/pi-store';

const tool = (id: string, name = 'bash'): ToolCallBlock => ({
  type: 'toolCall',
  id,
  name,
  arguments: { command: `echo ${id}` }
});
const thought = (text: string) => ({ type: 'thinking', thinking: text });
const text = (value: string) => ({ type: 'text', text: value });
const assistant = (
  content: Exclude<ChatMessage['content'], string | undefined>,
  timestamp = 1
): ChatMessage => ({ role: 'assistant', timestamp, content });
const groups = (items: ChatRenderItem[]) => items.filter((item) => item.type === 'toolGroup');
const toolIds = (items: ChatRenderItem[]) =>
  groups(items).flatMap((group) =>
    group.activities.flatMap((item) => (item.type === 'tool' ? [item.toolCall.id] : []))
  );

describe('工具活动分组', () => {
  it('思考和工具结果穿插时仍合并，并保留单消息中的所有工具', () => {
    const items = buildChatItems(
      [
        assistant([thought('先检查'), tool('a'), tool('b', 'read')]),
        { role: 'toolResult', content: [text('ok')] },
        assistant([thought('继续'), tool('c', 'edit')])
      ],
      null
    );
    expect(items).toHaveLength(1);
    expect(toolIds(items)).toEqual(['a', 'b', 'c']);
    expect(groups(items)[0].activities.map((item) => item.type)).toEqual([
      'thinking',
      'tool',
      'tool',
      'thinking',
      'tool'
    ]);
  });

  it('同一条消息里的正文会分隔工具组，不改变正文顺序或复制原文', () => {
    const items = buildChatItems(
      [assistant([text('开始'), tool('a'), text('进展'), tool('b'), text('完成')])],
      null
    );
    expect(items.map((item) => item.type)).toEqual([
      'assistant',
      'toolGroup',
      'assistant',
      'toolGroup',
      'assistant'
    ]);
    const texts = items.filter((item) => item.type === 'assistant');
    expect(texts.map((item) => item.message.content)).toEqual([
      [text('开始')],
      [text('进展')],
      [text('完成')]
    ]);
    expect(texts.filter((item) => item.showActions)).toHaveLength(1);
    expect(texts.at(-1)?.copyText).toBe('开始\n\n进展\n\n完成');
  });

  it('流式工具接入上一组，落盘和追加工具后保持相同 key', () => {
    const history = [assistant([tool('a')])];
    const live = assistant([thought('继续读取'), tool('b'), tool('c')], 2);
    const streaming = buildChatItems(history, live);
    const committed = buildChatItems([...history, live], null);
    const more = buildChatItems([...history, live], assistant([tool('d')], 3));
    expect(groups(streaming)[0].key).toBe(groups(committed)[0].key);
    expect(groups(more)[0].key).toBe(groups(streaming)[0].key);
    expect(toolIds(more)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('用户消息与错误信息留在组外，并打断工具组', () => {
    const items = buildChatItems(
      [
        assistant([tool('a')]),
        { role: 'user', content: '重试', timestamp: 2 },
        assistant([tool('b')], 3),
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '连接失败',
          content: [],
          timestamp: 4
        },
        assistant([tool('c')], 5)
      ],
      null
    );
    expect(items.map((item) => item.type)).toEqual([
      'toolGroup',
      'user',
      'toolGroup',
      'assistant',
      'toolGroup'
    ]);
    expect(items[3]).toMatchObject({ message: { errorMessage: '连接失败' } });
  });

  it('隐藏续跑标记、空文本和工具结果不制造空白分组', () => {
    const items = buildChatItems(
      [
        assistant([tool('a'), text('  ')]),
        { role: 'user', content: '<!-- goal-continuation: goal-1 -->' },
        { role: 'toolResult', content: [] },
        assistant([tool('b')])
      ],
      null
    );
    expect(items).toHaveLength(1);
    expect(toolIds(items)).toEqual(['a', 'b']);
  });

  it('独立思考仍能显示，只有当前流式尾块显示预览', () => {
    const items = buildChatItems(
      [assistant([thought('已完成'), text('正文')])],
      assistant([thought('思考中')], 2)
    );
    expect(groups(items)).toHaveLength(0);
    expect(items[0]).toMatchObject({ isStreaming: false, showActions: false });
    expect(items.at(-1)).toMatchObject({
      isStreaming: true,
      message: { content: [thought('思考中')] }
    });
  });

  it('同毫秒不同工具保留，流式和历史重叠的工具不重复', () => {
    const items = buildChatItems(
      [assistant([tool('a')]), assistant([tool('b')])],
      assistant([tool('b'), tool('c')])
    );
    expect(toolIds(items)).toEqual(['a', 'b', 'c']);
  });

  it('大量工具压缩为一个渲染项并保留末尾工具', () => {
    const history = Array.from({ length: 200 }, (_, i) =>
      assistant([thought(`step ${i}`), tool(`id-${i}`)], i)
    );
    const items = buildChatItems(history, null);
    expect(items).toHaveLength(1);
    expect(toolIds(items)).toHaveLength(200);
    expect(toolIds(items).at(-1)).toBe('id-199');
  });
});

describe('工具输出', () => {
  it('长输出保留尾部，多段文本按顺序展示', () => {
    const output = 'x'.repeat(25000) + 'tail-marker';
    expect(formatToolResult({ content: [text(output), text('第二段')] })).toBe(output + '\n第二段');
  });
  it('保留结构化结果、空值和失败信息，不丢失 falsy 输出', () => {
    expect(formatToolResult('')).toBe('');
    expect(formatToolResult(false)).toBe('false');
    expect(formatToolResult(0)).toBe('0');
    expect(formatToolResult({ error: 'failed' })).toContain('failed');
    expect(formatToolResult({ content: [] })).toBe('');
  });
});

describe('工具折叠偏好持久化', () => {
  const original = usePiStore.getState();
  afterEach(() => {
    usePiStore.setState(original);
    vi.unstubAllGlobals();
  });

  it('默认开启，归一化保留 false 并拒绝错误类型', () => {
    expect(usePiStore.getInitialState().collapseToolCalls).toBe(true);
    expect(normalizeUiSettings({ collapseToolCalls: false })).toEqual({ collapseToolCalls: false });
    expect(normalizeUiSettings({ collapseToolCalls: true })).toEqual({ collapseToolCalls: true });
    expect(normalizeUiSettings({ collapseToolCalls: 'false' } as never)).toEqual({});
  });

  it('经 UI settings IPC 保存和恢复关闭值，会话 reset 不重置偏好', async () => {
    let disk = { collapseToolCalls: true };
    const setUiSettings = vi.fn(async (patch: Partial<typeof disk>) => {
      disk = { ...disk, ...patch };
    });
    vi.stubGlobal('window', { pi: { setUiSettings, getUiSettings: async () => disk } });
    usePiStore.getState().setCollapseToolCalls(false);
    expect(setUiSettings).toHaveBeenCalledWith({ collapseToolCalls: false });
    usePiStore.getState().reset();
    expect(usePiStore.getState().collapseToolCalls).toBe(false);
    usePiStore.setState({ collapseToolCalls: true });
    await loadUiSettings();
    expect(usePiStore.getState().collapseToolCalls).toBe(false);
  });
});
