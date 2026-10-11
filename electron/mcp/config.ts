/**
 * MCP 服务器配置管理
 *
 * 配置文件路径：~/.pi-desktop/mcp.json（格式与 pi-mcp-adapter 兼容）
 *
 * 格式：
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",            // stdio 模式
 *       "args": ["-y", "@some/mcp-server"],
 *       "env": { "API_KEY": "..." },
 *       "cwd": "/optional/cwd"
 *     },
 *     "http-server": {
 *       "url": "https://example.com/mcp",  // HTTP 模式
 *       "headers": { "Authorization": "Bearer xxx" }
 *     }
 *   }
 * }
 */
import fs from 'fs';
import path from 'path';
import { getAgentDir } from '../provider-config';

const MCP_CONFIG_PATH = path.join(getAgentDir(), 'mcp.json');
export const RESERVED_MCP_SERVER_NAMES = new Set(['pi-browser']);

/** 单个 MCP 服务器配置 */
export interface McpServerEntry {
  // stdio 模式
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // HTTP 模式（streamable-http 或 sse）
  url?: string;
  headers?: Record<string, string>;
  /** HTTP 传输类型：streamable-http（默认）或 sse */
  transport?: 'streamable-http' | 'sse';
  /** Bearer token 认证：可直接填值，或用 $ENV_VAR 引用环境变量 */
  bearerToken?: string;
  /** 从环境变量读取 bearer token 的变量名 */
  bearerTokenEnv?: string;
  // 通用
  disabled?: boolean;
  /** 运行时内置服务标记；不会写入 mcp.json */
  builtin?: boolean;
}

/** MCP 配置文件结构 */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** 读取单个 MCP 配置文件（不存在/损坏返回空） */
function readMcpFile(p: string): McpConfig {
  try {
    if (!fs.existsSync(p)) return { mcpServers: {} };
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = { ...(parsed.mcpServers || {}) };
    for (const name of RESERVED_MCP_SERVER_NAMES) delete servers[name];
    return { mcpServers: servers };
  } catch {
    return { mcpServers: {} };
  }
}

/**
 * 读取 MCP 配置：全局 ~/.pi-desktop/mcp.json + 项目级 <cwd>/.mcp.json。
 * - cwd 给定时合并两份：项目级同名服务器覆盖全局（项目级优先）
 * - 项目级配置路径与 pi CLI / Codex / Cursor 等工具一致，均为 <cwd>/.mcp.json
 */
export function loadMcpConfig(cwd?: string): McpConfig {
  const global = readMcpFile(MCP_CONFIG_PATH);
  if (!cwd) return global;
  const project = readMcpFile(path.join(cwd, '.mcp.json'));
  if (Object.keys(project.mcpServers).length === 0) return global;
  // 合并：项目级覆盖同名全局
  return {
    mcpServers: { ...global.mcpServers, ...project.mcpServers }
  };
}

/** 读取项目级 MCP 配置（仅 <cwd>/.mcp.json，不合并全局） */
export function loadProjectMcpConfig(cwd: string): McpConfig {
  return readMcpFile(path.join(cwd, '.mcp.json'));
}

/** 保存 MCP 配置 */
export function saveMcpConfig(config: McpConfig): void {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** 获取配置文件路径（全局） */
export function getMcpConfigPath(): string {
  return MCP_CONFIG_PATH;
}

/** 获取项目级配置文件路径 */
export function getProjectMcpConfigPath(cwd: string): string {
  return path.join(cwd, '.mcp.json');
}

/** 添加/更新单个服务器（仅全局） */
export function upsertMcpServer(name: string, entry: McpServerEntry): void {
  const config = loadMcpConfig();
  config.mcpServers[name] = entry;
  saveMcpConfig(config);
}

/** 删除单个服务器（仅全局） */
export function deleteMcpServer(name: string): void {
  const config = loadMcpConfig();
  delete config.mcpServers[name];
  saveMcpConfig(config);
}
