/**
 * 终端 IPC：在主进程中用 node-pty 创建伪终端，通过 IPC 把数据流转发到渲染进程。
 *
 * 设计：
 * - 每个「终端实例」由一个 id 标识，主进程维护 pty 进程映射。
 * - 渲染进程调用 terminal:create 创建实例，返回 id；之后用 terminal:write 发送输入。
 * - 主进程通过 `terminal:data:<id>` 事件向渲染进程推送输出；`terminal:exit:<id>` 推送退出。
 * - terminal:resize 同步窗口尺寸到 pty。
 * - terminal:kill 销毁实例。
 */
import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { PiBridgeContext } from './types';

export interface TerminalContext extends PiBridgeContext {
  /** 创建 pty 时的默认 shell（可选） */
  defaultShell?: string;
}

interface PtyEntry {
  proc: pty.IPty;
  cwd: string;
}

/** 活跃终端实例：id -> pty entry */
const ptys = new Map<string, PtyEntry>();

/** 推送事件给渲染进程的发送器 */
function sender(ctx: TerminalContext) {
  return (channel: string, ...args: any[]) => {
    const win = (ctx as any).win;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };
}

/** 解析当前可用的默认 shell */
function resolveShell(explicit?: string): string {
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    // Windows 默认用 PowerShell：优先 PowerShell 7（pwsh.exe），回退到 Windows PowerShell 5.1（powershell.exe）。
    // 仅在均不可用时退到 cmd（%COMSPEC% 或 cmd.exe）。
    const candidates = ['pwsh.exe', 'powershell.exe', process.env.COMSPEC || '', 'cmd.exe'];
    for (const c of candidates) {
      if (c && isShellAvailable(c)) return c;
    }
    return 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

/** 校验 shell 是否可执行（仅 Windows 下用 where 探测 PATH） */
function isShellAvailable(cmd: string): boolean {
  try {
    // where 会搜索 PATH，找不到返回非 0
    return spawnSync('where', [cmd], { stdio: 'ignore', shell: false }).status === 0;
  } catch {
    return false;
  }
}

/** 用 `which`/`command -v` 探测 unix 系统下某命令是否存在（返回绝对路径或 null） */
function whichUnix(cmd: string): string | null {
  try {
    // 优先用 which（多数系统都有），回退到 command -v（POSIX builtin）
    const r = spawnSync('which', [cmd], { stdio: 'pipe' });
    if (r.status === 0) {
      const p = (r.stdout?.toString() || '').split('\n')[0].trim();
      if (p) return p;
    }
    const r2 = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'pipe' });
    if (r2.status === 0) {
      const p = (r2.stdout?.toString() || '').trim();
      if (p) return p;
    }
  } catch {}
  return null;
}

/** 探测当前平台已安装的 shell 列表（用于设置页下拉） */
export function detectAvailableShells(): { id: string; label: string; path: string }[] {
  const list: { id: string; label: string; path: string }[] = [];
  if (process.platform === 'win32') {
    // Windows: cmd / powershell / pwsh（pwsh 需在 PATH 中）
    if (isShellAvailable('cmd.exe') || process.env.COMSPEC) {
      list.push({ id: 'cmd', label: 'cmd', path: process.env.COMSPEC || 'cmd.exe' });
    }
    if (isShellAvailable('powershell.exe')) {
      list.push({ id: 'powershell', label: 'PowerShell', path: 'powershell.exe' });
    }
    if (isShellAvailable('pwsh.exe')) {
      list.push({ id: 'pwsh', label: 'PowerShell 7 (pwsh)', path: 'pwsh.exe' });
    }
  } else {
    // Unix: 探测常见 shell
    const candidates = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh'];
    for (const c of candidates) {
      const p = whichUnix(c);
      if (p) list.push({ id: c, label: c, path: p });
    }
  }
  return list;
}

/** 校验 cwd：不存在或不可访问时回退到用户 home */
function resolveCwd(requested?: string): string {
  // 用 os.homedir()：Windows 没有 HOME 环境变量（只有 USERPROFILE），
  // 旧写法 HOME || cwd 在 Windows 上会退化成 app 的工作目录
  const home = os.homedir();
  if (!requested) return home;
  try {
    const resolved = path.resolve(requested);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return resolved;
  } catch {}
  return home;
}

export function registerTerminalIpc(ctx: TerminalContext) {
  const send = sender(ctx);

  // 创建终端实例
  ipcMain.handle(
    'pi:terminal:create',
    async (_e, opts?: { cwd?: string; cols?: number; rows?: number; shell?: string }) => {
      const cwd = resolveCwd(opts?.cwd || ctx.cwd);
      const id = `pty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 优先级：本次请求显式指定 > 启动期默认 > 平台自动探测
      const shell = resolveShell(opts?.shell || ctx.defaultShell);
      const cols = opts?.cols && opts.cols > 0 ? opts.cols : 80;
      const rows = opts?.rows && opts.rows > 0 ? opts.rows : 24;
      try {
        const proc = pty.spawn(shell, [], {
          name: 'xterm-color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
        });
        ptys.set(id, { proc, cwd });

        proc.onData((data) => {
          send(`pi:terminal:data:${id}`, data);
        });
        proc.onExit(({ exitCode }) => {
          send(`pi:terminal:exit:${id}`, exitCode);
          ptys.delete(id);
        });

        return { id, shell, cwd };
      } catch (err: any) {
        console.error('[terminal] create failed:', err);
        return { id: '', error: err?.message || 'create failed' };
      }
    }
  );

  // 写入数据
  ipcMain.handle('pi:terminal:write', async (_e, id: string, data: string) => {
    const entry = ptys.get(id);
    if (!entry) return false;
    entry.proc.write(data);
    return true;
  });

  // 调整尺寸
  ipcMain.handle('pi:terminal:resize', async (_e, id: string, cols: number, rows: number) => {
    const entry = ptys.get(id);
    if (!entry) return false;
    try {
      entry.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
      return true;
    } catch {
      return false;
    }
  });

  // 杀掉实例
  ipcMain.handle('pi:terminal:kill', async (_e, id: string) => {
    const entry = ptys.get(id);
    if (!entry) return false;
    try {
      entry.proc.kill();
    } catch {}
    ptys.delete(id);
    return true;
  });

  // 列出活跃实例 id（供调试/清理）
  ipcMain.handle('pi:terminal:list', async () => {
    return Array.from(ptys.keys());
  });

  // 探测当前平台可用的 shell（供设置页下拉选择）
  ipcMain.handle('pi:terminal:detectShells', async () => {
    return detectAvailableShells();
  });
}

/** 应用退出时清理所有 pty */
export function killAllTerminals() {
  for (const [, entry] of ptys) {
    try {
      entry.proc.kill();
    } catch {}
  }
  ptys.clear();
}
