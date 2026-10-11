import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { t } from '../i18n/zh';

export interface SearchSession {
  session: SessionInfo;
  title: string;
  projectName: string;
  content: string;
  searchText: string;
}

export interface SearchProject {
  cwd: string;
  name: string;
  latestSession: SearchSession;
  searchText: string;
}

export interface SessionSearchIndex {
  projects: SearchProject[];
  sessions: SearchSession[];
}

const compactText = (text: string) => text.replace(/\s+/g, ' ').trim();
const queryTerms = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

function activityTime(session: SessionInfo): number {
  const modified = new Date(session.modified).getTime();
  return Number.isFinite(modified) ? modified : new Date(session.created).getTime() || 0;
}

/** 按最近活动构建一次搜索索引，不依赖侧栏当前的排序方式。 */
export function buildSessionSearchIndex(sessions: readonly SessionInfo[]): SessionSearchIndex {
  const sorted = [...sessions].sort((a, b) => activityTime(b) - activityTime(a));
  const seenPaths = new Set<string>();
  const projects = new Map<string, SearchProject>();
  const entries: SearchSession[] = [];

  for (const session of sorted) {
    if (!session.path || seenPaths.has(session.path)) continue;
    seenPaths.add(session.path);
    const projectName =
      session.cwd
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() ||
      session.cwd ||
      t.sessionSearch.unknownProject;
    const firstMessage = session.firstMessage === '(no messages)' ? '' : session.firstMessage;
    const title = compactText(session.name || firstMessage || t.sessionSearch.unnamedSession);
    const content = compactText(session.allMessagesText || firstMessage);
    const entry: SearchSession = {
      session,
      title,
      projectName,
      content,
      searchText: `${title}\n${session.cwd}\n${firstMessage}\n${content}`.toLowerCase()
    };
    entries.push(entry);
    if (session.cwd && !projects.has(session.cwd)) {
      projects.set(session.cwd, {
        cwd: session.cwd,
        name: projectName,
        latestSession: entry,
        searchText: `${projectName}\n${session.cwd}`.toLowerCase()
      });
    }
  }

  return { projects: [...projects.values()], sessions: entries };
}

/** 多个关键词可分别命中标题、项目路径和对话正文；保留最近活动顺序。 */
export function searchSessionIndex(index: SessionSearchIndex, query: string): SessionSearchIndex {
  const terms = queryTerms(query);
  if (!terms.length) return index;
  const matches = (entry: { searchText: string }) =>
    terms.every((term) => entry.searchText.includes(term));
  return {
    projects: index.projects.filter(matches),
    sessions: index.sessions.filter(matches)
  };
}

/** 仅为可见结果生成正文摘要，正文命中时将匹配位置放进摘要。 */
export function sessionSearchSnippet(entry: SearchSession, query: string): string {
  if (!query.trim() || !entry.content) return '';
  const lower = entry.content.toLowerCase();
  const positions = queryTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((pos) => pos >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 45) : 0;
  const excerpt = entry.content.slice(start, start + 160);
  return `${start > 0 ? '…' : ''}${excerpt}${start + 160 < entry.content.length ? '…' : ''}`;
}
