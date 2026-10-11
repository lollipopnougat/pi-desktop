/**
 * 记忆系统内联扩展工厂（对齐 goalExtensionFactory 模式）。
 *
 * 注册的钩子：
 * - factory 启动时：注册 memory_* 四工具（enabled 时）
 * - session_start：冻结注入快照（新会话读到最新记忆）
 * - before_agent_start：每轮注入冻结快照（同串，保护 prompt cache）
 * - session_shutdown：清快照
 *
 * 安全：所有钩子 try-catch 降级，记忆不可用绝不拖垮主循环。
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { MemoryController } from './controller';
import { createMemoryTools } from './tools';

export function memoryExtensionFactory(controller: MemoryController): InlineExtension {
  return {
    name: 'memory',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // ─── 注册工具（enabled 时）───
      try {
        if (controller.isEnabled()) {
          const {
            memorySaveTool,
            memorySearchTool,
            memoryReadTool,
            memoryUpdateTool,
            memoryRemoveTool
          } = createMemoryTools({
            getProjectName: () => controller.getProjectId(),
            isEnabled: () => controller.isEnabled()
          });
          pi.registerTool(memorySaveTool);
          pi.registerTool(memorySearchTool);
          pi.registerTool(memoryReadTool);
          pi.registerTool(memoryUpdateTool);
          pi.registerTool(memoryRemoveTool);
        }
      } catch {
        /* 工具注册失败不影响主循环 */
      }

      // ─── session_start：冻结快照 ───
      pi.on('session_start', (_event, _ctx) => {
        try {
          controller.freezeSnapshot();
        } catch {}
      });

      // ─── before_agent_start：注入冻结快照 ───
      pi.on('before_agent_start', (event, _ctx) => {
        try {
          const injection = controller.getInjection();
          if (!injection) return;
          return {
            systemPrompt: `${event.systemPrompt}\n\n${injection}`
          };
        } catch {
          return;
        }
      });

      // ─── session_shutdown：清快照 ───
      pi.on('session_shutdown', (_event, _ctx) => {
        try {
          controller.clearSnapshot();
        } catch {}
      });
    }
  };
}
