/**
 * Subagent 模式内联扩展工厂(注册在父会话)。
 *
 * 职责:
 * - 注册 task 工具(主 agent 委派入口)
 * - 提供 followUp 回灌通道(controller 异步 run 完成时经这里送进父会话)
 * - 会话启动/切换时同步快照到渲染进程
 *
 * 关键事实(与 goal 扩展同款,SDK 已验证):
 * - extensionFactories 内联扩展在 noExtensions: true 下仍加载
 * - pi.sendUserMessage(text, { deliverAs: 'followUp' }) 可向父会话投递
 *   非用户可见的后续消息(agent 空闲回合消费)
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { SubagentController } from './controller';
import { createTaskTool } from './tools';

export function subagentExtensionFactory(controller: SubagentController): InlineExtension {
  return {
    name: 'subagents',
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // 注册 task 工具
      pi.registerTool(createTaskTool(controller));

      // followUp 回灌通道:controller 异步 run 完成 → 父会话空闲回合消费
      controller.setFollowUpSender((text) => {
        try {
          pi.sendUserMessage(text, { deliverAs: 'followUp' });
        } catch {
          // 父会话已关闭等场景静默失败
        }
      });

      // 会话启动:推送当前快照(切换会话后 UI 对齐;含从会话恢复历史 run)
      pi.on('session_start', (_event, _ctx) => {
        controller.onSessionSwitch();
      });

      // 压缩后 entries 结构变化:重新从会话恢复,保持 run 列表一致(custom entry 压缩保留)
      pi.on('session_compact', (_event, _ctx) => {
        controller.restoreFromSession();
        controller.emitUpdate();
      });

      // 父会话 agent 空闲时,若有完成的异步 run 尚未送达,由 SDK followUp 队列自然驱动
      // (followUp 消息已入队,无需额外处理)
    }
  };
}
