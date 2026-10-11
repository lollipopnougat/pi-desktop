import { ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { PiBridgeContext } from './types';

/** Skill IPC 需要的额外上下文 */
export interface SkillContext extends PiBridgeContext {
  readonly agentDir: string;
  /** 内置只读技能目录（随安装包发布），位于其下的技能禁止删除/写入 */
  readonly builtinSkillsDir: string;
  /** Electron BrowserWindow，用于弹窗 */
  readonly win: any;
}

/** 获取 ResourceLoader */
function getLoader(ctx: SkillContext): any | null {
  const session = ctx.getSession();
  return session.resourceLoader || session.agent?.state?.resourceLoader || null;
}

/** 判断 skill 是否为内置只读技能（位于 builtinSkillsDir 之下） */
function isBuiltinSkill(ctx: SkillContext, skill: any): boolean {
  const root = path.resolve(ctx.builtinSkillsDir);
  const base = path.resolve(skill.baseDir);
  return base === root || base.startsWith(root + path.sep);
}

/** 允许删除的 skills 根目录（全局 + 项目本地） */
function getAllowedSkillRoots(ctx: SkillContext): string[] {
  return [path.join(ctx.agentDir, 'skills'), path.join(ctx.cwd, '.pi', 'skills')];
}

/** 判断 skill 是否为根目录下的单个 .md 文件（非子目录） */
function isRootMdSkill(ctx: SkillContext, skill: any): boolean {
  const roots = getAllowedSkillRoots(ctx);
  return roots.some((r) => path.resolve(skill.baseDir) === path.resolve(r));
}

/** 解析 SKILL.md frontmatter，返回 { frontmatter, body } */
function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const fm: Record<string, any> = {};
  let body = content;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2] || '';
    for (const line of m[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val: any = trimmed.slice(idx + 1).trim();
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body };
}

/** 重写 SKILL.md，切换 disable-model-invocation 字段 */
function rewriteSkillDisableInvocation(content: string, disable: boolean): string {
  const { frontmatter, body } = parseSkillFrontmatter(content);
  frontmatter['disable-model-invocation'] = disable;
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

/**
 * 注册 Skill 管理相关 IPC：
 * getSkills / readSkillFile / writeSkillFile / deleteSkill / toggleSkill
 */
export function registerSkillIpc(ctx: SkillContext) {
  /** 强制重新加载技能资源（重新扫描技能目录），返回最新技能列表 */
  ipcMain.handle('pi:reloadSkills', async () => {
    const loader = getLoader(ctx);
    if (!loader) return { skills: [], diagnostics: [] };
    try {
      await loader.reload?.();
      const { skills, diagnostics } = loader.getSkills();
      return {
        skills: (skills || []).map((s: any) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          baseDir: s.baseDir,
          scope: s.sourceInfo?.scope,
          source: s.sourceInfo?.source,
          origin: s.sourceInfo?.origin,
          disableModelInvocation: !!s.disableModelInvocation,
          builtin: isBuiltinSkill(ctx, s)
        })),
        diagnostics: diagnostics || []
      };
    } catch {
      return { skills: [], diagnostics: [] };
    }
  });

  ipcMain.handle('pi:getSkills', async () => {
    const loader = getLoader(ctx);
    if (!loader) return { skills: [], diagnostics: [] };
    try {
      const { skills, diagnostics } = loader.getSkills();
      // 设置页只管理全局技能（user/shared/builtin），项目级技能（<cwd>/.pi-desktop/skills、
      // <cwd>/.pi/skills）不在此管理，通过代码面板直接编辑。
      const projectSkillRoots = [
        path.resolve(ctx.cwd, '.pi-desktop', 'skills') + path.sep,
        path.resolve(ctx.cwd, '.pi', 'skills') + path.sep
      ];
      const isProjectSkill = (s: any) =>
        projectSkillRoots.some((r) => path.resolve(s.filePath).startsWith(r));
      return {
        skills: (skills || [])
          .filter((s: any) => !isProjectSkill(s))
          .map((s: any) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            baseDir: s.baseDir,
            scope: s.sourceInfo?.scope,
            source: s.sourceInfo?.source,
            origin: s.sourceInfo?.origin,
            disableModelInvocation: !!s.disableModelInvocation,
            // 内置技能只读：随安装包发布，不允许删除/写入/隐藏
            builtin: isBuiltinSkill(ctx, s)
          })),
        diagnostics: diagnostics || []
      };
    } catch {
      return { skills: [], diagnostics: [] };
    }
  });

  /**
   * 获取项目级技能列表（仅在项目属性弹窗使用）。
   * 项目级技能位于 <cwd>/.pi-desktop/skills 和 <cwd>/.agents/skills 之下。
   */
  ipcMain.handle('pi:getProjectSkills', async (_e, targetCwd?: string) => {
    const skillCwd = targetCwd || ctx.cwd;
    const loader = getLoader(ctx);
    if (!loader) return { skills: [], diagnostics: [] };
    try {
      const { skills, diagnostics } = loader.getSkills();
      const projectSkillRoots = [
        path.resolve(skillCwd, '.pi-desktop', 'skills') + path.sep,
        path.resolve(skillCwd, '.agents', 'skills') + path.sep
      ];
      const isProjectSkill = (s: any) =>
        projectSkillRoots.some((r) => path.resolve(s.filePath).startsWith(r));
      return {
        skills: (skills || [])
          .filter((s: any) => isProjectSkill(s))
          .map((s: any) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            baseDir: s.baseDir,
            scope: 'project' as const,
            disableModelInvocation: !!s.disableModelInvocation,
            builtin: false
          })),
        diagnostics: diagnostics || []
      };
    } catch {
      return { skills: [], diagnostics: [] };
    }
  });

  ipcMain.handle('pi:readSkillFile', async (_e, skillName: string) => {
    const loader = getLoader(ctx);
    if (!loader) throw new Error('loader unavailable');
    const { skills } = loader.getSkills();
    const s = (skills || []).find((x: any) => x.name === skillName);
    if (!s) throw new Error(`skill not found: ${skillName}`);
    // 内置技能可查看（只读），但不允许写入/删除/隐藏——见 writeSkillFile/deleteSkill/toggleSkill
    const content = fs.readFileSync(s.filePath, 'utf-8');
    return { path: s.filePath, baseDir: s.baseDir, content };
  });

  ipcMain.handle('pi:writeSkillFile', async (_e, skillName: string, content: string) => {
    const loader = getLoader(ctx);
    if (!loader) throw new Error('loader unavailable');
    const { skills } = loader.getSkills();
    const s = (skills || []).find((x: any) => x.name === skillName);
    if (!s) throw new Error(`skill not found: ${skillName}`);
    if (isBuiltinSkill(ctx, s)) throw new Error('builtin skill is read-only');
    fs.writeFileSync(s.filePath, content, 'utf-8');
    try {
      await loader.reload?.();
    } catch {}
    return { ok: true };
  });

  ipcMain.handle('pi:deleteSkill', async (_e, skillName: string) => {
    const loader = getLoader(ctx);
    if (!loader) throw new Error('loader unavailable');
    const { skills } = loader.getSkills();
    const s = (skills || []).find((x: any) => x.name === skillName);
    if (!s) throw new Error(`skill not found: ${skillName}`);
    if (isBuiltinSkill(ctx, s)) throw new Error('builtin skill is read-only');

    const roots = getAllowedSkillRoots(ctx);
    const isRootMd = isRootMdSkill(ctx, s);
    const target = isRootMd ? s.filePath : s.baseDir;
    const resolved = path.resolve(target);

    const allowed = isRootMd
      ? roots.some(
          (r) =>
            resolved === path.resolve(r, path.basename(resolved)) &&
            path.dirname(resolved) === path.resolve(r)
        )
      : roots.some(
          (r) => resolved === path.resolve(r) || resolved.startsWith(path.resolve(r) + path.sep)
        );
    if (!allowed) {
      throw new Error('refuse to delete skill outside skills directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    try {
      await loader.reload?.();
    } catch {}
    return { ok: true };
  });

  ipcMain.handle('pi:toggleSkill', async (_e, skillName: string, disable: boolean) => {
    const loader = getLoader(ctx);
    if (!loader) throw new Error('loader unavailable');
    const { skills } = loader.getSkills();
    const s = (skills || []).find((x: any) => x.name === skillName);
    if (!s) throw new Error(`skill not found: ${skillName}`);
    if (isBuiltinSkill(ctx, s)) throw new Error('builtin skill is read-only');
    const content = fs.readFileSync(s.filePath, 'utf-8');
    const newContent = rewriteSkillDisableInvocation(content, disable);
    fs.writeFileSync(s.filePath, newContent, 'utf-8');
    try {
      await loader.reload?.();
    } catch {}
    return { ok: true, disableModelInvocation: disable };
  });

  /**
   * 校验一个目录是否为合法的 pi 技能目录：
   * - 存在 SKILL.md
   * - frontmatter 含 name（^[a-z0-9-]+$，无首尾/连续连字符，≤64）与 description（非空，≤1024，无尖括号）
   * 返回 { valid, error?, name? }。
   */
  function validateSkillDir(dir: string): { valid: boolean; error?: string; name?: string } {
    const skillMdPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return { valid: false, error: '目录缺少 SKILL.md 文件' };
    }
    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch (e: any) {
      return { valid: false, error: `读取 SKILL.md 失败: ${e?.message ?? e}` };
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    const name = frontmatter.name;
    const description = frontmatter.description;
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'SKILL.md frontmatter 缺少 name 字段' };
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      return { valid: false, error: `name「${name}」只能包含小写字母、数字、连字符` };
    }
    if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
      return { valid: false, error: `name「${name}」不能以连字符开头/结尾或包含连续连字符` };
    }
    if (name.length > 64) {
      return { valid: false, error: `name 超过 64 字符` };
    }
    if (!description || typeof description !== 'string' || description.trim() === '') {
      return { valid: false, error: 'SKILL.md frontmatter 缺少 description 字段' };
    }
    if (description.length > 1024) {
      return { valid: false, error: `description 超过 1024 字符` };
    }
    if (/[<>]/.test(description)) {
      return { valid: false, error: 'description 不能包含尖括号 < 或 >' };
    }
    return { valid: true, name };
  }

  /** 递归复制目录 */
  function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirRecursive(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
      }
    }
  }

  /** 技能导入目标目录：全局或项目级（projectCwd 给定时） */
  function importTargets(projectCwd?: string) {
    if (projectCwd) {
      return {
        agents: path.join(projectCwd, '.agents', 'skills'),
        desktop: path.join(projectCwd, '.pi-desktop', 'skills'),
        agentsLabel: `<cwd>/.agents/skills`,
        desktopLabel: `<cwd>/.pi-desktop/skills`,
        agentsDetail: `跨工具共享（pi CLI / pi-desktop / codex / cursor 均可用）`,
        desktopDetail: `仅 pi-desktop 使用`
      };
    }
    return {
      agents: path.join(os.homedir(), '.agents', 'skills'),
      desktop: path.join(ctx.agentDir, 'skills'),
      agentsLabel: '~/.agents/skills',
      desktopLabel: '~/.pi-desktop/skills',
      agentsDetail: `跨工具共享（pi CLI / pi-desktop / codex / cursor 均可用）`,
      desktopDetail: `仅 pi-desktop 使用`
    };
  }

  /**
   * 导入技能：校验源目录、弹窗选择目标、复制。
   * - sourceDir: 已解压/选定的技能目录（含 SKILL.md）
   * - projectCwd: 给定时导入到项目级目录（<cwd>/.agents/skills 或 <cwd>/.pi-desktop/skills）
   * 返回 { ok, name, target } 或抛错。
   */
  async function importSkillFromDir(
    sourceDir: string,
    projectCwd?: string
  ): Promise<{ ok: boolean; name: string; target: string }> {
    const result = validateSkillDir(sourceDir);
    if (!result.valid || !result.name) {
      throw new Error(result.error || '不是合法的技能目录');
    }
    const skillName = result.name;
    if (!ctx.win) {
      throw new Error('window unavailable');
    }

    const T = importTargets(projectCwd);
    // 选择导入目标
    const choice = await dialog.showMessageBox(ctx.win, {
      type: 'question',
      title: '选择技能存放位置',
      message: `将技能「${skillName}」导入到哪个目录？`,
      detail: `• ${T.agentsLabel} — ${T.agentsDetail}\n• ${T.desktopLabel} — ${T.desktopDetail}`,
      buttons: [T.agentsLabel, T.desktopLabel, '取消'],
      defaultId: 0,
      cancelId: 2
    });
    if (choice.response === 2 || choice.response === -1) {
      return { ok: false, name: skillName, target: '' };
    }
    const targetRoot = choice.response === 0 ? T.agents : T.desktop;
    const targetDir = path.join(targetRoot, skillName);

    // 同名技能已存在则确认覆盖
    if (fs.existsSync(targetDir)) {
      const overwrite = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        title: '技能已存在',
        message: `目标目录已存在同名技能「${skillName}」`,
        detail: `路径: ${targetDir}\n是否覆盖？`,
        buttons: ['覆盖', '取消'],
        defaultId: 1,
        cancelId: 1
      });
      if (overwrite.response === 1) {
        return { ok: false, name: skillName, target: '' };
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    fs.mkdirSync(targetRoot, { recursive: true });
    copyDirRecursive(sourceDir, targetDir);

    // 重新加载技能
    try {
      const loader = getLoader(ctx);
      await loader?.reload?.();
    } catch {}
    return { ok: true, name: skillName, target: targetDir };
  }

  /** 从技能目录导入（全局） */
  ipcMain.handle('pi:importSkillFromDir', async (_e, sourceDir: string) => {
    return importSkillFromDir(sourceDir);
  });

  /** 从技能目录导入（项目级，目标 <cwd>/.agents/skills 或 <cwd>/.pi-desktop/skills） */
  ipcMain.handle(
    'pi:importProjectSkillFromDir',
    async (_e, sourceDir: string, projectCwd: string) => {
      return importSkillFromDir(sourceDir, projectCwd);
    }
  );

  /** 从技能 zip 导入（全局） */
  ipcMain.handle('pi:importSkillFromZip', async (_e, zipPath: string) => {
    const { app } = await import('electron');
    const tmpDir = path.join(app.getPath('temp'), `pi-skill-import-${Date.now()}`);
    // 优先用系统 unzip，回退到 app.asar 内的解压逻辑（这里用 child_process）
    const { execFileSync } = await import('child_process');
    try {
      // macOS / Linux 用 unzip，Windows 用 PowerShell Expand-Archive
      if (process.platform === 'win32') {
        execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`
          ],
          { stdio: 'ignore' }
        );
      } else {
        execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'ignore' });
      }
    } catch (e: any) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`解压失败: ${e?.message ?? e}`);
    }

    // zip 可能把技能放在根目录或嵌套一层。查找含 SKILL.md 的目录。
    let skillDir = tmpDir;
    if (!fs.existsSync(path.join(tmpDir, 'SKILL.md'))) {
      const subdirs = fs
        .readdirSync(tmpDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      const found = subdirs.find((d) => fs.existsSync(path.join(tmpDir, d.name, 'SKILL.md')));
      if (found) {
        skillDir = path.join(tmpDir, found.name);
      } else {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error('zip 中未找到包含 SKILL.md 的技能目录');
      }
    }

    const result = await importSkillFromDir(skillDir);
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  });

  /** 从技能 zip 导入（项目级） */
  ipcMain.handle(
    'pi:importProjectSkillFromZip',
    async (_e, zipPath: string, projectCwd: string) => {
      const { app } = await import('electron');
      const tmpDir = path.join(app.getPath('temp'), `pi-skill-import-${Date.now()}`);
      const { execFileSync } = await import('child_process');
      try {
        if (process.platform === 'win32') {
          execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`
            ],
            { stdio: 'ignore' }
          );
        } else {
          execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'ignore' });
        }
      } catch (e: any) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`解压失败: ${e?.message ?? e}`);
      }
      let skillDir = tmpDir;
      if (!fs.existsSync(path.join(tmpDir, 'SKILL.md'))) {
        const subdirs = fs
          .readdirSync(tmpDir, { withFileTypes: true })
          .filter((e) => e.isDirectory());
        const found = subdirs.find((d) => fs.existsSync(path.join(tmpDir, d.name, 'SKILL.md')));
        if (found) {
          skillDir = path.join(tmpDir, found.name);
        } else {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          throw new Error('zip 中未找到包含 SKILL.md 的技能目录');
        }
      }
      const result = await importSkillFromDir(skillDir, projectCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return result;
    }
  );
}
