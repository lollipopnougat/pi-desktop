/**
 * Git 分支 IPC：检测 git 安装、读取当前分支/分支列表、切换分支。
 *
 * 用 execFile 调用系统 git（renderer 禁 nodeIntegration，全部经主进程）：
 * - getGitStatus: { installed, isRepo, currentBranch, error? }
 * - getGitBranches: { installed, isRepo, branches: [{name, current}], error? }
 * - switchGitBranch: { ok, error? }
 */
import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import path from 'path';
import type { PiBridgeContext } from './types';

/** 带 5s 超时执行 git 命令 */
function git(
  args: string[],
  cwd: string
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          const code = (err as any)?.code;
          // code 128 = git 仓库错误（非 repo 等）；ENOENT = git 未安装
          resolve({
            ok: false,
            error: code === 'ENOENT' ? 'git-not-installed' : String((err as any)?.message || err)
          });
        } else {
          resolve({ ok: true, stdout: stdout || '' });
        }
      });
    } catch (err: any) {
      resolve({ ok: false, error: String(err?.message || err) });
    }
  });
}

/** 探测 git 是否安装（git --version，任意 cwd 均可） */
function isGitInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['--version'], { timeout: 3000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

export function registerGitIpc(ctx: PiBridgeContext) {
  /** 解析探测目录：优先用渲染层传入的会话 cwd（加载历史会话可能是其他项目），
   *  回退主进程 runtime cwd */
  const resolveCwd = (input?: string): string => {
    if (typeof input === 'string' && input.trim() && input !== '/') return input;
    return ctx.cwd;
  };

  ipcMain.handle('pi:gitStatus', async (_e, cwdInput?: string) => {
    const cwd = resolveCwd(cwdInput);
    const installed = await isGitInstalled();
    if (!installed) return { installed: false, isRepo: false, currentBranch: null };
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!r.ok) return { installed: true, isRepo: false, currentBranch: null };
    return { installed: true, isRepo: true, currentBranch: r.stdout.trim() || null };
  });

  ipcMain.handle('pi:gitBranches', async (_e, cwdInput?: string) => {
    const cwd = resolveCwd(cwdInput);
    const installed = await isGitInstalled();
    if (!installed) return { installed: false, isRepo: false, branches: [] };
    // --format 含 HEAD 指向，过滤 HEAD 游标行；本地分支即可（远程分支切换需先 fetch，UI 保持简单）
    const r = await git(['branch', '--format=%(refname:short)%09%(HEAD)'], cwd);
    if (!r.ok) return { installed: true, isRepo: false, branches: [] };
    const branches = r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, headMark] = line.split('\t');
        return { name, current: headMark === '*' };
      });
    return { installed: true, isRepo: true, branches };
  });

  ipcMain.handle('pi:gitSwitchBranch', async (_e, branch: string, cwdInput?: string) => {
    const cwd = resolveCwd(cwdInput);
    if (typeof branch !== 'string' || !branch.trim() || /[\s`$;&|]/.test(branch)) {
      return { ok: false, error: 'invalid branch name' };
    }
    const r = await git(['checkout', branch.trim()], cwd);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true };
  });
}
