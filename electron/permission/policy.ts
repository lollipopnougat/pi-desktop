/**
 * 权限沙箱策略与安全分类器（纯函数，无 IO）。
 *
 * 四种策略（参考 pi-permission-system 的三态权限模型简化而来）：
 * - ask-all:        每条指令均审批 — 所有工具调用都弹审批面板
 * - auto-safe:      自动审批安全指令 — 只读工具 + 白名单 bash 命令自动放行，其余审批
 * - classifier-auto: 决策模型自动审批 — 每次调用先交模型，安全且置信度达标才自动放行，
 *                   危险、不确定或判定失败时人工审批；白名单与会话授权均不短路模型判定，
 *                   唯一例外是用户显式开启的「默认放行工作目录写入」（allowWriteInCwd）
 * - allow-all:      允许所有指令 — 全部放行不审批（yolo）
 *
 * 安全分类器只回答一个问题：这条工具调用在 auto-safe 策略下是否可自动放行。
 * 判定是保守的：解析不了的、含包装/危险结构的命令一律视为不安全（fail-closed）。
 *
 * 为判定「write/edit 目标是否在工作目录内」，本模块需要读取符号链接解析结果（node:fs），
 * 其余部分均为纯函数；IO 失败一律回退为「不放行」而不抛错。
 *
 * 危险命令检测（isDangerousBashCommand）：
 * 在 ask-all / auto-safe 中优先于会话授权和白名单，命中后直接请求人工审批。
 * classifier-auto 每次先由模型判定，危险规则仅用于人工审批面板的风险提示。
 * allow-all 是用户明确选择的全部放行模式，不经过本检测。
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** 权限策略 */
export type PermissionPolicy = 'ask-all' | 'auto-safe' | 'classifier-auto' | 'allow-all';

export const PERMISSION_POLICIES: PermissionPolicy[] = [
  'ask-all',
  'auto-safe',
  'classifier-auto',
  'allow-all'
];

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = 'auto-safe';

/** 校验任意值为合法策略（loadUiSettings / IPC 输入防抖） */
export function isPermissionPolicy(v: unknown): v is PermissionPolicy {
  return v === 'ask-all' || v === 'auto-safe' || v === 'classifier-auto' || v === 'allow-all';
}

/** 安全工具白名单（auto-safe 下自动放行的只读、交互与流程工具）
 *
 * SDK 内置只读工具 + 本项目交互与流程工具：
 * - ask：向用户提问，纯交互（用户本身就是审批权威）
 * - update_plan：只更新前端 Todo 面板内存状态
 * - read_img：读图片文件 + 调视觉模型生成描述（只读，消耗少量 token）
 * - web_search：内置免 Key 网络搜索（只读，仅向外发查询词，不改本地任何东西）
 * - memory_search / session_search / session_read：检索持久记忆与历史会话（只读）
 * - goal_complete/goal_blocked：目标状态上报，仍由 goal runtime 校验
 * - propose_plan：进入独立的方案审批流程，避免重复工具审批
 * 不含：memory_save/update/remove（写操作）、mcp（op=call 可任意外部调用）
 */
export const SAFE_TOOL_NAMES = new Set([
  // SDK 内置只读
  'read',
  'grep',
  'find',
  'ls',
  // 项目内置只读、交互与流程工具
  'ask',
  'update_plan',
  'read_img',
  'web_search',
  'memory_search',
  'memory_read',
  'session_search',
  'session_read',
  'goal_complete',
  'goal_blocked',
  'propose_plan'
]);

/**
 * bash 安全命令白名单（前缀匹配，首个 token 起算）。
 * 命中前缀后仍需校验 shell 结构与 env/git 等命令参数，不能仅凭名称认定只读。
 */
export const SAFE_BASH_PREFIXES: string[] = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'head',
  'tail',
  'wc',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'date',
  'whoami',
  'uname',
  'env',
  'printenv',
  'basename',
  'dirname',
  'realpath',
  'md5sum',
  'shasum',
  'sha256sum',
  // git 只读子命令
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git remote',
  'git tag',
  'git rev-parse',
  'git ls-files',
  'git blame',
  'git shortlog',
  'git describe'
];

/** 危险包装/逃逸命令：出现在首 token 即不安全（无论后续参数） */
const UNSAFE_WRAPPERS = new Set([
  'sudo',
  'doas',
  'eval',
  'source',
  '.',
  'exec',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'watch',
  'parallel',
  'setsid',
  'flock',
  'time'
]);

/** shell 解释器：`bash -c` / `sh script.sh` 等不透明载荷，一律审批 */
const SHELL_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'node',
  'python',
  'python3',
  'perl',
  'ruby',
  'osascript'
]);

/** 自动审批配置：安全工具 + bash 命令白名单（设置页可自定义，内置于默认值之上追加）
 *
 * 除白名单外，auto-safe 还会自动放行**工作目录内的 write / edit**
 * （见 isSafeWriteInCwd：.git/.ssh 等敏感目录、符号链接逃逸、家目录不算项目目录）。
 */
export interface AutoSafeConfig {
  /** 追加的安全工具名（内置 read/grep/find/ls 之上） */
  safeTools?: string[];
  /** 追加的 bash 安全命令前缀（内置白名单之上） */
  safeBashCommands?: string[];
}

/** 决策模型自动审批（classifier-auto）配置：模型不可用/超时/判定不达标时一律回退人工审批 */
export interface ClassifierApprovalConfig {
  /** 决策模型所属 provider（~/.pi-desktop/classifiers.json 里的 key 或内置 classifier provider） */
  providerId?: string;
  /** 决策模型 id */
  modelId?: string;
  /** 单次判定超时（毫秒） */
  timeoutMs?: number;
  /** 自动放行所需的最低置信度（0~1） */
  minConfidence?: number;
  /**
   * 默认放行工作目录写入：开启后 write / edit 且目标在当前工作目录内的调用直接放行，
   * 不再请求决策模型判定（判定所需参数会被截断的常见场景）；关闭（默认）时照旧逐次判定。
   * 判定复用 auto-safe 的 isSafeWriteInCwd：敏感目录（.git/.ssh 等）、家目录、
   * 符号链接逃逸出工作目录的目标仍会交给人工审批。
   */
  allowWriteInCwd?: boolean;
}

/** 判定超时边界（默认 8s：本地 llama.cpp 一次 logprobs 打分通常在百毫秒级） */
export const CLASSIFIER_TIMEOUT_MIN_MS = 500;
export const CLASSIFIER_TIMEOUT_MAX_MS = 60000;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 8000;
/** 自动放行所需的最低置信度默认值（偏保守：宁多问一次） */
export const DEFAULT_CLASSIFIER_MIN_CONFIDENCE = 0.7;

function clampNumber(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, v));
}

/**
 * 归一化决策模型审批配置（IPC / ui-config.json 输入防抖）。
 * providerId / modelId 必须是成对的非空字符串，否则整对丢弃
 * （半配置没有意义：只会让闸门每次都走"模型不可用"回退，白等一次超时）。
 */
export function normalizeClassifierApprovalConfig(v: unknown): ClassifierApprovalConfig {
  if (!v || typeof v !== 'object') return {};
  const raw = v as ClassifierApprovalConfig;
  const out: ClassifierApprovalConfig = {};
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (providerId && modelId) {
    out.providerId = providerId;
    out.modelId = modelId;
  }
  const timeoutMs = clampNumber(
    raw.timeoutMs,
    CLASSIFIER_TIMEOUT_MIN_MS,
    CLASSIFIER_TIMEOUT_MAX_MS
  );
  if (timeoutMs !== undefined) out.timeoutMs = Math.round(timeoutMs);
  const minConfidence = clampNumber(raw.minConfidence, 0, 1);
  if (minConfidence !== undefined) out.minConfidence = minConfidence;
  if (typeof raw.allowWriteInCwd === 'boolean') out.allowWriteInCwd = raw.allowWriteInCwd;
  return out;
}

/** 归一化白名单条目：去首尾空白、过滤空串 */
function normalizeList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 合并内置白名单与用户自定义白名单（去重，用户条目优先匹配） */
export function effectiveBashPrefixes(extra?: string[]): string[] {
  const user = normalizeList(extra);
  if (user.length === 0) return SAFE_BASH_PREFIXES;
  return [...new Set([...user, ...SAFE_BASH_PREFIXES])];
}
/**
 * 把复合命令拆为命令单元（按 && || ; | 和换行切分）。
 * 不解析引号内的分隔符；拆出的不完整引号会被 tokenizeSafeBashUnit 拒绝。
 */
export function splitCommandUnits(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 仅解析字面参数与完整引号。展开、转义、重定向、后台执行等结构回退审批，
 * 不尝试模拟 shell；引号中的普通空格与 > 等字面字符可以保留。
 */
function tokenizeSafeBashUnit(unit: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: string | null = null;
  for (const char of unit) {
    // 即使位于引号内也保守拒绝展开/转义，避免 quote removal 后改变参数语义。
    if (char === '$' || char === '`' || char === '\\' || (char < ' ' && char !== '\t')) {
      return null;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === ' ' || char === '\t') {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      // 不支持 glob/花括号展开、注释和控制运算符，不能把它们当普通参数忽略。
      if ('<>&;|(){}*?[]#'.includes(char)) return null;
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

/** branch/tag 同时支持读写：只放行明确的列表形式，未知选项一律审批。 */
function isSafeGitRefQuery(subcommand: 'branch' | 'tag', args: string[]): boolean {
  let listMode = args.length === 0;
  for (const arg of args) {
    if (arg === '--list' || arg === '-l') {
      listMode = true;
      continue;
    }
    if (
      subcommand === 'branch' &&
      /^(?:-[arv]+|--all|--remotes|--show-current|--verbose)$/.test(arg)
    ) {
      continue;
    }
    if (subcommand === 'tag' && /^-n\d*$/.test(arg)) continue;
    if (!listMode || arg.startsWith('-')) return false;
  }
  return true;
}

/** Git 的读写混合子命令与可写文件/执行程序的参数需单独校验。 */
function isSafeGitCommand(args: string[]): boolean {
  const [subcommand, ...rest] = args;
  if (!SAFE_BASH_PREFIXES.includes(`git ${subcommand}`)) return false;
  // 保守覆盖长选项缩写；不能通过 --out= 等形式绕过参数检查。
  if (rest.some((arg) => isLongOption(arg, ['--output', '--ext-diff', '--textconv']))) return false;
  if (subcommand === 'branch' || subcommand === 'tag') {
    return isSafeGitRefQuery(subcommand, rest);
  }
  if (subcommand === 'remote') {
    if (rest.every((arg) => arg === '-v' || arg === '--verbose')) return true;
    // get-url 只查本地配置；show 默认可能联网，因此仅支持 show -n。
    if (rest[0] === 'get-url') {
      const names = rest.slice(1).filter((arg) => !['--push', '--all'].includes(arg));
      return names.length === 1 && names[0].length > 0 && !names[0].startsWith('-');
    }
    return rest.length === 3 && rest[0] === 'show' && rest[1] === '-n' && !rest[2].startsWith('-');
  }
  return true;
}

function isLongOption(arg: string, options: string[]): boolean {
  const option = arg.split('=', 1)[0];
  return (
    option.startsWith('--') && option.length > 2 && options.some((name) => name.startsWith(option))
  );
}

/** 判断一个命令单元：先校验结构、包装与参数，再匹配内置/自定义前缀。 */
export function isSafeBashUnit(unit: string, extraPrefixes?: string[]): boolean {
  const tokens = tokenizeSafeBashUnit(unit);
  if (!tokens?.length) return false;
  const [first, ...args] = tokens;

  // 赋值前缀可能改变 PATH、动态加载器或 Git 配置，不能剥掉后按原命令放行。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false;
  if (UNSAFE_WRAPPERS.has(first) || SHELL_INTERPRETERS.has(first)) {
    return false;
  }

  // env 只有打印环境变量的形式只读，不能把 env 后的程序当作普通参数。
  if (first === 'env') return args.every((arg) => arg === '-0' || arg === '--null');
  if (first === 'git') return isSafeGitCommand(args);
  // date 可设置系统时间，file 可编译并写入 magic 数据库。
  if (first === 'date') {
    return args.every((arg) => arg === '-u' || arg === '--utc' || arg.startsWith('+'));
  }
  if (
    first === 'file' &&
    args.some((arg) => /^-[^-]*C/.test(arg) || isLongOption(arg, ['--compile']))
  ) {
    return false;
  }

  // 按 token 比较多词前缀，不能把带空格的单个可执行文件名视为多个命令参数。
  const prefixes = effectiveBashPrefixes(extraPrefixes);
  return prefixes.some((prefix) =>
    prefix.split(/\s+/).every((token, index) => tokens[index] === token)
  );
}

/** 整条 bash 命令是否安全：所有单元都安全才安全 */
export function isSafeBashCommand(command: string, extraPrefixes?: string[]): boolean {
  if (checkDangerousBashCommand(command)) return false;
  const units = splitCommandUnits(command);
  if (units.length === 0) return false;
  return units.every((u) => isSafeBashUnit(u, extraPrefixes));
}

/**
 * ============================ 危险命令检测（denylist） ============================
 *
 * 在 ask-all / auto-safe 中优先于自动放行规则；classifier-auto 仅用其生成风险提示。判定原则：
 * - 只拦「不可逆 / 毁灭性」操作：rm -rf、磁盘级写入、格式化、shred、fork 炸弹、sudo 提权等；
 * - 这是有限的危险模式检测，不代替 shell 沙箱；未命中不等于安全；
 * - ask-all / auto-safe 命中 denylist → 弹审批（不是禁止），用户保留最终决定权。
 *
 * 设计上与 isSafeBashCommand 的白名单互补：白名单决定「无需问」，denylist 决定「必须问」。
 */

/** 危险命令分类：用于审批面板的提示文案（渲染进程据 category 显示风险说明） */
export type DangerousBashCategory =
  | 'destructive-remove' // rm -rf / unlink 等批量不可逆删除
  | 'disk-write' // dd/mkfs/diskutil 等磁盘级覆写/格式化
  | 'privilege-escalation' // sudo/doas 提权执行
  | 'shell-escape' // bash -c / eval / source 等不透明载荷
  | 'self-modify' // fork 炸弹 / chmod -R 777 等自毁式操作
  | 'unknown'; // 其余被 denylist 结构性拦截的形态

/** 危险命令检测结果 */
export interface DangerousBashCheck {
  dangerous: boolean;
  category: DangerousBashCategory;
  /** 命中的规则说明（展示给用户的风险描述） */
  reason: string;
}

/** 危险检测的宽松度（预留：后续设置页可配） */
export interface DangerousBashConfig {
  /** 额外的危险命令前缀（追加到内置 denylist 之上） */
  extraDangerousPrefixes?: string[];
  // 预留：strict 模式会把 mv/chmod 等有损操作也纳入
  // level?: 'standard' | 'strict';
}

/**
 * 内置危险命令 denylist。两层结构：
 *
 * 1. COMMAND_RULES（单元级，锚定命令位）：作用于单个命令单元剥掉 VAR=/sudo 前缀后的
 *    首个 token（命令名）。只匹配命令名本身，不看参数 —— 参数不管是什么，这个命令
 *    本身就具有毁灭潜力（dd 任意形态、sudo 提权、格式化等）。
 * 2. UNIT_REGEX_RULES（单元级，参数敏感）：作用于单个命令单元的完整文本，
 *    需要结合参数判断（rm -rf、git push --force、chmod -R 777 等）。
 * 3. FULL_COMMAND_RULES（整命令级）：跨管道/跨单元的形态，拆单元后会失配
 *    （curl | sh 远程代码执行、fork 炸弹、> /dev/sda 重定向），在整条命令文本上匹配。
 *
 * 所有正则的命令位都用 (^|[\s;&|(]) 锚定，避免误匹配路径中含同名子串
 * （如 /usr/bin/format 或文件名 shredder）。
 */
const DANGEROUS_COMMAND_NAMES: { category: DangerousBashCategory; name: RegExp }[] = [
  // dd：磁盘/设备级覆写（任意 dd 参数形态都有毁灭潜力）
  { category: 'disk-write', name: /dd/ },
  // 格式化/分区/覆写工具
  {
    category: 'disk-write',
    name: /mkfs(\.[a-z0-9]+)?|diskutil|fdisk|parted|gparted|shred/
  },
  // 系统电源/进程批量操作
  { category: 'self-modify', name: /shutdown|reboot|halt|poweroff|killall|pkill/ }
];

/** 单元级参数敏感规则（作用于剥前缀后的完整单元文本） */
const DANGEROUS_UNIT_RULES: { category: DangerousBashCategory; pattern: RegExp }[] = [
  // rm：递归(-r/-R/--recursive)或强制(-f)删除。裸 rm 不拦（误报多）。
  // 匹配 rm 后跟短选项簇内含 r 或 f 的形态
  {
    category: 'destructive-remove',
    pattern: /(^|[\s;&|(])rm\s+(-\w*[rRfF]\w*\s|--recursive\b|--force\b)/
  },
  // rmdir 通配符批量删除
  { category: 'destructive-remove', pattern: /(^|[\s;&|(])rmdir\s+[^&|;]*\*/ },
  // git push --force / -f：覆写远端历史
  {
    category: 'self-modify',
    pattern: /(^|[\s;&|(])git\s+push\s+[^;]*(-f\b|--force\b)/
  },
  // git reset --hard：丢弃工作区/提交不可逆
  { category: 'self-modify', pattern: /(^|[\s;&|(])git\s+reset\s+[^;]*--hard\b/ },
  // git clean -fd/-df：批量删除未跟踪文件
  { category: 'self-modify', pattern: /(^|[\s;&|(])git\s+clean\s+[^;]*-[a-zA-Z]*[fd]/ },
  // chmod -R 递归改权限（含 777/000 全开全关；普通 chmod 644 file 不拦：要求 -R 选项）
  {
    category: 'self-modify',
    pattern: /(^|[\s;&|(])chmod\s+(-\w*R\w*\s+|--recursive\s+)[^;]*/
  },
  // kill -9：强杀进程（裸 kill 不拦）
  { category: 'self-modify', pattern: /(^|[\s;&|(])kill\s+(-\w*9\w*\s|-[a-zA-Z]*KILL\b)/ },
  // mv/cp 覆盖系统关键目录
  {
    category: 'destructive-remove',
    pattern: /(^|[\s;&|(])(mv|cp)\s+[^;]*\s+\/(etc|usr|bin|sbin|boot|System|Library)(\/|\s|$)/i
  },
  // curl/wget 直接管道进 sh/bash（单元内直接相连的形态；跨单元的由整命令规则呑底）
  {
    category: 'shell-escape',
    pattern: /(^|[\s;&|(])(curl|wget)\b[^;]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i
  }
];

/** 整命令级规则：跨管道/跨单元形态，在未拆分的完整命令文本上匹配 */
const DANGEROUS_FULL_COMMAND_RULES: { category: DangerousBashCategory; pattern: RegExp }[] = [
  // fork 炸弹经典形态（含空格变体）
  { category: 'self-modify', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/ },
  // curl/wget 管道进 shell（splitCommandUnits 按管道拆分后单元会失配，需整命令匹配）
  {
    category: 'shell-escape',
    pattern: /\b(curl|wget)\b[^;&|]*\|[^;&|]*\b(sudo\s+)?(ba|z|da|k)?sh\b/i
  },
  // > /dev/sda / > /dev/disk 块设备重定向覆写
  { category: 'disk-write', pattern: />\s*\/dev\/(sd|disk|nvme|hd)/i }
];

/**
 * 判断单个命令单元是否命中危险 denylist。
 * 单元已由 splitCommandUnits 拆分（不含 && ; | 等分隔符）。
 */
function checkDangerousBashUnit(unit: string, extraPrefixes?: string[]): DangerousBashCheck | null {
  // 可解析的字面引号先还原，确保 rm '-rf' / r"m" -rf 也命中；
  // 复杂语法仍保留原有文本检测，不因安全解析失败而跳过危险规则。
  const tokens = tokenizeSafeBashUnit(unit) ?? unit.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i++;
  }
  if (i >= tokens.length) return null;

  // 剥离 sudo/doas 提权前缀链（sudo dd ... / sudo -u x dd ...），
  // 提权本身命中 privilege-escalation；剥离后继续检查真正命令（取更重的分类）
  let j = i;
  let escalated = false;
  while (j < tokens.length && (tokens[j] === 'sudo' || tokens[j] === 'doas')) {
    escalated = true;
    j++;
    // 跳过 sudo 的选项参数（-u user / -g group 等，下一个 token 以 - 开头时一并跳）
    while (j < tokens.length && tokens[j].startsWith('-')) j++;
  }
  // 提权即危险：无论后续命令是什么，sudo/doas 下所有命令都应弹审批。
  // 若剥高后的真正命令也危险（如 sudo dd → disk-write），取那个更具体的分类。
  if (escalated) {
    const rest = tokens.slice(j).join(' ');
    const restHit = rest ? checkDangerousBashUnit(rest, extraPrefixes) : null;
    return (
      restHit ?? {
        dangerous: true,
        category: 'privilege-escalation',
        reason: '提权命令（sudo/doas）'
      }
    );
  }
  const first = tokens[j] ?? tokens[i];

  // ① 命令名级：任意参数形态都危险（dd/sudo/mkfs/...）
  for (const rule of DANGEROUS_COMMAND_NAMES) {
    if (rule.name.test(first)) {
      return {
        dangerous: true,
        category: rule.category,
        reason: `命中危险命令规则（${rule.category}）`
      };
    }
  }

  // ② 单元级参数敏感规则（剥前缀后的完整文本）
  const stripped = tokens.slice(i).join(' ');
  for (const rule of DANGEROUS_UNIT_RULES) {
    if (rule.pattern.test(stripped)) {
      return {
        dangerous: true,
        category: rule.category,
        reason: `命中危险命令规则（${rule.category}）`
      };
    }
  }

  // ③ 用户自定义危险前缀（首 token 匹配）
  if (extraPrefixes && extraPrefixes.length > 0) {
    for (const p of extraPrefixes) {
      if (p && first === p.trim()) {
        return {
          dangerous: true,
          category: 'unknown',
          reason: `命中自定义危险命令规则（${p}）`
        };
      }
    }
  }
  return null;
}

/**
 * 整条 bash 命令的危险性检测（denylist）。
 * 任一单元命中即危险。与 isSafeBashCommand 互补：白名单决定「无需问」,
 * 本函数决定「必须问」（除 allow-all 外强制弹审批）。
 */
export function checkDangerousBashCommand(
  command: string,
  config?: DangerousBashConfig
): DangerousBashCheck | null {
  // 先跑整命令级规则（跨管道形态）
  for (const rule of DANGEROUS_FULL_COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return {
        dangerous: true,
        category: rule.category,
        reason: `命中危险命令规则（${rule.category}）`
      };
    }
  }
  const units = splitCommandUnits(command);
  for (const u of units) {
    const hit = checkDangerousBashUnit(u, config?.extraDangerousPrefixes);
    if (hit) return hit;
  }
  return null;
}

/** 便捷形式：是否危险（不关心分类时使用） */
export function isDangerousBashCommand(command: string, config?: DangerousBashConfig): boolean {
  return checkDangerousBashCommand(command, config) !== null;
}

/**
 * auto-safe 策略下的工具调用安全判定。
 * @param toolName 工具名（bash/read/edit/write/grep/find/ls/mcp:* 等）
 * @param input 工具参数
 * @param config 可自定义白名单（设置页配置：追加安全工具 + bash 命令）
 */
export function isSafeToolCall(
  toolName: string,
  input: unknown,
  config?: AutoSafeConfig,
  cwd?: string
): boolean {
  // 自定义安全工具名也不能覆盖已知危险命令。
  if (checkDangerousToolCall(toolName, input)) return false;
  // 安全工具（内置只读 + 用户追加）
  const safeTools = config?.safeTools
    ? new Set([...SAFE_TOOL_NAMES, ...normalizeList(config.safeTools)])
    : SAFE_TOOL_NAMES;
  if (safeTools.has(toolName)) {
    return true;
  }
  // bash：白名单命令放行
  if (toolName === 'bash') {
    const command = (input as { command?: unknown } | null)?.command;
    if (typeof command !== 'string' || command.length === 0) return false;
    return isSafeBashCommand(command, config?.safeBashCommands);
  }
  // write/edit：目标在当前工作目录内 → 放行（auto-safe 下最常见的编码操作）
  if (isSafeWriteInCwd(toolName, input, cwd)) return true;
  // 目录外的 write/edit、mcp、自定义工具等其余一切：审批
  return false;
}

/** 工作目录内免审批的写类工具（SDK 中带 path 且会改文件的只有这两个；bash/powershell 走命令白名单） */
const WRITE_IN_CWD_TOOLS = new Set(['write', 'edit']);

/**
 * 即使位于工作目录内也必须审批的敏感目录名：
 * - .git：写 config / hooks/* 等同于让本机执行任意代码（git 钩子会被 git 自动执行）
 * - .ssh / .aws / .gnupg / .kube：凭证、密钥与集群凭据
 */
const SENSITIVE_DIR_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube']);

/** 展开 ~ / ~/xxx（SDK 工具接受 ~ 写法） */
function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith(`~${sep}`))
    return resolve(homedir(), input.slice(2));
  return input;
}

/** target 是否位于 dir 内（dir 本身算命中） */
function isInsideDir(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 解析为真实绝对路径：逐级上溯到最近的已存在祖先做 realpathSync，再拼回剩余段。
 * 目的：识别**符号链接逃逸**——仓库里可能存在 link → /etc 这类链接，
 * write 会沿链接落盘到工作目录之外，只做字符串前缀/相对路径判断看不出来。
 */
function realPathOf(absPath: string): string {
  const segments: string[] = [];
  let current = absPath;
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return segments.length ? resolve(real, ...segments) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(absPath);
      segments.unshift(basename(current));
      current = parent;
    }
  }
  return resolve(absPath);
}

/**
 * auto-safe 下「工作目录内的写操作」判定：write / edit 的目标路径位于当前工作目录内 → 免审批。
 *
 * 不放行（保守回退到逐次审批）的情况：
 * - 调用方没给 cwd（无上下文不自动放行）
 * - 工作目录就是家目录（家目录不是项目目录，写 ~/.zshrc、~/.pi-desktop/* 风险过高）
 * - 目标落在 .git/.ssh 等敏感目录内（SENSITIVE_DIR_SEGMENTS）
 * - 目标经符号链接落在工作目录之外
 */
export function isSafeWriteInCwd(toolName: string, input: unknown, cwd?: string): boolean {
  if (!WRITE_IN_CWD_TOOLS.has(toolName)) return false;
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return false;
  const raw = (input as { path?: unknown } | null)?.path;
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;

  const root = realPathOf(resolve(cwd));
  if (root === resolve(homedir()) || root === realPathOf(homedir())) return false;
  const target = realPathOf(resolve(root, expandHomePath(raw.trim())));
  if (!isInsideDir(root, target)) return false;

  const segments = relative(root, target)
    .split(sep)
    .filter((s) => s.length > 0);
  return !segments.some((s) => SENSITIVE_DIR_SEGMENTS.has(s));
}

/**
 * 审批闸门的危险检测入口：判断一次工具调用是否含危险 bash 命令。
 * 仅当工具为 bash 且命令命中 denylist 时返回非 null（含分类与原因）。
 */
export function checkDangerousToolCall(
  toolName: string,
  input: unknown,
  config?: DangerousBashConfig
): DangerousBashCheck | null {
  if (toolName !== 'bash') return null;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string' || command.length === 0) return null;
  return checkDangerousBashCommand(command, config);
}

/** 生成审批请求用的输入预览（供渲染进程展示） */
/**
 * 预览文本的硬上限：只用于防御病态输入（例如一次性写入几 MB 的 payload）。
 *
 * 正常长度的命令/参数**不截断**：审批的核心信息就是这条命令本身，
 * 用「…」截断会让人看不到真正要执行的尾部（重定向、管道、参数等），
 * 等于让用户审批一个自己看不全的东西。展示端（审批面板）用 max-h + overflow-auto
 * 提供滚动条，超长内容靠滚动查看；系统通知正文单独做短裁剪。
 */
const PREVIEW_HARD_LIMIT = 20000;

/** 仅对病态超长输入做兵底截断（并明确告知省略了多少字符），正常长度原样返回 */
function clipPreview(text: string): string {
  if (text.length <= PREVIEW_HARD_LIMIT) return text;
  const omitted = text.length - PREVIEW_HARD_LIMIT;
  return `${text.slice(0, PREVIEW_HARD_LIMIT)}…（已省略 ${omitted} 字符）`;
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // bash 命令完整展示（审批闸门的关键信息，不得截断）
  if (toolName === 'bash' && typeof obj.command === 'string') {
    return clipPreview(obj.command);
  }
  if (typeof obj.path === 'string') {
    return clipPreview(obj.path);
  }
  try {
    return clipPreview(JSON.stringify(obj));
  } catch {
    return String(obj);
  }
}
