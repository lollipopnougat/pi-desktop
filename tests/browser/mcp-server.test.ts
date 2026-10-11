import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMcpConnection } from '../../electron/browser/mcp-server';
import type { BrowserController } from '../../electron/browser/controller';

const connections: Array<{ close?: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close?.()));
});

function createFakeBrowser(enabled = true) {
  const state = {
    enabled,
    tabs: [],
    activeTabId: null
  };
  return {
    getState: vi.fn(() => state),
    open: vi.fn(async (url?: string) => ({
      id: 'tab-1',
      title: 'Example',
      url: url || '',
      loading: false,
      canGoBack: false,
      canGoForward: false
    })),
    close: vi.fn(() => state),
    activate: vi.fn(),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    snapshot: vi.fn(async () => ({
      title: 'Example',
      url: 'https://example.com/',
      text: 'Example Domain',
      elements: [{ ref: 'e1', tag: 'a', role: 'link', name: 'More information' }]
    })),
    screenshot: vi.fn(async () => ({ data: 'aGVsbG8=', mimeType: 'image/png' })),
    click: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    wait: vi.fn(),
    evaluate: vi.fn(async () => 'Example Domain'),
    networkList: vi.fn(() => '共 1 条'),
    networkDetail: vi.fn(() => '请求: GET https://example.com/api'),
    consoleList: vi.fn(() => '[log] hi'),
    devtoolsClear: vi.fn(() => '已清空全部标签的网络与控制台记录')
  } as unknown as BrowserController;
}

describe('pi-browser MCP service', () => {
  it('advertises the fixed browser tool set', async () => {
    const connection = await createBrowserMcpConnection(createFakeBrowser());
    connections.push(connection);
    const result = await connection.client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'tabs',
      'open',
      'close',
      'select',
      'navigate',
      'go',
      'snapshot',
      'screenshot',
      'click',
      'type',
      'press',
      'wait',
      'evaluate',
      'network_list',
      'network_detail',
      'console_list',
      'devtools_clear'
    ]);
  });

  it('routes tab operations and preserves screenshot image content', async () => {
    const browser = createFakeBrowser();
    const connection = await createBrowserMcpConnection(browser);
    connections.push(connection);

    await connection.client.callTool({ name: 'open', arguments: { url: 'https://example.com' } });
    expect(browser.open).toHaveBeenCalledWith('https://example.com', true);

    const snapshot = await connection.client.callTool({ name: 'snapshot', arguments: {} });
    expect(snapshot.content[0]).toMatchObject({ type: 'text' });
    expect((snapshot.content[0] as { type: 'text'; text: string }).text).toContain(
      'Example Domain'
    );

    const screenshot = await connection.client.callTool({ name: 'screenshot', arguments: {} });
    expect(screenshot.content[0]).toEqual({
      type: 'image',
      data: 'aGVsbG8=',
      mimeType: 'image/png'
    });
  });

  it('routes the debugging tools and forwards their options', async () => {
    const browser = createFakeBrowser();
    const connection = await createBrowserMcpConnection(browser);
    connections.push(connection);

    const evaluated = await connection.client.callTool({
      name: 'evaluate',
      arguments: { code: 'document.title' }
    });
    expect(browser.evaluate).toHaveBeenCalledWith(undefined, 'document.title', undefined);
    expect((evaluated.content[0] as { type: 'text'; text: string }).text).toBe('Example Domain');

    const list = await connection.client.callTool({
      name: 'network_list',
      arguments: { tabId: 'tab-1', limit: 5, urlFilter: 'api', onlyFailed: true }
    });
    expect(browser.networkList).toHaveBeenCalledWith('tab-1', {
      limit: 5,
      urlFilter: 'api',
      onlyFailed: true
    });
    expect((list.content[0] as { type: 'text'; text: string }).text).toBe('共 1 条');

    await connection.client.callTool({ name: 'network_detail', arguments: { requestId: 'r1' } });
    expect(browser.networkDetail).toHaveBeenCalledWith(undefined, 'r1');

    await connection.client.callTool({ name: 'console_list', arguments: { limit: 10 } });
    expect(browser.consoleList).toHaveBeenCalledWith(undefined, 10);

    const cleared = await connection.client.callTool({
      name: 'devtools_clear',
      arguments: { what: 'console' }
    });
    expect(browser.devtoolsClear).toHaveBeenCalledWith(undefined, 'console');
    expect((cleared.content[0] as { type: 'text'; text: string }).text).toBe(
      '已清空全部标签的网络与控制台记录'
    );
  });

  it('returns MCP errors from unavailable browser operations', async () => {
    const browser = createFakeBrowser();
    vi.mocked(browser.open).mockRejectedValueOnce(new Error('内置浏览器未启用'));
    const connection = await createBrowserMcpConnection(browser);
    connections.push(connection);

    const result = await connection.client.callTool({ name: 'open', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain(
      '内置浏览器未启用'
    );
  });
});
