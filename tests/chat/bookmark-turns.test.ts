import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  groupChatItemsByTurn,
  type ChatMessage
} from '../../src/components/chat/chat-items';

describe('书签对话轮次', () => {
  it('后续回复、思考、工具及错误归属上一条用户消息，下一条用户消息开启新轮次', () => {
    const messages: ChatMessage[] = [
      { role: 'user', timestamp: 1, content: '检查项目' },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'thinking', thinking: '先查看目录' },
          { type: 'text', text: '开始检查' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'package.json' } }
        ]
      },
      { role: 'toolResult', timestamp: 3, content: '读取完成' },
      { role: 'user', timestamp: 4, content: '<!-- goal-continuation: goal-1 -->' },
      { role: 'assistant', timestamp: 5, content: '继续核对' },
      { role: 'assistant', timestamp: 6, stopReason: 'error', errorMessage: '检查失败' },
      { role: 'user', timestamp: 7, content: '重新检查' },
      { role: 'assistant', timestamp: 8, content: '重新执行中' }
    ];
    const items = buildChatItems(messages, null);
    const turns = groupChatItemsByTurn(items);

    expect(turns.map((turn) => turn.userTimestamp)).toEqual([1, 7]);
    expect(turns[0].items.map((item) => item.type)).toEqual([
      'user',
      'assistant',
      'assistant',
      'toolGroup',
      'assistant',
      'assistant'
    ]);
    expect(turns[1].items.map((item) => item.type)).toEqual(['user', 'assistant']);
    expect(turns.flatMap((turn) => turn.items)).toEqual(items);
  });

  it('流式追加和转历史保留轮次及工具组标识，新增用户消息不会接管上一轮内容', () => {
    const history: ChatMessage[] = [{ role: 'user', timestamp: 1, content: '查看文件' }];
    const live: ChatMessage = {
      role: 'assistant',
      timestamp: 2,
      content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.ts' } }]
    };
    const waiting = groupChatItemsByTurn(buildChatItems(history, null));
    const streaming = groupChatItemsByTurn(buildChatItems(history, live));
    const committed = groupChatItemsByTurn(buildChatItems([...history, live], null));
    const next = groupChatItemsByTurn(
      buildChatItems([...history, live, { role: 'user', timestamp: 3, content: '继续' }], null)
    );

    expect(streaming[0].key).toBe(waiting[0].key);
    expect(committed[0].key).toBe(streaming[0].key);
    expect(committed[0].items.map((item) => item.key)).toEqual(
      streaming[0].items.map((item) => item.key)
    );
    expect(next[0]).toEqual(committed[0]);
    expect(next[1].userTimestamp).toBe(3);
    expect(next[1].items).toHaveLength(1);
  });

  it('首条用户消息前的模型内容正常保留，不归属后面的书签；空会话不制造轮次', () => {
    const turns = groupChatItemsByTurn(
      buildChatItems(
        [
          { role: 'assistant', timestamp: 1, content: '先前会话内容' },
          { role: 'user', timestamp: 2, content: '继续' },
          { role: 'user', timestamp: 3, content: '补充说明' }
        ],
        null
      )
    );

    expect(turns.map((turn) => turn.userTimestamp)).toEqual([undefined, 2, 3]);
    expect(turns[0].items[0]).toMatchObject({ message: { content: [{ text: '先前会话内容' }] } });
    expect(turns[1].items).toHaveLength(1);
    expect(groupChatItemsByTurn(buildChatItems([], null))).toEqual([]);
  });
});
