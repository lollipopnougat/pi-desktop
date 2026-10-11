import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import type { BuiltinMcpConnection } from '../mcp/manager';
import type { BrowserController } from './controller';

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const tabIdProperty = { type: 'string', description: '浏览器标签 ID；省略时使用活动标签' };

const tools = [
  {
    name: 'tabs',
    description: '列出内置浏览器的全部标签页和活动标签',
    inputSchema: objectSchema({})
  },
  {
    name: 'open',
    description: '新建浏览器标签。URL 可省略以打开空白页，也可传搜索词',
    inputSchema: objectSchema({ url: { type: 'string' } })
  },
  {
    name: 'close',
    description: '关闭指定或活动浏览器标签',
    inputSchema: objectSchema({ tabId: tabIdProperty })
  },
  {
    name: 'select',
    description: '选择并显示指定浏览器标签',
    inputSchema: objectSchema({ tabId: tabIdProperty }, ['tabId'])
  },
  {
    name: 'navigate',
    description: '在指定或活动标签中打开 URL、域名或搜索词',
    inputSchema: objectSchema({ tabId: tabIdProperty, url: { type: 'string' } }, ['url'])
  },
  {
    name: 'go',
    description: '执行后退、前进、刷新或停止加载',
    inputSchema: objectSchema(
      {
        tabId: tabIdProperty,
        action: { type: 'string', enum: ['back', 'forward', 'reload', 'stop'] }
      },
      ['action']
    )
  },
  {
    name: 'snapshot',
    description: '读取页面正文与可交互元素，返回后续 click/type 可使用的临时 ref',
    inputSchema: objectSchema({ tabId: tabIdProperty })
  },
  {
    name: 'screenshot',
    description: '截取当前页面可视区域并返回 PNG 图片',
    inputSchema: objectSchema({ tabId: tabIdProperty })
  },
  {
    name: 'click',
    description: '点击最近一次 snapshot 返回的元素 ref',
    inputSchema: objectSchema({ tabId: tabIdProperty, ref: { type: 'string' } }, ['ref'])
  },
  {
    name: 'type',
    description: '向最近一次 snapshot 返回的输入元素填写文本',
    inputSchema: objectSchema(
      {
        tabId: tabIdProperty,
        ref: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', default: true }
      },
      ['ref', 'text']
    )
  },
  {
    name: 'press',
    description: '向页面发送按键，如 Enter、Tab、Escape、ArrowDown',
    inputSchema: objectSchema({ tabId: tabIdProperty, key: { type: 'string' } }, ['key'])
  },
  {
    name: 'wait',
    description: '等待指定毫秒数，或等待页面出现文本，最长 10 秒',
    inputSchema: objectSchema({
      tabId: tabIdProperty,
      text: { type: 'string' },
      milliseconds: { type: 'number', minimum: 0, maximum: 10000 },
      timeoutMs: { type: 'number', minimum: 100, maximum: 10000 }
    })
  },
  {
    name: 'evaluate',
    description:
      '在页面中执行任意 JS 并返回结果。需先在设置页开启「调试抓包与执行 JS」。支持表达式（document.title）或函数体（const a = 1; return a * 2;），返回值会被安全序列化，默认 10 秒超时',
    inputSchema: objectSchema(
      {
        tabId: tabIdProperty,
        code: { type: 'string', description: '要执行的 JS 代码' },
        timeoutMs: { type: 'number', minimum: 100, maximum: 30000, default: 10000 }
      },
      ['code']
    )
  },
  {
    name: 'network_list',
    description:
      '列出抓到的网络请求（状态码/耗时/大小/是否失败）。需先开启「调试抓包与执行 JS」，且开关要在请求发生前打开；响应体用 network_detail 查看',
    inputSchema: objectSchema({
      tabId: tabIdProperty,
      limit: { type: 'number', minimum: 1, maximum: 300, default: 50 },
      urlFilter: { type: 'string', description: '只保留 URL 含该子串的请求' },
      onlyFailed: { type: 'boolean', description: '只看失败或状态码 >= 400 的请求' }
    })
  },
  {
    name: 'network_detail',
    description: '查看单条请求的完整详情：请求头、请求体、响应头、响应体（超长会截断）',
    inputSchema: objectSchema(
      {
        tabId: tabIdProperty,
        requestId: { type: 'string', description: 'network_list 里的 requestId' }
      },
      ['requestId']
    )
  },
  {
    name: 'console_list',
    description: '列出页面控制台输出与未捕获异常。需先开启「调试抓包与执行 JS」',
    inputSchema: objectSchema({
      tabId: tabIdProperty,
      limit: { type: 'number', minimum: 1, maximum: 200, default: 50 }
    })
  },
  {
    name: 'devtools_clear',
    description: '清空网络/控制台缓冲（只清本地记录，不影响页面）',
    inputSchema: objectSchema({
      tabId: tabIdProperty,
      what: { type: 'string', enum: ['network', 'console', 'all'], default: 'all' }
    })
  }
];

function textResult(value: unknown): CallToolResult {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
    ]
  };
}

export async function createBrowserMcpConnection(
  browser: BrowserController
): Promise<BuiltinMcpConnection> {
  const focus = (tabId?: string) => {
    const state = browser.getState();
    const id = tabId || state.activeTabId;
    if (id) browser.activate(id, true);
  };
  const server = new Server(
    { name: 'pi-browser', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments || {}) as Record<string, any>;
    try {
      switch (request.params.name) {
        case 'tabs':
          return textResult(browser.getState());
        case 'open':
          return textResult(await browser.open(args.url, true));
        case 'close':
          return textResult(browser.close(args.tabId));
        case 'select':
          return textResult(browser.activate(args.tabId, true));
        case 'navigate': {
          const tab = await browser.navigate(args.tabId, args.url);
          browser.activate(tab.id, true);
          return textResult(tab);
        }
        case 'go': {
          const actions = {
            back: () => browser.back(args.tabId),
            forward: () => browser.forward(args.tabId),
            reload: () => browser.reload(args.tabId),
            stop: () => browser.stop(args.tabId)
          };
          const action = actions[args.action as keyof typeof actions];
          if (!action) throw new Error(`未知导航动作: ${args.action}`);
          focus(args.tabId);
          return textResult(action());
        }
        case 'snapshot':
          focus(args.tabId);
          return textResult(await browser.snapshot(args.tabId));
        case 'screenshot': {
          focus(args.tabId);
          const image = await browser.screenshot(args.tabId);
          return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
        }
        case 'click':
          focus(args.tabId);
          await browser.click(args.tabId, args.ref);
          return textResult('已点击元素');
        case 'type':
          focus(args.tabId);
          await browser.type(args.tabId, args.ref, args.text, args.clear !== false);
          return textResult('已填写文本');
        case 'press':
          focus(args.tabId);
          browser.press(args.tabId, args.key);
          return textResult(`已发送按键: ${args.key}`);
        case 'wait':
          focus(args.tabId);
          await browser.wait(args.tabId, args);
          return textResult('等待完成');
        case 'evaluate':
          focus(args.tabId);
          return textResult(await browser.evaluate(args.tabId, args.code, args.timeoutMs));
        case 'network_list':
          return textResult(
            browser.networkList(args.tabId, {
              limit: args.limit,
              urlFilter: args.urlFilter,
              onlyFailed: args.onlyFailed
            })
          );
        case 'network_detail':
          return textResult(browser.networkDetail(args.tabId, args.requestId));
        case 'console_list':
          return textResult(browser.consoleList(args.tabId, args.limit));
        case 'devtools_clear':
          return textResult(browser.devtoolsClear(args.tabId, args.what));
        default:
          throw new Error(`未知浏览器工具: ${request.params.name}`);
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
      };
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pi-desktop', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    }
  };
}
