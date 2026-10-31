import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * MCP 工具结果的图片过滤：空 base64 图片（内置浏览器截图在视图未绘制时的产物）
 * 绝不能进工具结果 —— 它会被写进会话历史，之后每轮请求都带 `data:image/png;base64,`，
 * 上游解码失败 → 整轮 400（docs/report2.md）。
 */
import { mcpManager } from '../../electron/mcp/manager';

const VALID_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function stubServer(content: unknown[]) {
  const client = { callTool: vi.fn(async () => ({ content, isError: false })) };
  (mcpManager as any).sessions.set('stub', {
    name: 'stub',
    client,
    tools: [{ name: 'screenshot', description: '', inputSchema: { type: 'object' } }],
    connectedAt: Date.now()
  });
  return client;
}

afterEach(() => {
  (mcpManager as any).sessions.clear();
});

describe('mcpManager.callTool 图片守卫', () => {
  it('keeps usable images and text', async () => {
    stubServer([
      { type: 'text', text: '截图完成' },
      { type: 'image', data: VALID_PNG, mimeType: 'image/png' }
    ]);

    const result = await mcpManager.callTool('stub', 'screenshot', {});
    expect(result.ok).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: '截图完成' },
      { type: 'image', data: VALID_PNG, mimeType: 'image/png' }
    ]);
  });

  it('drops empty images and explains it to the model', async () => {
    stubServer([
      { type: 'text', text: '' },
      { type: 'image', data: '', mimeType: 'image/png' }
    ]);

    const result = await mcpManager.callTool('stub', 'screenshot', {});
    expect(result.ok).toBe(true);
    expect(result.content.some((part) => part.type === 'image')).toBe(false);
    const last = result.content.at(-1) as { type: string; text: string };
    expect(last.type).toBe('text');
    expect(last.text).toMatch(/无效图片/);
  });

  it('drops malformed base64 images too', async () => {
    stubServer([{ type: 'image', data: 'iVBORw0KGgo', mimeType: 'image/png' }]);

    const result = await mcpManager.callTool('stub', 'screenshot', {});
    expect(result.content.some((part) => part.type === 'image')).toBe(false);
  });
});
