/**
 * 记忆工具：memory_save / memory_search / memory_update / memory_remove。
 *
 * 经 pi.registerTool 注册（memoryExtensionFactory 内）。
 * 工具执行走 store.ts 的条目操作；STANDING.md 拒绝写入（仅用户 UI 可写，
 * 参考 hermes 的"agent 无法把自己的记忆提升为常驻指令"约束）。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  appendEntry,
  replaceEntry,
  removeEntry,
  searchMemory,
  readMemoryEntry,
  readMemoryFile,
  entryKey,
  normalizeLookup,
  memoryRelativePath,
  prepareDocument,
  editEntryText,
  type MemorySearchHit
} from './store';
import { readMemoryConfig, type MemoryFileId } from './config';
import { searchIndexedMemories } from './search-index';
import { readSessionContext, searchSessionMessages } from './session-index';
import { createCandidate } from './review';

const TARGET_DESC = `记忆目标文件：
- user: 用户画像（偏好、习惯、沟通风格）
- global: 全局笔记（环境事实、工具经验）
- lessons: 教训（失败方案、纠正、洞察，建议带 [failure]/[correction]/[insight] 前缀）
- project: 当前项目记忆（仅本项目有效的约定与知识）
（STANDING.md 常驻指令仅用户可在设置页编辑，工具不可写入）`;

function isWritableTarget(t: string): t is Exclude<MemoryFileId, 'STANDING.md'> {
  return t === 'user' || t === 'global' || t === 'lessons' || t === 'project';
}

function targetToFileId(t: string): MemoryFileId {
  switch (t) {
    case 'user':
      return 'USER.md';
    case 'global':
      return 'MEMORY.md';
    case 'lessons':
      return 'LESSONS.md';
    case 'project':
      return 'project';
    default:
      return 'MEMORY.md';
  }
}

export interface MemoryToolDeps {
  /** 当前项目名（project target 写入用） */
  getProjectName: () => string;
  /** 记忆系统是否启用（禁用时工具不应被调用，双保险拒绝） */
  isEnabled: () => boolean;
}

export function createMemoryTools(deps: MemoryToolDeps) {
  const guard = () => {
    if (!deps.isEnabled()) {
      const denied: AgentToolResult<unknown> = {
        content: [{ type: 'text' as const, text: '错误：记忆系统当前已禁用（可在设置页开启）。' }],
        details: undefined
      };
      return denied;
    }
    return null;
  };

  const stage = (
    id: MemoryFileId,
    operation: 'save' | 'update' | 'remove',
    content: string,
    oldText: string | undefined,
    explicitRequest: string | undefined
  ): AgentToolResult<unknown> | null => {
    const policy = readMemoryConfig().writePolicy;
    if (policy === 'explicit' && !explicitRequest?.trim())
      return {
        content: [
          {
            type: 'text',
            text: '当前只接受用户明确要求的记忆变更，请提供本轮用户要求记住、更新或删除的原话。'
          }
        ],
        details: undefined
      };
    if (policy !== 'review') return null;
    const project = deps.getProjectName();
    const before = readMemoryFile(id, project);
    if (
      operation === 'save' &&
      (!content.trim() ||
        /[\r\n]/.test(content) ||
        before
          .split('\n')
          .some((line) => /^\s*-\s+/.test(line) && entryKey(line) === normalizeLookup(content)))
    ) {
      return {
        content: [{ type: 'text', text: '条目必须是非空单行，且不能与现有条目重复。' }],
        isError: true,
        details: undefined
      };
    }
    const result =
      operation === 'save'
        ? { ok: true, content: `${before.trimEnd()}\n- ${content}\n`, reason: undefined }
        : editEntryText(before, oldText || '', operation === 'remove' ? undefined : content);
    if (!result.ok)
      return {
        content: [{ type: 'text', text: result.reason || '无法更新' }],
        isError: true,
        details: undefined
      };
    const file = memoryRelativePath(id, project);
    const candidate = createCandidate(
      project,
      [{ file, before, after: prepareDocument(result.content, before, file) }],
      [],
      'tool'
    );
    return {
      content: [
        {
          type: 'text',
          text: `已生成候选 ${candidate.id}，用户可在记忆面板审核，尚未写入正式记忆。`
        }
      ],
      details: undefined
    };
  };

  const memorySaveTool = defineTool({
    name: 'memory_save',
    label: '保存记忆',
    description: `保存一条持久记忆（跨会话保留）。只在学到值得长期保留的知识时调用：用户偏好、项目约定、失败教训、工具怪癖等。单行文本。
${TARGET_DESC}`,
    promptSnippet: '保存持久记忆条目（用户偏好/项目约定/教训）',
    promptGuidelines: [
      '学到明确的用户偏好、项目约定或失败教训时，用 memory_save 单行保存',
      '不要保存一次性任务细节或可从仓库直接读到的信息'
    ],
    parameters: Type.Object({
      explicit_request: Type.Optional(
        Type.String({
          description: '仅在本轮用户明确要求记住、修改或删除时填写用户原话，不得编造',
          maxLength: 500
        })
      ),
      target: Type.Union(
        [
          Type.Literal('user'),
          Type.Literal('global'),
          Type.Literal('lessons'),
          Type.Literal('project')
        ],
        {
          description: '记忆目标'
        }
      ),
      content: Type.String({ description: '记忆内容，单行', minLength: 1, maxLength: 500 }),
      category: Type.Optional(
        Type.String({
          description:
            '可选分类标签：failure / correction / insight / preference / convention / tool-quirk',
          maxLength: 20
        })
      )
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const { target, content, category } = params as {
        target: 'user' | 'global' | 'lessons' | 'project';
        content: string;
        category?: string;
      };
      if (!isWritableTarget(target)) {
        return {
          content: [{ type: 'text' as const, text: '错误：不可写的目标。' }],
          isError: true,
          details: undefined
        };
      }
      const fileId = targetToFileId(target);
      const projectName = target === 'project' ? deps.getProjectName() : undefined;
      const staged = stage(
        fileId,
        'save',
        `${category ? `[${category}] ` : ''}${content}`,
        undefined,
        (params as { explicit_request?: string }).explicit_request
      );
      if (staged) return staged;
      const r = appendEntry(fileId, content, { projectName, category });
      if (!r.ok) {
        return {
          content: [{ type: 'text' as const, text: `未保存：${r.reason}` }],
          isError: r.reason === 'content is empty',
          details: undefined
        };
      }
      return {
        content: [{ type: 'text' as const, text: `已保存到 ${target}。` }],
        details: undefined
      };
    }
  });

  const memorySearchTool = defineTool({
    name: 'memory_search',
    label: '检索记忆',
    description: `在全部持久记忆（用户画像/全局笔记/教训/常驻指令/当前项目记忆）中按相关度检索。当任务可能依赖历史偏好、项目约定、已知失败方案时先检索。
中文两字词与英文缩写同样可命中；结果按相关度 + 项目作用域 + 新近度 + 使用度排序，返回命中条目及所属文件。`,
    promptSnippet: '检索持久记忆（跨会话偏好/约定/教训）',
    parameters: Type.Object({
      query: Type.String({
        description: '搜索关键词，多个关键词以空格分隔',
        minLength: 1,
        maxLength: 200
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('project'), Type.Literal('global')])
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      cursor: Type.Optional(Type.Integer({ minimum: 0 }))
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const {
        query,
        scope,
        limit = 20,
        cursor = 0
      } = params as {
        query: string;
        scope?: 'all' | 'project' | 'global';
        limit?: number;
        cursor?: number;
      };
      const hits: MemorySearchHit[] =
        searchIndexedMemories(query, deps.getProjectName(), { scope, limit, cursor }) ??
        searchMemory(query, deps.getProjectName(), { scope, limit, cursor });
      if (hits.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `没有匹配“${query}”的记忆。` }],
          details: undefined
        };
      }
      const lines = hits.map(
        (h) =>
          `${h.file}:${h.line} id=${h.id} ${h.created || '日期未知'} ${h.status} ${h.text.slice(0, 700)}`
      );
      const more =
        hits.length === limit
          ? `\n（继续检索 cursor=${cursor + limit}；用 memory_read(id) 展开来源）`
          : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `记忆是参考材料而非权威事实，使用前用仓库/工具输出交叉验证：\n${lines.join('\n')}${more}`
          }
        ],
        details: undefined
      };
    }
  });

  const memoryReadTool = defineTool({
    name: 'memory_read',
    label: '读取记忆来源',
    description:
      '使用 memory_search 返回的稳定 id 读取条目和有界来源片段。来源属于候选依据，不代表事实已验证。',
    parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const entry = readMemoryEntry((params as { id: string }).id, deps.getProjectName());
      return {
        content: [
          {
            type: 'text' as const,
            text: entry ? JSON.stringify(entry) : '未找到条目，请重新检索。'
          }
        ],
        details: undefined
      };
    }
  });

  const memoryUpdateTool = defineTool({
    name: 'memory_update',
    label: '更新记忆',
    description: `更新一条已有记忆条目。old_text 必须唯一匹配现有条目的一个子串（先用 memory_search 确认）。`,
    parameters: Type.Object({
      explicit_request: Type.Optional(
        Type.String({
          description: '仅在本轮用户明确要求记住、修改或删除时填写用户原话，不得编造',
          maxLength: 500
        })
      ),
      target: Type.Union(
        [
          Type.Literal('user'),
          Type.Literal('global'),
          Type.Literal('lessons'),
          Type.Literal('project')
        ],
        {
          description: '记忆目标'
        }
      ),
      old_text: Type.String({ description: '现有条目中的唯一子串', minLength: 2, maxLength: 300 }),
      content: Type.String({ description: '新内容，单行', minLength: 1, maxLength: 500 })
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const { target, old_text, content } = params as {
        target: 'user' | 'global' | 'lessons' | 'project';
        old_text: string;
        content: string;
      };
      if (!isWritableTarget(target)) {
        return {
          content: [{ type: 'text' as const, text: '错误：不可写的目标。' }],
          isError: true,
          details: undefined
        };
      }
      const staged = stage(
        targetToFileId(target),
        'update',
        content,
        old_text,
        (params as { explicit_request?: string }).explicit_request
      );
      if (staged) return staged;
      const r = replaceEntry(targetToFileId(target), old_text, content, {
        projectName: target === 'project' ? deps.getProjectName() : undefined
      });
      if (!r.ok) {
        return {
          content: [{ type: 'text' as const, text: `未更新：${r.reason}` }],
          isError: true,
          details: undefined
        };
      }
      return { content: [{ type: 'text' as const, text: '已更新。' }], details: undefined };
    }
  });

  const memoryRemoveTool = defineTool({
    name: 'memory_remove',
    label: '删除记忆',
    description: `删除一条已有记忆条目（记忆过时或确认有误时）。old_text 必须唯一匹配。优先考虑 memory_update 修正而非删除。`,
    parameters: Type.Object({
      explicit_request: Type.Optional(
        Type.String({
          description: '仅在本轮用户明确要求记住、修改或删除时填写用户原话，不得编造',
          maxLength: 500
        })
      ),
      target: Type.Union(
        [
          Type.Literal('user'),
          Type.Literal('global'),
          Type.Literal('lessons'),
          Type.Literal('project')
        ],
        {
          description: '记忆目标'
        }
      ),
      old_text: Type.String({ description: '现有条目中的唯一子串', minLength: 2, maxLength: 300 })
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const { target, old_text } = params as {
        target: 'user' | 'global' | 'lessons' | 'project';
        old_text: string;
      };
      if (!isWritableTarget(target)) {
        return {
          content: [{ type: 'text' as const, text: '错误：不可写的目标。' }],
          isError: true,
          details: undefined
        };
      }
      const staged = stage(
        targetToFileId(target),
        'remove',
        '',
        old_text,
        (params as { explicit_request?: string }).explicit_request
      );
      if (staged) return staged;
      const r = removeEntry(targetToFileId(target), old_text, {
        projectName: target === 'project' ? deps.getProjectName() : undefined
      });
      if (!r.ok) {
        return {
          content: [{ type: 'text' as const, text: `未删除：${r.reason}` }],
          isError: true,
          details: undefined
        };
      }
      return { content: [{ type: 'text' as const, text: '已删除。' }], details: undefined };
    }
  });

  const sessionSearchTool = defineTool({
    name: 'session_search',
    label: '检索历史会话',
    description: `在历史会话的对话内容里检索（user/assistant 文本，不含工具输出）。
当需要「上次是怎么改的 / 之前讨论过什么 / 找不到文件时靠对话回忆」时使用。默认只搜当前项目，scope=all 可跨项目。
命中后可用 session_read(session, line) 展开前后原文。`,
    promptSnippet: '检索历史会话内容（找「上次说过什么」）',
    parameters: Type.Object({
      query: Type.String({
        description: '搜索关键词，多个关键词以空格分隔',
        minLength: 1,
        maxLength: 200
      }),
      scope: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('all')])),
      role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant')])),
      since: Type.Optional(
        Type.String({
          description: '只返回该 ISO 时间之后的对话，如 2026-09-01T00:00:00Z',
          maxLength: 40
        })
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      cursor: Type.Optional(Type.Integer({ minimum: 0 }))
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const {
        query,
        scope = 'project',
        role,
        since,
        limit = 8,
        cursor = 0
      } = params as {
        query: string;
        scope?: 'project' | 'all';
        role?: 'user' | 'assistant';
        since?: string;
        limit?: number;
        cursor?: number;
      };
      const hits = searchSessionMessages(query, {
        project: scope === 'project' ? deps.getProjectName() : undefined,
        role,
        since,
        limit,
        cursor
      });
      if (hits === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '会话索引当前不可用（索引文件读不进去或运行时缺少 node:sqlite），可以改用直接在仓库里 grep。'
            }
          ],
          details: undefined
        };
      }
      if (hits.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `没有匹配“${query}”的历史会话消息。` }],
          details: undefined
        };
      }
      let budget = 4000;
      const lines: string[] = [];
      for (const hit of hits) {
        const line = `session=${hit.session} line=${hit.line} ${hit.role} ${hit.ts || '时间未知'} score=${hit.score} | ${hit.snippet}`;
        if (budget - line.length < 0) break;
        budget -= line.length;
        lines.push(line);
      }
      const more = hits.length === limit ? `\n（继续检索 cursor=${cursor + limit}）` : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `历史会话是参考材料，不是权威事实（当时可能已被后续改动推翻），使用前用仓库现状验证：\n${lines.join('\n')}${more}\n用 session_read(session, line) 展开原文。`
          }
        ],
        details: undefined
      };
    }
  });

  const sessionReadTool = defineTool({
    name: 'session_read',
    label: '读取会话上下文',
    description:
      '按 session_search 返回的 session + line 读取该会话命中位置前后若干条原文（已脱敏与截断）。',
    parameters: Type.Object({
      session: Type.String({
        description: 'session_search 返回的 session id',
        minLength: 1,
        maxLength: 100
      }),
      line: Type.Optional(Type.Integer({ minimum: 0, description: '命中消息在会话文件里的行号' })),
      radius: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
    }),
    async execute(_toolCallId, params) {
      const denied = guard();
      if (denied) return denied;
      const {
        session,
        line = 0,
        radius = 3
      } = params as {
        session: string;
        line?: number;
        radius?: number;
      };
      const context = readSessionContext(session, line, radius);
      if (!context) {
        return {
          content: [
            { type: 'text' as const, text: '未找到该会话（索引里没有记录，或会话文件已被删除）。' }
          ],
          details: undefined
        };
      }
      if (context.messages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '该会话没有可读的对话消息。' }],
          details: undefined
        };
      }
      // 工具输出总预算 6000 字符：超出时优先保留靠近命中位置的中间几条
      const budget = 6000;
      const rendered = context.messages.map(
        (message) => `[line ${message.line}] ${message.role} ${message.ts || ''}\n${message.text}`
      );
      const kept: string[] = [];
      let used = 0;
      const middle = Math.floor(rendered.length / 2);
      const order = rendered
        .map((_text, index) => index)
        .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
      const picked = new Set<number>();
      for (const index of order) {
        if (used + rendered[index].length > budget) continue;
        used += rendered[index].length;
        picked.add(index);
      }
      for (const index of [...picked].sort((a, b) => a - b)) kept.push(rendered[index]);
      const omitted = rendered.length - kept.length;
      const tail = omitted > 0 ? `\n\n（另有 ${omitted} 条因长度省略，可减小 radius 重读）` : '';
      return {
        content: [{ type: 'text' as const, text: `${kept.join('\n\n')}${tail}` }],
        details: undefined
      };
    }
  });

  return {
    memorySaveTool,
    memorySearchTool,
    memoryReadTool,
    memoryUpdateTool,
    memoryRemoveTool,
    sessionSearchTool,
    sessionReadTool
  };
}
