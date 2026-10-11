import fs from 'fs';
import os from 'os';
import path from 'path';
import { t } from '../src/i18n/zh';

/** 目标是否位于 root 之内（root 自身算命中） */
function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** 校验真实文件位置；项目根目录自身可以是符号链接。仅用于已存在的读路径。 */
export function resolveProjectPath(cwd: string, input = '.'): string {
  const root = fs.realpathSync(cwd);
  const target = fs.realpathSync(path.resolve(cwd, input));
  if (!isInsideRoot(root, target)) {
    throw new Error(t.fileOutsideProject);
  }
  return target;
}

/** pi-desktop 配置目录名（~/.pi-desktop） */
const CONFIG_DIR_NAME = '.pi-desktop';
/**
 * 配置目录内的凭证文件：即使在只读白名单里也不允许读回渲染进程
 * （auth.json / models.json 存 API Key，mcp.json 可能含 MCP 服务端 token）。
 */
const SECRET_BASENAMES = new Set(['auth.json', 'models.json', 'mcp.json']);

export interface ReadablePathOptions {
  /** 家目录（仅测试注入，默认 os.homedir()） */
  home?: string;
  /** 追加的只读白名单根（内置技能目录、SkillLoader 报告的技能目录等） */
  extra?: readonly string[];
}

/**
 * 只读白名单根目录：技能等用户级资源不在项目目录内
 * （~/.agents/skills 由 SDK 自动加载，~/.pi-desktop/skills 由设置页管理，内置技能随安装包发布）。
 */
export function defaultReadonlyRoots(options: ReadablePathOptions = {}): string[] {
  const home = options.home ?? os.homedir();
  return [path.join(home, CONFIG_DIR_NAME), path.join(home, '.agents'), ...(options.extra ?? [])];
}

/** 是否落在 ~/.pi-desktop 根目录下的凭证文件（仅目录直接子文件，不含子目录同名文件） */
function isSecretInConfigDir(target: string, home: string): boolean {
  if (!SECRET_BASENAMES.has(path.basename(target))) return false;
  let configDir: string;
  try {
    configDir = fs.realpathSync(path.join(home, CONFIG_DIR_NAME));
  } catch {
    return false;
  }
  return path.dirname(target) === configDir;
}

/**
 * 解析「允许读取」的真实路径：项目目录内任意路径，或只读白名单根内（技能等用户级资源）。
 * 只用于读路径（pi:readFile / pi:listFiles）；写路径仍必须走 resolveProjectPath。
 * 凭证文件即使在白名单根内也拒绝，避免渲染进程读回 API Key。
 */
export function resolveReadablePath(
  cwd: string,
  input = '.',
  options: ReadablePathOptions = {}
): string {
  const target = fs.realpathSync(path.resolve(cwd, input));
  if (isSecretInConfigDir(target, options.home ?? os.homedir())) {
    throw new Error(t.fileOutsideProject);
  }
  for (const root of [cwd, ...defaultReadonlyRoots(options)]) {
    let realRoot: string;
    try {
      // 白名单根可能不存在（如从未使用过 ~/.agents）：跳过而不是报错
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (isInsideRoot(realRoot, target)) return target;
  }
  throw new Error(t.fileOutsideProject);
}

/** 目标是否位于项目目录内（cwd 解析为真实路径；cwd 不存在时退化为原字符串） */
export function isInsideProject(cwd: string, target: string): boolean {
  let root: string;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    root = cwd;
  }
  return isInsideRoot(root, target);
}
