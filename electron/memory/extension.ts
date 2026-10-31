/**
 * 记忆系统内联扩展工厂（对齐 goalExtensionFactory 模式）。
 *
 * 注册的钩子：
 * - factory 启动时：注册 memory_* 四工具（enabled 时）
 * - session_start：重置自动沉淀计数器 + 冻结注入快照（新会话读到最新记忆）
 * - before_agent_start：每轮注入冻结快照（同串，保护 prompt cache）；捕获用户纠正
 * - turn_end：轮次 / 工具调用达到阈值时后台沉淀
 * - session_before_compact：压缩前沉淀（被压缩掉的对话里的事实不至于丢失）
 * - session_shutdown：清快照
 *
 * 安全：所有钩子 try-catch 降级，记忆不可用绝不拖垮主循环；沉淀是 fire-and-forget，
 * 不阻塞对话，失败只在后台丢掉（会话水位线保证下次还能补上）。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension
} from '@earendil-works/pi-coding-agent';
import type { MemoryController } from './controller';
import { createMemoryTools } from './tools';
import {
  detectCorrection,
  getNudgeCounters,
  markSedimented,
  recordTurn,
  resetNudgeCounters,
  shouldSediment,
  shouldSedimentOnCorrection
} from './nudge';

/** 会话键：自动沉淀计数器按会话隔离（同一窗口里 fork/切换会话互不影响） */
function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return 'default';
  }
}

/** fire-and-forget：沉淀绝不阻塞当前轮 */
function sediment(controller: MemoryController, reason: 'nudge' | 'correction' | 'compact'): void {
  void controller.autoSediment(reason).catch(() => {});
}

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
            memoryRemoveTool,
            sessionSearchTool,
            sessionReadTool
          } = createMemoryTools({
            getProjectName: () => controller.getProjectId(),
            isEnabled: () => controller.isEnabled()
          });
          pi.registerTool(memorySaveTool);
          pi.registerTool(memorySearchTool);
          pi.registerTool(memoryReadTool);
          pi.registerTool(memoryUpdateTool);
          pi.registerTool(memoryRemoveTool);
          pi.registerTool(sessionSearchTool);
          pi.registerTool(sessionReadTool);
        }
      } catch {
        /* 工具注册失败不影响主循环 */
      }

      // ─── session_start：重置计数器 + 冻结快照 ───
      pi.on('session_start', (_event, ctx) => {
        try {
          resetNudgeCounters(sessionKey(ctx));
          controller.freezeSnapshot();
        } catch {}
      });

      // ─── before_agent_start：注入冻结快照 + 纠错捕获 ───
      pi.on('before_agent_start', (event, ctx) => {
        try {
          // SDK 1.2.0 起该事件是 user | custom 联合事件：custom run 没有 prompt
          if (event.messageType === 'user') {
            const config = controller.getConfig();
            if (config.enabled && config.correctionDetect) {
              const hit = detectCorrection(event.prompt);
              const key = sessionKey(ctx);
              if (shouldSedimentOnCorrection(hit, getNudgeCounters(key))) {
                markSedimented(key);
                sediment(controller, 'correction');
              }
            }
          }
          const injection = controller.getInjection();
          if (!injection) return;
          return {
            systemPrompt: `${event.systemPrompt}\n\n${injection}`
          };
        } catch {
          return;
        }
      });

      // ─── turn_end：轮次 / 工具调用阈值沉淀 ───
      pi.on('turn_end', (event, ctx) => {
        try {
          const config = controller.getConfig();
          if (!config.enabled || !config.autoExtract) return;
          const key = sessionKey(ctx);
          const counters = recordTurn(
            key,
            Array.isArray(event.toolResults) ? event.toolResults.length : 0
          );
          if (shouldSediment(counters, config)) {
            markSedimented(key);
            sediment(controller, 'nudge');
          }
        } catch {}
      });

      // ─── session_before_compact：压缩前 flush ───
      pi.on('session_before_compact', (_event, _ctx) => {
        try {
          const config = controller.getConfig();
          if (!config.enabled || !config.autoExtract || !config.preCompactFlush) return;
          // 压缩会丢掉细节，这里先沉淀；不等待结果，压缩照常进行
          sediment(controller, 'compact');
        } catch {}
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
