/**
 * 轻量 JSONL 日志：`~/.pi-desktop/logs/<channel>-YYYY-MM-DD.log`
 *
 * 用途：把「跨进程调用外部服务」以及「模型/工具/审批」的关键参数与结果原样落盘，
 * 便于事后排查（首个使用者是决策模型，见 classifier-gate.ts / classifier-ipc.ts）。
 *
 * 六条设计约束：
 * 1. **绝不影响主流程**：任何序列化 / 写盘异常都被吞掉 —— 日志失败不能让审批闸门崩。
 * 2. **一行一个 JSON**：便于 `grep` / `jq` / 直接肉眼读；时间戳与 channel 由本模块补齐。
 * 3. **脱敏**：键名命中 key / token / secret / password / authorization / cookie 的字段值替换为
 *    `***`；长字符串截断（避免把整个文件塞进日志）。
 * 4. **轮转 + 清理**：单文件超过 MAX_FILE_BYTES 时改名成 `.1` 重新开始；
 *    每次进程内首次写入时清理超过保留天数的旧日志（天数可在设置页调整）。
 * 5. **可开关（默认关闭）**：总开关 + 每个功能（channel）独立开关 + 全局等级门槛，配置存
 *    `~/.pi-desktop/ui-config.json` 的 `logConfig`（主进程用 setLogConfig 缓存，写入路径同步刷新）。
 *    默认**不写任何日志**：日志会落模型请求/工具参数等敏感上下文，只有用户在设置页
 *    手动打开「启用日志」后才开始写盘。
 * 6. **默认不带正文**：`info` 及以上只记录「规模 + 结论」（字符数、耗时、等级…）；需要正文
 *    （prompt / state / 工具输出片段）时把等级调到 `debug`，由调用方通过 textSummary 附带。
 */
import fs from 'fs';
import path from 'path';
import { DESKTOP_AGENT_DIR } from '../config-dir';

/** 日志目录（~/.pi-desktop/logs） */
export const LOGS_DIR = path.join(DESKTOP_AGENT_DIR, 'logs');

/** 单个日志文件上限（超过则轮转成 .1） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 字符串字段最大长度 */
const MAX_STRING_CHARS = 8000;
/** 递归脱敏的最大深度（防止循环引用） */
const MAX_DEPTH = 8;
/** debug 级附带正文时的预览长度 */
const DEBUG_PREVIEW_CHARS = 500;

/** 需要脱敏的键名（大小写不敏感的子串匹配） */
const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|token|secret|password|cookie|credential)/i;
/**
 * 例外：token **计数**字段（totalTokens / input_tokens / cacheReadTokens…）不是凭据。
 * 少了这条会把 usage.totalTokens 洗成 `***`，把「用了多少 token」这个日志核心信息弄丢。
 * 只当**复数** tokens 结尾时才豁免：名为 `token` 的字段仍按凭据脱敏。
 */
const TOKEN_COUNT_KEY_PATTERN = /tokens$/i;

// ===================== 配置（总开关 / 功能开关 / 等级 / 保留天数） =====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 等级由低到高（顺序即门槛语义：配置的等级以下的记录被丢弃） */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志功能（channel）清单：设置页按此渲染开关，新增功能在此登记 */
export const LOG_CHANNELS = ['classifier', 'model', 'tools', 'permission', 'app'] as const;
export type LogChannel = (typeof LOG_CHANNELS)[number];

export interface LogConfig {
  /** 总开关：关掉后任何功能都不再写日志 */
  enabled: boolean;
  /** 等级门槛：只写该等级及以上的记录 */
  level: LogLevel;
  /** 每个功能的开关（缺省视为开启） */
  channels: Record<string, boolean>;
  /** 日志保留天数（超过则在首次写入时清理） */
  retentionDays: number;
}

export const LOG_RETENTION_MIN_DAYS = 1;
export const LOG_RETENTION_MAX_DAYS = 365;
export const DEFAULT_LOG_CONFIG: LogConfig = {
  /**
   * 总开关**默认关闭**：日志会把模型请求、工具参数、审批上下文等原样落盘，
   * 属于敏感数据，只能在用户手动打开后才写（缺省/损坏配置一律回退到这个值）。
   */
  enabled: false,
  level: 'info',
  /**
   * 各功能开关默认开启：总开关关闭时什么都不会写，所以这是「总开关打开后默认记哪些功能」的语义。
   * 若这里也默认关闭，用户打开总开关后界面会看不出任何变化（像是没生效），因此保持全开，
   * 需要精筛时再逐个关。
   */
  channels: Object.fromEntries(LOG_CHANNELS.map((c) => [c, true])),
  retentionDays: 14
};

/** 归一化磁盘上的配置（损坏字段回退默认值，绝不抛错） */
export function normalizeLogConfig(value: unknown): LogConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_LOG_CONFIG.enabled;
  const level =
    typeof raw.level === 'string' && (LOG_LEVELS as readonly string[]).includes(raw.level)
      ? (raw.level as LogLevel)
      : DEFAULT_LOG_CONFIG.level;

  const channels: Record<string, boolean> = { ...DEFAULT_LOG_CONFIG.channels };
  if (raw.channels && typeof raw.channels === 'object') {
    for (const [key, item] of Object.entries(raw.channels as Record<string, unknown>)) {
      if (typeof item === 'boolean') channels[key] = item;
    }
  }

  const days = Number(raw.retentionDays);
  const retentionDays = Number.isFinite(days)
    ? Math.min(LOG_RETENTION_MAX_DAYS, Math.max(LOG_RETENTION_MIN_DAYS, Math.round(days)))
    : DEFAULT_LOG_CONFIG.retentionDays;

  return { enabled, level, channels, retentionDays };
}

let currentConfig: LogConfig = { ...DEFAULT_LOG_CONFIG };

/** 主进程内存缓存（启动时与设置页保存时调用；不读盘，避免每条日志都做 IO） */
export function setLogConfig(config: LogConfig): void {
  currentConfig = { ...config, channels: { ...config.channels } };
}

export function getLogConfig(): LogConfig {
  return { ...currentConfig, channels: { ...currentConfig.channels } };
}

/** 该功能是否开启（未登记的自定义 channel 默认开启，便于扩展） */
export function isChannelEnabled(channel: string): boolean {
  return currentConfig.channels[channel] ?? true;
}

/** 当前等级是否允许记录 debug（需要附带正文时先问它） */
export function isDebugLogging(): boolean {
  return currentConfig.enabled && LEVEL_RANK[currentConfig.level] <= LEVEL_RANK.debug;
}

/** 综合判定：总开关 + 功能开关 + 等级门槛 */
export function shouldLog(channel: string, level: LogLevel): boolean {
  if (!currentConfig.enabled) return false;
  if (!isChannelEnabled(channel)) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[currentConfig.level];
}

/**
 * 文本摘要：默认只给字符数；调成 debug 时附带开头预览。
 * 用来在「默认不落正文」的前提下，需要时仍能一眼看到内容。
 */
export function textSummary(value: unknown): { chars: number; preview?: string } {
  const text = typeof value === 'string' ? value : '';
  const chars = text.length;
  if (!isDebugLogging() || chars === 0) return { chars };
  return { chars, preview: text.slice(0, DEBUG_PREVIEW_CHARS) };
}

// ===================== 路径与写入 =====================

export function getLogsDir(): string {
  return LOGS_DIR;
}

/** 当天日志文件路径（跨天自动换文件；日期取本地时区） */
export function getLogFilePath(channel: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `${channel}-${y}-${m}-${d}.log`);
}

/** 截断长字符串（保留首部，并标注原始长度） */
function clampString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  const head = value.slice(0, MAX_STRING_CHARS);
  return `${head}…（已截断，共 ${value.length} 字符）`;
}

/**
 * 递归脱敏 + 截断：键名敏感 → `***`；字符串过长 → 截断；Error → `{name, message, stack}`。
 * 只读遍历，不修改入参对象。
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return clampString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: clampString(value.message),
      ...(value.stack ? { stack: clampString(value.stack) } : {})
    };
  }
  if (value instanceof AbortSignal) {
    return { aborted: value.aborted, reason: sanitizeForLog(value.reason, depth + 1) };
  }
  if (depth >= MAX_DEPTH) return '[深度超限]';
  if (Array.isArray(value)) {
    const capped = value.slice(0, 100).map((item) => sanitizeForLog(item, depth + 1));
    if (value.length > capped.length) capped.push(`…共 ${value.length} 项`);
    return capped;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const isSecret = SECRET_KEY_PATTERN.test(key) && !TOKEN_COUNT_KEY_PATTERN.test(key);
      out[key] = isSecret ? '***' : sanitizeForLog(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

let dirEnsured = false;
let prunedDay = '';

/** 仅供测试：清空「目录已确保/今日已清理」缓存（生产代码不要调用） */
export function resetLogStateForTest(): void {
  dirEnsured = false;
  prunedDay = '';
}

/** 确保目录存在 + 每天清理一次超过保留天数的日志（失败静默） */
function ensureLogsDir(): void {
  if (!dirEnsured) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    dirEnsured = true;
  }
  const today = new Date().toDateString();
  if (prunedDay === today) return;
  prunedDay = today;
  try {
    const cutoff = Date.now() - currentConfig.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(LOGS_DIR)) {
      if (!/\.log(\.\d+)?$/u.test(name)) continue;
      const full = path.join(LOGS_DIR, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  } catch {
    // 清理失败不影响写入
  }
}

/** 超过上限则把当前文件轮转成 `.1` */
function rotateIfNeeded(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_FILE_BYTES) return;
    const rotated = `${file}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(file, rotated);
  } catch {
    // 轮转失败则继续追加（日志宁可变大也不要丢）
  }
}

/** 写入一行（返回是否成功，不抛错） */
function writeLine(channel: string, line: string): boolean {
  try {
    ensureLogsDir();
    const file = getLogFilePath(channel);
    rotateIfNeeded(file);
    fs.appendFileSync(file, line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加一条日志（一行 JSON）。**不抛错**：任何异常都被吞掉，只让日志缺失，不影响调用方。
 * 失败时会重建目录再重试一次 —— 覆盖「运行中日志目录被外部删掉」的情况。
 * 受总开关 / 功能开关 / 等级门槛过滤（见 shouldLog）。
 */
export function logEvent(
  channel: string,
  payload: Record<string, unknown>,
  level: LogLevel = 'info'
): void {
  if (!shouldLog(channel, level)) return;

  let line: string;
  try {
    const record = {
      ts: new Date().toISOString(),
      channel,
      level,
      ...(sanitizeForLog(payload) as Record<string, unknown>)
    };
    line = `${JSON.stringify(record)}\n`;
  } catch {
    return; // 序列化都失败时直接放弃
  }

  if (writeLine(channel, line)) return;
  dirEnsured = false; // 目录可能被外部删除 → 重建后重试一次
  writeLine(channel, line);
}

/** 读取某天日志的最后 n 行（供「查看日志」UI / 诊断脚本用） */
export function readLogTail(channel: string, maxLines = 200, date = new Date()): string[] {
  try {
    const file = getLogFilePath(channel, date);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

// ===================== 目录管理（设置页：查看 / 清除） =====================

export interface LogFileInfo {
  /** 文件名（含日期，如 classifier-2026-10-09.log） */
  name: string;
  /** 功能名（文件名里日期之前的部分） */
  channel: string;
  sizeBytes: number;
  mtimeMs: number;
  /** 是否为轮转文件（.1） */
  rotated: boolean;
}

/** 列出日志目录下的文件（按修改时间倒序），目录不存在时返回空数组 */
export function listLogFiles(): LogFileInfo[] {
  try {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs
      .readdirSync(LOGS_DIR)
      .filter((name) => /\.log(\.\d+)?$/u.test(name))
      .map((name) => {
        const full = path.join(LOGS_DIR, name);
        const stat = fs.statSync(full);
        const rotated = /\.log\.\d+$/u.test(name);
        return {
          name,
          channel: name
            .replace(/-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/u, '')
            .replace(/\.log(\.\d+)?$/u, ''),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          rotated
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/** 删除所有日志文件（含轮转文件），返回删除数量；失败静默 */
export function clearLogs(): number {
  let removed = 0;
  try {
    if (!fs.existsSync(LOGS_DIR)) return 0;
    for (const name of fs.readdirSync(LOGS_DIR)) {
      if (!/\.log(\.\d+)?$/u.test(name)) continue;
      fs.rmSync(path.join(LOGS_DIR, name), { force: true });
      removed += 1;
    }
  } catch {
    // 删除失败不影响其它文件
  }
  return removed;
}

/**
 * 日志文件名 → 目录内的绝对路径。
 *
 * 只接受 `channel-YYYY-MM-DD.log` / `.log.N` 形态：渲染进程传来的名字一律不可信，
 * 出现路径分隔符或 `..` 时返回 null（防目录穿越），解析后还必须仍在日志目录内。
 */
export function resolveLogFilePath(name: string): string | null {
  if (typeof name !== 'string' || !name) return null;
  if (!/^[A-Za-z0-9._-]+\.log(\.\d+)?$/u.test(name) || name.includes('..')) return null;
  const dir = path.resolve(LOGS_DIR);
  const full = path.resolve(dir, name);
  return path.dirname(full) === dir ? full : null;
}

/** 删除单个日志文件，返回是否成功；失败静默 */
export function deleteLogFile(name: string): boolean {
  const full = resolveLogFilePath(name);
  if (!full) return false;
  try {
    fs.rmSync(full, { force: true });
    return true;
  } catch {
    return false;
  }
}
