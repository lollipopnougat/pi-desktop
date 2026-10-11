/**
 * mcp 代理工具
 *
 * 单一入口工具，模型通过 op 参数访问所有 MCP 服务器和工具。
 * 服务器在首次 call 时才懒连接（除非配置了 autoConnectOnSession）。
 *
 * 操作：
 * - list: 列出所有配置的服务器及其连接状态，或某服务器的工具列表
 * - connect: 显式连接某服务器
 * - call: 调用某服务器的某工具（自动懒连接）
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { mcpManager } from './manager';

export const mcpProxyTool = defineTool({
  name: 'mcp',
  label: 'MCP 工具',
  description: `访问 MCP（Model Context Protocol）服务器和工具。MCP 服务器在首次调用时自动连接（懒加载）。

操作：
- list: 列出所有配置的 MCP 服务器及连接状态。传 server 参数则列出该服务器的工具。
- connect: 显式连接某个服务器（通常不需要，call 时会自动连接）。
- call: 调用某服务器的工具。args 为工具参数对象。

示例：
- mcp({ op: "list" })  → 列出所有服务器
- mcp({ op: "list", server: "github" })  → 列出 github 服务器的工具
- mcp({ op: "call", server: "github", tool: "search_issues", args: { query: "is:open" } })`,
  promptSnippet: '访问 MCP 服务器工具（list/connect/call）',
  promptGuidelines: [
    'MCP 服务器懒加载：call 时自动连接，无需先 connect',
    '调用前可用 mcp({ op: "list", server: "name" }) 查看可用工具'
  ],
  parameters: Type.Object({
    op: Type.Union([Type.Literal('list'), Type.Literal('connect'), Type.Literal('call')], {
      description: '操作类型：list / connect / call'
    }),
    server: Type.Optional(Type.String({ description: 'MCP 服务器名称' })),
    tool: Type.Optional(Type.String({ description: '工具名称（op=call 时必填）' })),
    args: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: '工具参数对象（op=call 时使用）'
      })
    )
  }),
  async execute(_toolCallId, params) {
    const { op, server, tool, args } = params as {
      op: 'list' | 'connect' | 'call';
      server?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };

    if (op === 'list') {
      if (server) {
        // 列出某服务器的工具
        const session = await mcpManager.ensureConnected(server);
        if (!session) {
          return errorResult(`服务器 "${server}" 不可用或连接失败`);
        }
        const tools = session.tools.map((t) => ({
          name: t.name,
          description: t.description
        }));
        return textResult(
          `服务器 "${server}" 提供 ${tools.length} 个工具:\n` +
            tools.map((t) => `- ${t.name}: ${t.description}`).join('\n'),
          { server, tools }
        );
      }
      // 列出所有服务器（合并全局 + 项目级 <cwd>/.mcp.json）
      const statuses = mcpManager.getStatuses();
      const lines = statuses.map((s) => {
        const type = s.entry.builtin ? 'builtin' : s.entry.url ? 'http' : 'stdio';
        return `- ${s.name} [${type}] ${s.connected ? `✓ 已连接(${s.toolCount}工具)` : '○ 未连接'}${s.error ? ` 错误: ${s.error}` : ''}`;
      });
      if (lines.length === 0) {
        return textResult('未配置任何 MCP 服务器。可在设置页添加。', { servers: [] });
      }
      return textResult(`MCP 服务器 (${lines.length}):\n${lines.join('\n')}`, {
        servers: statuses
      });
    }

    if (op === 'connect') {
      if (!server) return errorResult('connect 操作需要 server 参数');
      const status = await mcpManager.connectNamed(server);
      if (status.connected) {
        return textResult(`已连接服务器 "${server}"，发现 ${status.toolCount} 个工具`, {
          status
        });
      }
      return errorResult(`连接服务器 "${server}" 失败: ${status.error}`, { status });
    }

    if (op === 'call') {
      if (!server) return errorResult('call 操作需要 server 参数');
      if (!tool) return errorResult('call 操作需要 tool 参数');
      const result = await mcpManager.callTool(server, tool, args || {});
      return { content: result.content, details: result.details } as AgentToolResult<any>;
    }

    return errorResult(`未知操作: ${op}`);
  }
});

function textResult(text: string, details: any): AgentToolResult<any> {
  return { content: [{ type: 'text', text }], details };
}

function errorResult(text: string, details?: any): AgentToolResult<any> {
  return { content: [{ type: 'text', text }], details: details ?? { error: true } };
}
