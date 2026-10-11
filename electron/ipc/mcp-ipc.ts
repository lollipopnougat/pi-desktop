import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import type { PiBridgeContext } from './types';
import {
  loadMcpConfig,
  saveMcpConfig,
  RESERVED_MCP_SERVER_NAMES,
  type McpServerEntry,
  type McpConfig
} from '../mcp/config';
import { mcpManager } from '../mcp/manager';

/**
 * 注册 MCP 管理 IPC：
 * - getMcpConfig / saveMcpConfig：读写配置
 * - connectMcpServer / disconnectMcpServer：连接管理
 * - getMcpStatus：获取所有服务器状态
 */
export function registerMcpIpc(ctx: PiBridgeContext) {
  const hasReservedServer = (config: any) =>
    !!config?.mcpServers &&
    [...RESERVED_MCP_SERVER_NAMES].some((name) =>
      Object.prototype.hasOwnProperty.call(config.mcpServers, name)
    );

  // 读取 MCP 配置
  ipcMain.handle('pi:getMcpConfig', async () => {
    return loadMcpConfig();
  });

  // 保存 MCP 配置（全量替换）
  ipcMain.handle('pi:saveMcpConfig', async (_e, config: any) => {
    if (hasReservedServer(config)) {
      return { ok: false, error: 'pi-browser 是内置服务保留名称' };
    }
    saveMcpConfig(config);
    return { ok: true };
  });

  // 读取项目级 MCP 配置（<cwd>/.mcp.json）
  ipcMain.handle('pi:getProjectMcpConfig', async (_e, targetCwd?: string) => {
    const projectMcpPath = path.join(targetCwd || ctx.cwd, '.mcp.json');
    try {
      if (!fs.existsSync(projectMcpPath)) {
        return { mcpServers: {} } as McpConfig;
      }
      const raw = fs.readFileSync(projectMcpPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const servers = { ...(parsed.mcpServers || {}) };
      for (const name of RESERVED_MCP_SERVER_NAMES) delete servers[name];
      return { mcpServers: servers } as McpConfig;
    } catch {
      return { mcpServers: {} } as McpConfig;
    }
  });

  // 保存项目级 MCP 配置（<cwd>/.mcp.json）
  ipcMain.handle('pi:saveProjectMcpConfig', async (_e, config: any, targetCwd?: string) => {
    if (hasReservedServer(config)) {
      return { ok: false, error: 'pi-browser 是内置服务保留名称' };
    }
    const projectMcpPath = path.join(targetCwd || ctx.cwd, '.mcp.json');
    fs.writeFileSync(projectMcpPath, JSON.stringify(config, null, 2), 'utf-8');
    return { ok: true };
  });

  // 连接单个服务器
  ipcMain.handle('pi:connectMcpServer', async (_e, name: string, entry: McpServerEntry) => {
    return mcpManager.connect(name, entry);
  });

  // 断开单个服务器
  ipcMain.handle('pi:disconnectMcpServer', async (_e, name: string) => {
    await mcpManager.disconnect(name);
    return { ok: true };
  });

  // 获取/设置 autoConnectOnSession
  ipcMain.handle('pi:getMcpAutoConnect', async () => {
    return mcpManager.getAutoConnect();
  });
  ipcMain.handle('pi:setMcpAutoConnect', async (_e, v: boolean) => {
    mcpManager.setAutoConnect(v);
    return { ok: true };
  });

  // 获取所有服务器状态
  ipcMain.handle('pi:getMcpStatus', async () => {
    return mcpManager.getStatuses();
  });

  // 获取所有已连接服务器的工具列表（用于会话属性展示）
  ipcMain.handle('pi:getMcpTools', async () => {
    const statuses = mcpManager.getStatuses();
    const tools: { name: string; label: string; description: string }[] = [];
    for (const s of statuses) {
      if (s.connected) {
        const serverTools = mcpManager.listTools(s.name);
        for (const t of serverTools) {
          tools.push({
            name: `mcp__${s.name}__${t.name}`,
            label: `${s.name}/${t.name}`,
            description: t.description
          });
        }
      }
    }
    return tools;
  });
}
