/**
 * 网络搜索 IPC：设置页读写配置 + 「测试搜索」。
 *
 * 配置落 `~/.pi-desktop/web-search.json`（见 electron/web-search/config.ts）。
 * 写入后必须调 `host.applyWebSearchConfig()`，把 web_search 工具的可见性
 * 在所有会话槽上同步一遍（含后台槽），否则改完要等下次建会话才生效。
 */
import { ipcMain } from 'electron';
import {
  getWebSearchConfigPath,
  readWebSearchConfig,
  writeWebSearchConfig,
  type WebSearchConfig
} from '../web-search/config';
import { PROVIDERS } from '../web-search/providers';
import { runWebSearch } from '../web-search/search';
import { WebSearchError, type WebSearchProviderId } from '../web-search/types';

export interface WebSearchIpcHost {
  /** 配置变更后同步所有会话槽的工具可见性（不重建会话） */
  applyWebSearchConfig(): void;
}

/** 设置页「测试搜索」用的固定查询（与 UI 无关，保证可复现） */
const TEST_QUERY = 'AI agent';

export interface WebSearchTestResult {
  ok: boolean;
  provider?: WebSearchProviderId;
  cached?: boolean;
  ms?: number;
  results?: Array<{ title: string; url: string; snippet: string }>;
  attempts?: Array<{
    provider: WebSearchProviderId;
    ok: boolean;
    results: number;
    ms: number;
    error?: string;
  }>;
  error?: string;
}

export function registerWebSearchIpc(host: WebSearchIpcHost) {
  ipcMain.handle('pi:webSearch:getConfig', () => ({
    config: readWebSearchConfig(),
    configPath: getWebSearchConfigPath(),
    providers: (Object.keys(PROVIDERS) as WebSearchProviderId[]).map((id) => ({
      id,
      label: PROVIDERS[id].label
    }))
  }));

  ipcMain.handle('pi:webSearch:setConfig', (_event, patch: Partial<WebSearchConfig>) => {
    try {
      const config = writeWebSearchConfig(patch ?? {});
      // 工具可见性跟着开关变：立即同步（不重建会话）
      host.applyWebSearchConfig();
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    'pi:webSearch:test',
    async (_event, options?: { query?: string }): Promise<WebSearchTestResult> => {
      const query = (options?.query ?? '').trim() || TEST_QUERY;
      const started = Date.now();
      try {
        // 测试永远打真网络（不读缓存），否则「改了配置再测」会看到旧结果
        const outcome = await runWebSearch(
          { query },
          { config: readWebSearchConfig(), useCache: false }
        );
        return {
          ok: true,
          provider: outcome.provider,
          cached: outcome.cached,
          ms: Date.now() - started,
          results: outcome.results.slice(0, 5),
          attempts: outcome.attempts
        };
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - started,
          attempts: error instanceof WebSearchError ? error.attempts : [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
}
