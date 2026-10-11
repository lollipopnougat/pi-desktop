import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import {
  buildSessionSearchIndex,
  searchSessionIndex,
  sessionSearchSnippet
} from '../../src/utils/session-search';

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: '/projects/piui',
    created: new Date('2026-10-01T00:00:00Z'),
    modified: new Date('2026-10-02T00:00:00Z'),
    messageCount: 2,
    firstMessage: `会话 ${id}`,
    allMessagesText: '',
    ...overrides
  };
}

describe('session search', () => {
  it('按最后活动排序，项目指向最近会话，且不改变原会话列表', () => {
    const old = session('old', { created: new Date('2026-10-04T00:00:00Z') });
    const latest = session('latest', { modified: new Date('2026-10-05T00:00:00Z') });
    const other = session('other', {
      cwd: '/projects/other',
      modified: new Date('2026-10-03T00:00:00Z')
    });
    const source = [old, other, latest];
    const index = buildSessionSearchIndex(source);
    expect(index.sessions.map((entry) => entry.session.id)).toEqual(['latest', 'other', 'old']);
    expect(index.projects.map((entry) => entry.cwd)).toEqual(['/projects/piui', '/projects/other']);
    expect(index.projects[0].latestSession.session).toBe(latest);
    expect(source).toEqual([old, other, latest]);
    expect(searchSessionIndex(index, '   ')).toBe(index);
  });

  it('按文件去重，同名项目仍按完整路径区分', () => {
    const first = session('first');
    const second = session('second', { cwd: '/another/piui' });
    const index = buildSessionSearchIndex([first, first, second]);
    expect(index.sessions).toHaveLength(2);
    expect(index.projects.map((entry) => entry.name)).toEqual(['piui', 'piui']);
    expect(searchSessionIndex(index, '/another').projects[0].latestSession.session.id).toBe(
      'second'
    );
  });

  it('多个关键词可跨标题、项目和正文匹配，忽略大小写及多余空白', () => {
    const index = buildSessionSearchIndex([
      session('match', { name: '修复登录问题', allMessagesText: 'Token Refresh 请求失败' }),
      session('no-body', { name: '修复登录问题' }),
      session('no-title', { name: '优化日期选择器', allMessagesText: 'Token Refresh 请求失败' })
    ]);
    const result = searchSessionIndex(index, ' PIUI   登录\nREFRESH ');
    expect(result.sessions.map((entry) => entry.session.id)).toEqual(['match']);
    expect(result.projects).toHaveLength(0);
    expect(searchSessionIndex(index, '不存在的内容').sessions).toHaveLength(0);
  });

  it('重命名后仍可通过原首条消息及后续正文找到会话', () => {
    const index = buildSessionSearchIndex([
      session('renamed', {
        name: '重命名的标题',
        firstMessage: '最初的问题',
        allMessagesText: '后续讨论'
      })
    ]);
    expect(index.sessions[0].title).toBe('重命名的标题');
    expect(searchSessionIndex(index, '最初的问题').sessions).toHaveLength(1);
    expect(searchSessionIndex(index, '后续讨论').sessions).toHaveLength(1);
  });

  it('兼容 Windows 路径、旧会话无项目目录和空消息', () => {
    const index = buildSessionSearchIndex([
      session('windows', { cwd: 'C:\\Users\\dev\\PiUI\\' }),
      session('legacy', { cwd: '', firstMessage: '(no messages)' }),
      session('root', { cwd: '/' })
    ]);
    expect(index.sessions[0].projectName).toBe('PiUI');
    expect(index.sessions[1].title).toBe('未命名会话');
    expect(index.sessions[1].projectName).toBe('未知项目');
    expect(index.projects).toHaveLength(2);
    expect(index.projects[1].name).toBe('/');
    expect(searchSessionIndex(index, 'c:\\users').projects[0].latestSession.session.id).toBe(
      'windows'
    );
  });

  it('兼容经序列化的时间；损坏的活动时间回退到创建时间', () => {
    const serialized = JSON.parse(JSON.stringify(session('serialized'))) as SessionInfo;
    const fallback = session('fallback', {
      modified: new Date('invalid'),
      created: new Date('2026-10-04T00:00:00Z')
    });
    const index = buildSessionSearchIndex([serialized, fallback]);
    expect(index.sessions.map((entry) => entry.session.id)).toEqual(['fallback', 'serialized']);
  });

  it('摘要显示正文深处的命中位置，空查询不生成摘要', () => {
    const index = buildSessionSearchIndex([
      session('long', {
        allMessagesText: `${'前文 '.repeat(100)}SEARCH 命中正文 ${'后文 '.repeat(100)}`
      })
    ]);
    const entry = index.sessions[0];
    const snippet = sessionSearchSnippet(entry, 'search');
    expect(snippet).toContain('SEARCH 命中正文');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(162);
    expect(sessionSearchSnippet(entry, '')).toBe('');
  });
});
