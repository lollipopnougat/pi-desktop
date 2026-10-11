/**
 * 决策模型（classifier）调用的落盘日志。
 *
 * 输出：`~/.pi-desktop/logs/classifier-YYYY-MM-DD.log`，一行一个 JSON：
 * - `phase: 'request'` —— 实际发给端点的 provider / model / 超时 / 置信度阈值 / state / questions
 * - `phase: 'response'` —— 端点的原始返回（stopReason / answers / usage）+ 翻译后的 verdict + 耗时
 * - `phase: 'error'` —— 早退分支（未选模型 / 运行时不可用 / 找不到模型 / 抛错 / 超时 / 被取消）
 *
 * `source` 区分调用来源：`approval-gate`（权限闸门自动调用）/ `playground`（设置页「运行分类」试跑）。
 * 等级：判定失败记 warn（缺 Key、超时这类需要被注意到），成功链路记 info。
 */
import { logEvent, type LogLevel } from './logger';

export const CLASSIFIER_LOG_CHANNEL = 'classifier';

export type ClassifierLogSource = 'approval-gate' | 'playground';

export function logClassifierCall(
  source: ClassifierLogSource,
  entry: Record<string, unknown>,
  level: LogLevel = 'info'
): void {
  logEvent(CLASSIFIER_LOG_CHANNEL, { source, ...entry }, level);
}
