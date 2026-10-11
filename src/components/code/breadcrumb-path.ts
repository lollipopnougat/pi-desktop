/**
 * 面包屑路径计算（纯函数，便于单测）。
 *
 * 打开的文件路径有两种来源：
 * - 项目内文件：相对 cwd（文件树点开）或绝对路径（项目内技能等）
 * - 项目外文件：绝对路径（`~/.agents/skills/**`、`~/.pi-desktop/skills/**`、内置技能目录）
 * 老实现一律按「相对 cwd」处理，项目外绝对路径会被前置一个 cwd 目录名 →
 * 显示成 `quhaibo5 > Users > quhaibo5 > .agents > ...`（重复一段）。
 */

export interface BreadcrumbSegment {
  /** 展示文本 */
  label: string;
  /**
   * 该段点击后弹出的 FileTree 根目录：
   * - `''`：项目根（cwd）
   * - 绝对路径：项目外目录（技能等）
   * - `null`：不可点击（该目录不在只读白名单内，无法列目录）
   */
  treeRoot: string | null;
  /** 传给 FileTree 的 expandToPath（项目内为相对 cwd，项目外为绝对路径） */
  expandToPath: string;
  /** 悬浮提示（项目外段显示完整绝对路径） */
  title?: string;
}

export interface BreadcrumbPathInfo {
  segments: BreadcrumbSegment[];
  /** 传给 FileTree 的 activePath（项目内为相对 cwd，项目外为绝对路径） */
  activePath: string;
}

/** 去掉末尾分隔符，并统一成正斜杠 */
function normalize(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isAbsoluteLike(input: string): boolean {
  return input.startsWith('/') || /^[A-Za-z]:[/\\]/.test(input);
}

/** target 是否在 root 之内（root 自身算命中；严格按路径段比较，避免 /a/b 命中 /a/bc） */
function isInside(root: string, target: string): boolean {
  if (!root) return false;
  return target === root || target.startsWith(`${root}/`);
}

/**
 * 计算面包屑路径段。
 * @param filePath 打开的文件路径（相对 cwd 或绝对路径）
 * @param cwd 当前工作目录
 * @param home 家目录（可空；为空时不把绝对路径缩写成 ~）
 */
export function computeBreadcrumbPath(
  filePath: string,
  cwd: string,
  home = ''
): BreadcrumbPathInfo {
  const target = normalize(filePath);
  const cwdNorm = normalize(cwd);
  const homeNorm = normalize(home);

  // 绝对路径且在项目之外 → 项目外分支（技能等用户级文件）
  const outside = isAbsoluteLike(target) && !isInside(cwdNorm, target);

  if (!outside) {
    // 项目内：一律按相对 cwd 展示；绝对路径先剥掉 cwd 前缀
    const relative = isAbsoluteLike(target) ? target.slice(cwdNorm.length + 1) : target;
    const rootName = cwdNorm.split('/').pop() || cwdNorm;
    const parts = relative.split('/').filter(Boolean);
    const segments: BreadcrumbSegment[] = [{ label: rootName, treeRoot: '', expandToPath: '' }];
    let acc = '';
    parts.forEach((part, index) => {
      acc = acc ? `${acc}/${part}` : part;
      segments.push({
        label: part,
        treeRoot: '',
        expandToPath: index === parts.length - 1 ? relative : acc
      });
    });
    return { segments, activePath: relative };
  }

  // 项目外：以 ~（家目录内）或 / 起头展示绝对路径；只有文件自身与其所在目录可点开目录树
  const items: { label: string; abs: string }[] = [];
  let anchor: string;
  if (homeNorm && isInside(homeNorm, target)) {
    items.push({ label: '~', abs: homeNorm });
    anchor = homeNorm;
  } else if (target.startsWith('/')) {
    items.push({ label: '/', abs: '/' });
    anchor = '';
  } else {
    // Windows 盘符（C:/...）
    const drive = target.split('/')[0];
    items.push({ label: drive, abs: drive });
    anchor = drive;
  }
  const head = items[0].abs;
  const rest = target.slice(head === '/' ? 1 : head.length).replace(/^\/+/, '');
  let abs = anchor;
  for (const part of rest.split('/').filter(Boolean)) {
    abs = abs ? `${abs}/${part}` : `/${part}`;
    items.push({ label: part, abs });
  }

  const dirAbs = items.length >= 2 ? items[items.length - 2].abs : items[0].abs;
  const segments = items.map((item, index) => {
    const isFile = index === items.length - 1;
    const isFileDir = index === items.length - 2;
    const clickable = isFile || isFileDir;
    return {
      label: item.label,
      treeRoot: clickable ? dirAbs : null,
      expandToPath: clickable ? (isFile ? target : item.abs) : '',
      title: shortenHomePath(target, homeNorm)
    };
  });
  return { segments, activePath: target };
}

/** 悬浮提示用：把绝对路径缩写成 ~/... */
export function shortenHomePath(absPath: string, home = ''): string {
  const target = normalize(absPath);
  const homeNorm = normalize(home);
  return homeNorm && isInside(homeNorm, target) ? `~${target.slice(homeNorm.length)}` : target;
}
