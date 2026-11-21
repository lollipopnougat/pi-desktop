/**
 * 评审上下文构造单测（`electron/permission/reviewer/context.ts`）。
 *
 * 预算与截断是这层的核心不变量：
 * - 输入预算必须硬上限（否则一条 20 万字符的 toolResult 就能把评审请求顶爆）
 * - 截断必须留 `<truncated/>` 标记（提示词明确要求「看到标记就更保守」）
 * - 最近一条用户消息永远保留（授权依据丢了，评审员只会看到一堆助手输出）
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  MAX_OTHER_MESSAGES,
  MAX_TRANSCRIPT_CHARS,
  buildReviewRequest,
  clipWithMarker,
  describeAction,
  summarizeTranscript,
  toTranscriptEntries
} from '../../electron/permission/reviewer/context';

describe('clipWithMarker', () => {
  it('未超限原样返回', () => {
    expect(clipWithMarker('hello', 10)).toBe('hello');
  });

  it('超限保留头尾并带标记', () => {
    const text = 'A'.repeat(100) + 'B'.repeat(100);
    const out = clipWithMarker(text, 100);
    expect(out).toContain('<truncated/>');
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('B')).toBe(true);
    expect(out.length).toBeLessThan(text.length);
  });
});

describe('toTranscriptEntries', () => {
  it('字符串 content 直接照搬，user 标为可信', () => {
    const entries = toTranscriptEntries([{ role: 'user', content: '删掉 dist' }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toContain('可信');
    expect(entries[0].text).toBe('删掉 dist');
  });

  it('只取 text 块，thinking 丢弃；toolCall 记工具名与参数', () => {
    const entries = toTranscriptEntries([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内心戏' },
          { type: 'text', text: '我要跑一下' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'rm -rf dist' } }
        ]
      }
    ]);
    expect(entries[0].text).toContain('我要跑一下');
    expect(entries[0].text).toContain('[调用工具 bash]');
    expect(entries[0].text).toContain('rm -rf dist');
    expect(entries[0].text).not.toContain('内心戏');
    expect(entries[0].label).toContain('不可信');
  });

  it('toolResult 带工具名与失败标记', () => {
    const entries = toTranscriptEntries([
      { role: 'toolResult', toolName: 'bash', isError: true, content: 'boom' }
    ]);
    expect(entries[0].label).toContain('工具 bash 失败');
    expect(entries[0].text).toBe('boom');
  });

  it('未知角色与空内容被丢弃', () => {
    expect(
      toTranscriptEntries([
        { role: 'system', content: 'x' },
        { role: 'user', content: '   ' },
        null,
        { role: 'user', content: [{ type: 'image' }] }
      ])
    ).toHaveLength(0);
  });

  it('单条消息超过 MAX_MESSAGE_CHARS 时截断', () => {
    const entries = toTranscriptEntries([{ role: 'assistant', content: 'y'.repeat(10000) }]);
    expect(entries[0].text).toContain('<truncated/>');
    expect(entries[0].text.length).toBeLessThan(MAX_MESSAGE_CHARS + 100);
  });
});

describe('summarizeTranscript', () => {
  it('空会话给出明确占位（不能留空让评审员自己猜）', () => {
    expect(summarizeTranscript([])).toContain('还没有任何对话内容');
  });

  it('user 消息全部保留，其它只留最近 N 条', () => {
    const messages: unknown[] = [{ role: 'user', content: '最早的请求' }];
    for (let i = 0; i < MAX_OTHER_MESSAGES + 10; i += 1) {
      messages.push({ role: 'assistant', content: `第 ${i} 条` });
    }
    const text = summarizeTranscript(messages);
    expect(text).toContain('最早的请求');
    expect(text).toContain(`第 ${MAX_OTHER_MESSAGES + 9} 条`);
    expect(text).toContain('<truncated/>');
  });

  it('超出字符预算时丢更早的条目并提示应更保守', () => {
    const big = (label: string) => ({ role: 'assistant', content: `${label}${'z'.repeat(3900)}` });
    const messages: unknown[] = [
      { role: 'user', content: '清一下构建目录' },
      big('a'),
      big('b'),
      big('c'),
      big('d'),
      big('e'),
      big('f')
    ];
    const text = summarizeTranscript(messages);
    expect(text.length).toBeLessThan(MAX_TRANSCRIPT_CHARS * 1.3);
    expect(text).toContain('更早的');
    expect(text).toContain('更保守');
  });

  it('最近一条 user 消息即使超出预算也保留', () => {
    const messages: unknown[] = [{ role: 'user', content: `U${'u'.repeat(3900)}` }];
    for (let i = 0; i < 6; i += 1) {
      messages.push({ role: 'assistant', content: `A${i}${'a'.repeat(3900)}` });
    }
    const text = summarizeTranscript(messages);
    expect(text).toContain('[用户 · 可信]');
  });
});

describe('describeAction', () => {
  it('包含工具、cwd 与参数', () => {
    const text = describeAction({
      toolName: 'write',
      input: { path: 'src/a.ts', content: 'x' },
      cwd: '/tmp/proj'
    });
    expect(text).toContain('工具：write');
    expect(text).toContain('工作目录：/tmp/proj');
    expect(text).toContain('src/a.ts');
  });

  it('命中危险规则时附上类目与「不等于一定拒绝」的说明', () => {
    const text = describeAction({
      toolName: 'bash',
      input: { command: 'dd if=/dev/zero of=/dev/disk2' },
      cwd: '/tmp/proj',
      danger: {
        dangerous: true,
        category: 'disk-write',
        reason: '向块设备写入'
      } as never
    });
    expect(text).toContain('命中');
    expect(text).toContain('disk-write');
    expect(text).toContain('不等于一定拒绝');
  });

  it('参数超长时截断（避免一次写入把请求顶爆）', () => {
    const text = describeAction({
      toolName: 'write',
      input: { content: 'q'.repeat(20000) },
      cwd: '/tmp'
    });
    expect(text).toContain('<truncated/>');
  });
});

describe('buildReviewRequest', () => {
  const base = {
    action: { toolName: 'bash', input: { command: 'ls' }, cwd: '/tmp/proj' },
    messages: [{ role: 'user', content: '看看目录' }]
  };

  it('分节顺序：待审动作 → 对话转录 → 输出', () => {
    const { userMessage } = buildReviewRequest(base);
    const actionAt = userMessage.indexOf('## 待审动作');
    const transcriptAt = userMessage.indexOf('## 对话转录');
    const outputAt = userMessage.indexOf('## 输出');
    expect(actionAt).toBeGreaterThanOrEqual(0);
    expect(transcriptAt).toBeGreaterThan(actionAt);
    expect(outputAt).toBeGreaterThan(transcriptAt);
  });

  it('有 AGENTS.md 时插入项目约定段并标为可信', () => {
    const { userMessage, agentsText } = buildReviewRequest({
      ...base,
      agentsMd: '禁止执行部署命令'
    });
    expect(agentsText).toContain('禁止执行部署命令');
    expect(userMessage).toContain('## 项目约定');
    expect(userMessage.indexOf('## 项目约定')).toBeLessThan(userMessage.indexOf('## 输出'));
  });

  it('没有 AGENTS.md 时不出现空的项目约定段', () => {
    const { userMessage, agentsText } = buildReviewRequest(base);
    expect(agentsText).toBe('');
    expect(userMessage).not.toContain('## 项目约定');
  });

  it('AGENTS.md 超长也按预算截断', () => {
    const { agentsText } = buildReviewRequest({ ...base, agentsMd: 'r'.repeat(20000) });
    expect(agentsText).toContain('<truncated/>');
  });
});
