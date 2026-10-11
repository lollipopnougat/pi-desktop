import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiBridgeContext } from './types';
import { getSessionDir, removeProjectSessions } from '../provider-config';
import {
  deleteSubagentSessionsForParent,
  deleteSubagentSessionsForProject
} from '../subagents/session-file';
import { t } from '../../src/i18n/zh';

function assertSwitched(result: { cancelled: boolean }): void {
  if (result.cancelled) throw new Error(t.sessionSwitchCancelled);
}

/** 生成简易唯一 id */
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/**
 * 注册会话管理相关 IPC：newSession / switchSession / fork / forkByTimestamp /
 * duplicateSession / renameSession / exportSession(Jsonl|Html) / deleteSession / listSessions
 */
export function registerSessionIpc(ctx: PiBridgeContext) {
  // === 会话切换/分支 ===
  ipcMain.handle('pi:newSession', (_e, cwd?: string) =>
    ctx.runSessionOperation(async () => {
      if (cwd && path.resolve(cwd) !== path.resolve(ctx.cwd)) {
        await ctx.createRuntimeFor(cwd);
      } else {
        assertSwitched(await ctx.runtime.newSession());
      }
    })
  );

  // SDK 按会话文件的 cwd 创建 services；跨项目切换只需这一个原子操作。
  ipcMain.handle('pi:switchSession', (_e, sessionPath: string) =>
    ctx.runSessionOperation(async () => {
      assertSwitched(await ctx.runtime.switchSession(sessionPath));
    })
  );

  ipcMain.handle('pi:fork', (_e, entryId: string, pos?: string) =>
    ctx.runSessionOperation(async () => {
      assertSwitched(await ctx.runtime.fork(entryId, pos ? { position: pos } : undefined));
    })
  );

  // 按消息 timestamp fork：遍历 session entries 找匹配的 message entry
  ipcMain.handle('pi:forkByTimestamp', (_e, timestamp: number, pos?: string) =>
    ctx.runSessionOperation(async () => {
      const sf = ctx.getSession().sessionFile;
      if (!sf) throw new Error('no session file');
      const sm = SessionManager.open(sf);
      const entries = sm.getEntries?.() ?? [];
      let entryId: string | null = null;
      for (const e of entries as any[]) {
        if (
          e.type === 'message' &&
          e.message &&
          Number(e.message.timestamp) === Number(timestamp)
        ) {
          entryId = e.id;
          break;
        }
      }
      if (!entryId) throw new Error('entry not found for timestamp');
      assertSwitched(await ctx.runtime.fork(entryId, pos ? { position: pos } : undefined));
      return { ok: true, entryId };
    })
  );

  // === 会话文件管理（复制/重命名/导出/删除） ===

  // 复制会话：拷贝 JSONL 文件并改写首行 header id，避免列表 id 冲突
  ipcMain.handle('pi:duplicateSession', async (_e, sessionPath: string) => {
    const src = path.resolve(sessionPath);
    if (!fs.existsSync(src)) throw new Error('session file not found');
    const dir = path.dirname(src);
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let dst = path.join(dir, `${base}-copy${ext}`);
    let i = 1;
    while (fs.existsSync(dst)) {
      dst = path.join(dir, `${base}-copy-${i}${ext}`);
      i++;
    }
    const lines = fs
      .readFileSync(src, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (lines.length > 0) {
      try {
        const header = JSON.parse(lines[0]);
        header.id = genId();
        header.timestamp = new Date().toISOString();
        lines[0] = JSON.stringify(header);
      } catch {}
    }
    fs.writeFileSync(dst, lines.join('\n') + '\n', 'utf-8');
    return { ok: true, newSessionPath: dst };
  });

  // 重命名会话：追加一行 session_info entry（append-only，list 读最新值）
  ipcMain.handle('pi:renameSession', async (_e, sessionPath: string, name: string) => {
    const p = path.resolve(sessionPath);
    if (!fs.existsSync(p)) throw new Error('session file not found');
    const sanitizedName = (name || '').replace(/[\r\n]+/g, ' ').trim();
    if (!sanitizedName) throw new Error('name is empty');
    const lines = fs
      .readFileSync(p, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    let parentId: string | null = null;
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        parentId = last.id ?? null;
      } catch {}
    }
    const entry = {
      type: 'session_info',
      id: genId(),
      parentId,
      timestamp: new Date().toISOString(),
      name: sanitizedName
    };
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
    return { ok: true };
  });

  // 导出会话为 JSONL：拷贝文件到用户指定路径
  ipcMain.handle('pi:exportSessionJsonl', async (_e, sessionPath: string, outputPath: string) => {
    const src = path.resolve(sessionPath);
    if (!fs.existsSync(src)) throw new Error('session file not found');
    fs.copyFileSync(src, outputPath);
    return { ok: true, filePath: outputPath };
  });

  // 导出会话为 HTML：需 runtime，先切换到目标会话再导出
  ipcMain.handle('pi:exportSessionHtml', (_e, sessionPath: string, outputPath: string) =>
    ctx.runSessionOperation(async () => {
      const curFile = ctx.getSession().sessionFile;
      const curCwd = ctx.cwd;
      const curManager = ctx.getSession().sessionManager;
      const switched = curFile !== sessionPath;
      let moved = false;
      try {
        if (switched) {
          assertSwitched(await ctx.runtime.switchSession(sessionPath));
          moved = true;
          await ctx.syncSession();
        }
        const out = await ctx.getSession().exportToHtml(outputPath);
        return { ok: true, filePath: out };
      } finally {
        if (moved) {
          if (curFile && fs.existsSync(curFile)) {
            assertSwitched(await ctx.runtime.switchSession(curFile));
          } else {
            await ctx.createRuntimeFor(curCwd, curManager);
          }
        }
      }
    })
  );

  // 删除会话：直接删文件，拒绝删除当前激活会话
  ipcMain.handle('pi:deleteSession', async (_e, sessionPath: string) => {
    const p = path.resolve(sessionPath);
    const curFile = ctx.getSession().sessionFile;
    if (curFile && path.resolve(curFile) === p) {
      throw new Error('无法删除当前激活的会话，请先切换到其他会话');
    }
    if (!fs.existsSync(p)) throw new Error('session file not found');
    fs.unlinkSync(p);
    // 主会话被删后其 run 记录一并消失,子 agent 会话文件失去引用 → 同步清理
    deleteSubagentSessionsForParent(p);
    return { ok: true };
  });

  ipcMain.handle('pi:removeProject', async (_e, cwd: string) => {
    try {
      // 先清子 agent 会话(否则主会话目录没了就无从定位),再删主会话目录
      deleteSubagentSessionsForProject(getSessionDir(cwd));
      removeProjectSessions(cwd);
      return { ok: true };
    } catch (e: any) {
      throw new Error(`移除项目失败: ${e?.message ?? e}`);
    }
  });

  ipcMain.handle('pi:listSessions', async () => {
    // list 传当前 cwd 的编码目录；listAll 不传参，走 SDK 默认 getSessionsDir()
    // （已被 PI_CODING_AGENT_DIR 重定向到 ~/.pi-desktop/sessions，SDK 会递归扫描所有子目录）
    const sessions = await SessionManager.list(ctx.cwd, getSessionDir(ctx.cwd));
    const allSessions = await SessionManager.listAll();
    return { current: sessions, all: allSessions };
  });

  // === 会话树 ===
  // 只返回骨架节点（避免 tool result / thinking 等大文本塭 renderer）
  // 若节点被展开，renderer 额外调 pi:getSessionEntry 拿完整 entry
  ipcMain.handle('pi:getTree', async () => {
    const sf = ctx.getSession().sessionFile;
    if (!sf) return null;
    const sm = SessionManager.open(sf);
    const tree = sm.getTree();

    const truncate = (s: unknown, max = 120): string => {
      if (typeof s !== 'string') return '';
      const flat = s.replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max) + '...' : flat;
    };

    const extractText = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text ?? '')
          .join(' ');
      }
      return '';
    };

    const formatToolCall = (name: string, args: any): string => {
      args = args || {};
      const shorten = (p: string) => {
        if (!p) return '';
        // Windows 无 HOME 环境变量（只有 USERPROFILE），优先 os.homedir()
        const home = os.homedir();
        return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
      };
      switch (name) {
        case 'read': {
          let display = shorten(String(args.path || args.file_path || ''));
          const offset = args.offset;
          const limit = args.limit;
          if (offset !== undefined || limit !== undefined) {
            const start = offset ?? 1;
            const end = limit !== undefined ? start + limit - 1 : '';
            display += `:${start}${end ? `-${end}` : ''}`;
          }
          return `[read: ${display}]`;
        }
        case 'write':
          return `[write: ${shorten(String(args.path || args.file_path || ''))}]`;
        case 'edit':
          return `[edit: ${shorten(String(args.path || args.file_path || ''))}]`;
        case 'bash': {
          const raw = String(args.command || '');
          const cmd = raw.replace(/\s+/g, ' ').trim().slice(0, 50);
          return `[bash: ${cmd}${raw.length > 50 ? '...' : ''}]`;
        }
        case 'grep':
          return `[grep: /${String(args.pattern || '')}/ in ${shorten(String(args.path || '.'))}]`;
        case 'find':
          return `[find: ${String(args.pattern || '')} in ${shorten(String(args.path || '.'))}]`;
        default:
          return `[${name}]`;
      }
    };

    // 预计算 tool call id → 格式化值，供 toolResult 反查
    const toolCallMap = new Map<string, string>();
    const collectToolCalls = (e: any) => {
      if (e?.type === 'message' && e.message?.role === 'assistant') {
        const content = e.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'toolCall' && block.id) {
              toolCallMap.set(block.id, formatToolCall(block.name, block.arguments));
            }
          }
        }
      }
    };

    const nodeToSkeleton = (entry: any, label?: string) => {
      const base = {
        id: entry.id,
        parentId: entry.parentId ?? null,
        type: entry.type,
        label,
        tag: '',
        text: ''
      };
      if (entry.type === 'message' && entry.message) {
        const msg = entry.message;
        const role = msg.role;
        base.tag = role;
        if (role === 'user') base.text = truncate(extractText(msg.content), 80);
        else if (role === 'assistant') {
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          const text = extractText(blocks);
          if (text) base.text = truncate(text, 80);
          else if (msg.stopReason === 'aborted') base.text = '(已中止)';
          else if (msg.errorMessage) base.text = truncate(msg.errorMessage, 80);
          else {
            const tc = blocks.find((c: any) => c.type === 'toolCall');
            base.text = tc ? formatToolCall(tc.name, tc.arguments) : '(无内容)';
          }
        } else if (role === 'toolResult') {
          base.text = msg.toolCallId
            ? (toolCallMap.get(msg.toolCallId) ?? `[${msg.toolName ?? 'tool'}]`)
            : `[${msg.toolName ?? 'tool'}]`;
        } else if (role === 'bashExecution') {
          base.tag = 'bash';
          base.text = `[bash: ${truncate(msg.command ?? '', 50)}]`;
        } else if (role === 'branchSummary') {
          base.tag = 'branch';
          base.text = truncate(msg.summary ?? '', 80);
        } else if (role === 'compactionSummary') {
          base.tag = 'compaction';
          base.text = truncate(msg.summary ?? '', 80);
        } else if (role === 'custom') {
          base.tag = msg.customType ?? 'custom';
          base.text = truncate(extractText(msg.content), 60);
        } else if (role === 'system') {
          // SDK 0.86：system prompt/工具变更声明以 role='system' 消息持久化，
          // 带 toolsAdded/toolsRemoved 时展示变更声明，否则展示文本前缀
          base.tag = 'system';
          if (Array.isArray(msg.toolsAdded) && msg.toolsAdded.length > 0) {
            base.text = `[system: +${msg.toolsAdded.join(', ')}]`;
          } else if (Array.isArray(msg.toolsRemoved) && msg.toolsRemoved.length > 0) {
            base.text = `[system: -${msg.toolsRemoved.join(', ')}]`;
          } else {
            base.text = truncate(extractText(msg.content), 80) || '(system)';
          }
        } else base.text = role;
      } else {
        switch (entry.type) {
          case 'compaction':
            base.tag = 'compaction';
            base.text = `${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens`;
            break;
          case 'branch_summary':
            base.tag = 'branch';
            base.text = truncate(entry.summary ?? '', 80);
            break;
          case 'model_change':
            base.tag = 'model';
            base.text = `${entry.provider ? entry.provider + '/' : ''}${entry.modelId ?? ''}`;
            break;
          case 'thinking_level_change':
            base.tag = 'thinking';
            base.text = entry.thinkingLevel ?? '';
            break;
          case 'custom':
            base.tag = entry.customType ?? 'custom';
            if (entry.customType === 'goal-state') {
              const g = (entry.data ?? entry.content)?.goal;
              base.tag = 'goal';
              base.text = g
                ? `${g.status ?? 'cleared'}${g.text ? ' · ' + truncate(g.text, 50) : ''}`
                : '(已清除)';
            } else if (entry.customType === 'plan-state') {
              const ph = (entry.data ?? entry.content)?.phase;
              base.tag = 'plan';
              base.text = ph === 'planning' ? '规划中' : ph === 'executing' ? '实现中' : '已退出';
            } else if (entry.customType === 'subagent-state') {
              const r = (entry.data ?? entry.content)?.run;
              base.tag = 'subagent';
              base.text = r
                ? `${r.name ?? r.agent}(${r.agent}) · ${
                    r.status === 'complete'
                      ? '完成'
                      : r.status === 'failed'
                        ? '失败'
                        : r.status === 'stopped'
                          ? '停止'
                          : r.status
                  }`
                : '';
            } else {
              base.text = '';
            }
            break;
          default:
            base.tag = entry.type;
            base.text = '';
        }
      }
      return base;
    };

    // 第一遍：收集所有 toolCall（供 toolResult 反查）。加 Set 防环。
    const visited = new Set<string>();
    const walkCollect = (list: any[]) => {
      for (const n of list) {
        const id = n.entry?.id;
        if (id && visited.has(id)) continue;
        if (id) visited.add(id);
        collectToolCalls(n.entry);
        if (n.children?.length) walkCollect(n.children);
      }
    };
    walkCollect(tree);

    // 第二遍：生成骨架节点（复用 visited 防环）
    visited.clear();
    type Skeleton = ReturnType<typeof nodeToSkeleton>;
    const nodes: Skeleton[] = [];
    let rootId: string | null = null;
    const walkBuild = (list: any[]) => {
      for (const n of list) {
        const id = n.entry?.id;
        if (id && visited.has(id)) continue;
        if (id) visited.add(id);
        if (!rootId && id) rootId = id;
        nodes.push(nodeToSkeleton(n.entry, n.label));
        if (n.children?.length) walkBuild(n.children);
      }
    };
    walkBuild(tree);

    return {
      nodes,
      rootId,
      leafId: sm.getLeafEntry()?.id ?? null
    };
  });

  // === 会话树节点详情（按需加载） ===
  ipcMain.handle('pi:getSessionEntry', async (_e, entryId: string) => {
    const sf = ctx.getSession().sessionFile;
    if (!sf) return null;
    const sm = SessionManager.open(sf);
    const entries = sm.getEntries();
    return entries.find((e: any) => e.id === entryId) ?? null;
  });

  ipcMain.handle('pi:navigateTree', (_e, id: string, summarize?: boolean) =>
    ctx.runSessionOperation(async () => {
      await ctx.getSession().abort();
      await ctx.getSession().navigateTree(id, summarize ? { summarize: true } : undefined);
    })
  );

  ipcMain.handle('pi:setSessionName', async (_e, name: string) => {
    const sf = ctx.getSession().sessionFile;
    if (sf) {
      const sm = SessionManager.open(sf);
      // @ts-expect-error - method may vary by SDK version
      sm.setSessionName?.(name);
    }
  });

  ipcMain.handle('pi:exportHtml', async (_e, outPath?: string) => {
    const sf = ctx.getSession().sessionFile;
    if (!sf) return null;
    return { sessionFile: sf, outputPath: outPath };
  });

  /**
   * 从当前会话历史重建 todo 阶段：找最后一条 update_plan 工具结果，
   * 取其 details.phases。无则返回空数组（前端据此清空 TodoPanel）。
   *
   * 注意：pi-ai 的 ToolResultMessage 持久化时 role 为 'toolResult'（非 'tool'），
   * details 是工具 execute 返回的扩展元数据（不发给 LLM，但会随 message 持久化）。
   */
  ipcMain.handle('pi:getTodoPhases', async () => {
    try {
      const msgs = ctx.getSession().messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m: any = msgs[i];
        if (
          m &&
          (m.role === 'toolResult' || m.role === 'tool') &&
          m.toolName === 'update_plan' &&
          !m.isError
        ) {
          const phases = m?.details?.phases ?? m?.result?.details?.phases;
          if (Array.isArray(phases) && phases.length > 0) {
            return { phases, found: true };
          }
        }
      }
      return { phases: [], found: false };
    } catch {
      return { phases: [], found: false };
    }
  });
}
