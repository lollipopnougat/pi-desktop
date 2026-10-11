/**
 * MCP 客户端管理器（懒加载）
 *
 * 设计：
 * - 工具不预先注册为独立 customTool，而是通过单个 mcp 代理工具访问
 * - 服务器在首次工具调用时才连接（懒连接）
 * - 可配置 autoConnectOnSession：会话创建时自动连接所有启用的服务器
 * - 连接后缓存工具列表，后续调用直接复用
 *
 * 代理工具调用格式：
 *   mcp({ op: "list", server?: "name" })          → 列出服务器/工具
 *   mcp({ op: "connect", server: "name" })        → 显式连接
 *   mcp({ op: "call", server: "name", tool: "xxx", args: {...} })  → 调用工具
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerEntry } from './config';
import { loadMcpConfig, loadProjectMcpConfig } from './config';

/** 已连接的 MCP 服务器会话 */
interface McpServerSession {
  name: string;
  client: Client;
  tools: Array<{ name: string; description: string; inputSchema: any }>;
  connectedAt: number;
  close?: () => Promise<void>;
}

export interface BuiltinMcpConnection {
  client: Client;
  close?: () => Promise<void>;
}

type BuiltinMcpConnector = () => Promise<BuiltinMcpConnection>;

/** 服务器连接状态（给 UI 用） */
export interface McpServerStatus {
  name: string;
  entry: McpServerEntry;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/** 全局配置：是否在会话创建时自动连接 */
let autoConnectOnSession = false;

class McpManager {
  private sessions = new Map<string, McpServerSession>();
  private connecting = new Set<string>();
  private builtins = new Map<string, BuiltinMcpConnector>();
  /** 当前会话 cwd：loadMcpConfig 合并项目级 <cwd>/.mcp.json 用 */
  private currentCwd: string | undefined;

  /** 设置 autoConnectOnSession */
  setAutoConnect(v: boolean) {
    autoConnectOnSession = v;
  }

  getAutoConnect(): boolean {
    return autoConnectOnSession;
  }

  /** 设置当前 cwd（会话创建/切换时调），影响后续 loadMcpConfig 合并项目级配置 */
  setCwd(cwd: string | undefined) {
    this.currentCwd = cwd;
  }

  getCwd(): string | undefined {
    return this.currentCwd;
  }

  registerBuiltin(name: string, connector: BuiltinMcpConnector): void {
    this.builtins.set(name, connector);
  }

  async unregisterBuiltin(name: string): Promise<void> {
    await this.disconnect(name);
    this.builtins.delete(name);
  }

  isBuiltin(name: string): boolean {
    return this.builtins.has(name);
  }

  /**
   * 会话创建时调用：
   * - 项目级服务器（<cwd>/.mcp.json）始终自动连接（用户显式配置，说明需要使用）
   * - 全局服务器仅在 autoConnectOnSession 开启时连接
   */
  async onSessionCreate(): Promise<void> {
    // 项目级服务器始终自动连接
    const projectServers: Array<[string, McpServerEntry]> = [];
    if (this.currentCwd) {
      const projectConfig = loadProjectMcpConfig(this.currentCwd);
      for (const [name, entry] of Object.entries(projectConfig.mcpServers)) {
        if (!entry.disabled && (entry.command || entry.url)) {
          projectServers.push([name, entry]);
        }
      }
    }

    // 全局服务器仅在 autoConnectOnSession 开启时连接，排除已被项目级覆盖的同名服务器
    let globalServers: Array<[string, McpServerEntry]> = [];
    if (autoConnectOnSession) {
      const config = loadMcpConfig(this.currentCwd);
      const projectNames = new Set(projectServers.map(([n]) => n));
      globalServers = Object.entries(config.mcpServers).filter(
        ([name, entry]) =>
          !projectNames.has(name) && !entry.disabled && (entry.command || entry.url)
      );
    }

    const allServers = [...projectServers, ...globalServers];
    if (allServers.length === 0) return;
    await Promise.all(allServers.map(([name, entry]) => this.connect(name, entry).catch(() => {})));
  }

  /** 连接单个 MCP 服务器（懒连接入口） */
  async connect(name: string, entry: McpServerEntry): Promise<McpServerStatus> {
    if (this.builtins.has(name)) return this.connectBuiltin(name);
    // 已连接
    if (this.sessions.has(name)) {
      const s = this.sessions.get(name)!;
      return { name, entry, connected: true, toolCount: s.tools.length };
    }
    if (this.connecting.has(name)) {
      return { name, entry, connected: false, toolCount: 0, error: '正在连接中' };
    }

    this.connecting.add(name);
    try {
      const { client, transport } = await this.createClient(name, entry);
      await client.connect(transport);

      // 发现工具
      const toolsResult = await client.listTools();
      const tools = (toolsResult.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} }
      }));

      const session: McpServerSession = {
        name,
        client,
        tools,
        connectedAt: Date.now()
      };
      this.sessions.set(name, session);

      return { name, entry, connected: true, toolCount: tools.length };
    } catch (err: any) {
      return { name, entry, connected: false, toolCount: 0, error: err?.message || String(err) };
    } finally {
      this.connecting.delete(name);
    }
  }

  async connectNamed(name: string): Promise<McpServerStatus> {
    if (this.builtins.has(name)) return this.connectBuiltin(name);
    const entry = loadMcpConfig(this.currentCwd).mcpServers[name];
    if (!entry || entry.disabled) {
      return { name, entry: entry || {}, connected: false, toolCount: 0, error: '服务器未配置' };
    }
    return this.connect(name, entry);
  }

  private async connectBuiltin(name: string): Promise<McpServerStatus> {
    const entry: McpServerEntry = { builtin: true };
    if (this.sessions.has(name)) {
      const session = this.sessions.get(name)!;
      return { name, entry, connected: true, toolCount: session.tools.length };
    }
    if (this.connecting.has(name)) {
      return { name, entry, connected: false, toolCount: 0, error: '正在连接中' };
    }
    const connector = this.builtins.get(name);
    if (!connector) {
      return { name, entry, connected: false, toolCount: 0, error: '内置服务未启用' };
    }

    this.connecting.add(name);
    try {
      const connection = await connector();
      const toolsResult = await connection.client.listTools();
      const tools = (toolsResult.tools || []).map((tool: any) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || { type: 'object', properties: {} }
      }));
      this.sessions.set(name, {
        name,
        client: connection.client,
        tools,
        connectedAt: Date.now(),
        close: connection.close
      });
      return { name, entry, connected: true, toolCount: tools.length };
    } catch (err: any) {
      return { name, entry, connected: false, toolCount: 0, error: err?.message || String(err) };
    } finally {
      this.connecting.delete(name);
    }
  }

  /** 确保服务器已连接（懒连接：未连接则从配置读取并连接） */
  async ensureConnected(name: string): Promise<McpServerSession | null> {
    const existing = this.sessions.get(name);
    if (existing) return existing;

    if (this.builtins.has(name)) {
      const status = await this.connectBuiltin(name);
      return status.connected ? this.sessions.get(name) || null : null;
    }

    const config = loadMcpConfig(this.currentCwd);
    const entry = config.mcpServers[name];
    if (!entry || entry.disabled) {
      return null;
    }

    const status = await this.connect(name, entry);
    if (status.connected) {
      return this.sessions.get(name) || null;
    }
    return null;
  }

  /** 断开单个服务器 */
  async disconnect(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    try {
      if (session.close) await session.close();
      else await session.client.close();
    } catch {}
    this.sessions.delete(name);
  }

  /** 断开所有服务器 */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.sessions.keys());
    await Promise.all(names.map((n) => this.disconnect(n)));
  }

  /** 获取所有服务器状态（含未连接的配置项） */
  getStatuses(): McpServerStatus[] {
    const config = loadMcpConfig(this.currentCwd);
    const result: McpServerStatus[] = [];
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (this.builtins.has(name)) continue;
      const session = this.sessions.get(name);
      if (session) {
        result.push({ name, entry, connected: true, toolCount: session.tools.length });
      } else {
        result.push({ name, entry, connected: false, toolCount: 0 });
      }
    }
    for (const name of this.builtins.keys()) {
      const entry: McpServerEntry = { builtin: true };
      const session = this.sessions.get(name);
      result.push({
        name,
        entry,
        connected: !!session,
        toolCount: session?.tools.length || 0
      });
    }
    return result;
  }

  /** 列出某个服务器的工具（需已连接） */
  listTools(name: string): Array<{ name: string; description: string }> {
    const session = this.sessions.get(name);
    if (!session) return [];
    return session.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  /** 调用 MCP 工具 */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    ok: boolean;
    text: string;
    content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    details: any;
  }> {
    const session = await this.ensureConnected(serverName);
    if (!session) {
      return {
        ok: false,
        text: `MCP server "${serverName}" 不可用（未配置或连接失败）`,
        content: [{ type: 'text', text: `MCP server "${serverName}" 不可用（未配置或连接失败）` }],
        details: { error: 'server_unavailable' }
      };
    }

    // 校验工具是否存在
    const toolExists = session.tools.some((t) => t.name === toolName);
    if (!toolExists) {
      return {
        ok: false,
        text: `MCP server "${serverName}" 没有工具 "${toolName}"。可用工具: ${session.tools.map((t) => t.name).join(', ')}`,
        content: [
          {
            type: 'text',
            text: `MCP server "${serverName}" 没有工具 "${toolName}"。可用工具: ${session.tools.map((t) => t.name).join(', ')}`
          }
        ],
        details: { error: 'tool_not_found', available: session.tools.map((t) => t.name) }
      };
    }

    try {
      const result: any = await session.client.callTool({
        name: toolName,
        arguments: args
      });
      const textParts: string[] = (result.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      const text = textParts.join('\n') || JSON.stringify(result);
      const content = (result.content || []).flatMap((part: any) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          return [{ type: 'text' as const, text: part.text }];
        }
        if (
          part?.type === 'image' &&
          typeof part.data === 'string' &&
          typeof part.mimeType === 'string'
        ) {
          return [{ type: 'image' as const, data: part.data, mimeType: part.mimeType }];
        }
        return [];
      });
      return {
        ok: true,
        text,
        content: content.length ? content : [{ type: 'text', text }],
        details: {
          server: serverName,
          tool: toolName,
          isError: result.isError === true,
          contentTypes: (result.content || []).map((part: any) => part?.type || 'unknown'),
          structuredContent: result.structuredContent
        }
      };
    } catch (err: any) {
      return {
        ok: false,
        text: `MCP 工具调用失败: ${err?.message || err}`,
        content: [{ type: 'text', text: `MCP 工具调用失败: ${err?.message || err}` }],
        details: { error: String(err) }
      };
    }
  }

  /** 创建 MCP 客户端 + transport */
  private async createClient(
    name: string,
    entry: McpServerEntry
  ): Promise<{
    client: Client;
    transport: any;
  }> {
    const client = new Client({ name: 'pi-desktop', version: '1.0.0' }, { capabilities: {} });

    let transport: any;
    if (entry.url) {
      // HTTP 模式：streamable-http（默认）或 sse
      const url = interpolateEnvVars(entry.url);
      const transportType = entry.transport || 'streamable-http';

      // 构建请求头（含环境变量插值 + bearer token）
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.headers || {})) {
        headers[k] = interpolateEnvVars(v);
      }

      // Bearer token：直接值 或 从环境变量读取
      const bearerToken = resolveBearerToken(entry);
      if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
      }

      const requestInit: RequestInit = { headers };

      if (transportType === 'sse') {
        transport = new SSEClientTransport(new URL(url), { requestInit });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
      }
    } else if (entry.command) {
      // stdio 模式：合并进程环境变量 + 自定义 env
      const command = interpolateEnvVars(entry.command);
      const args = (entry.args || []).map((a) => interpolateEnvVars(a));

      // env: 进程环境变量为底，叠加自定义 env（含插值）
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [k, v] of Object.entries(entry.env || {})) {
        env[k] = interpolateEnvVars(v);
      }

      transport = new StdioClientTransport({
        command,
        args,
        env,
        cwd: entry.cwd
      });
    } else {
      throw new Error('MCP server entry must have either "command" or "url"');
    }

    return { client, transport };
  }
}

/** 单例 */
export const mcpManager = new McpManager();

/**
 * 环境变量插值：将字符串中的 $VAR 或 ${VAR} 替换为对应环境变量值。
 * 未找到的环境变量保留原样（不报错），让连接失败时错误信息更直观。
 */
export function interpolateEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, plain) => {
    const varName = braced || plain;
    const val = process.env[varName];
    return val !== undefined ? val : match;
  });
}

/**
 * 解析 bearer token：优先用 bearerToken 直接值，其次从 bearerTokenEnv 指定的环境变量读取。
 * 两者都支持 $VAR / ${VAR} 插值。
 */
export function resolveBearerToken(entry: McpServerEntry): string | null {
  if (entry.bearerToken) {
    return interpolateEnvVars(entry.bearerToken);
  }
  if (entry.bearerTokenEnv) {
    // bearerTokenEnv 是环境变量名，取其值
    const varName = interpolateEnvVars(entry.bearerTokenEnv).replace(/^\$\{?|\}$/g, '');
    const val = process.env[varName];
    return val || null;
  }
  return null;
}
