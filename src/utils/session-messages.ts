/** SDK 动态消息结构：toolResult 按 toolCallId 去重，其余按 role + timestamp。 */
export function messageKey(message: any): string {
  if (message?.role === 'toolResult' && message.toolCallId)
    return `toolResult:${message.toolCallId}`;
  return `${message?.role}:${message?.timestamp}`;
}

export function visibleMessage(message: any): boolean {
  if (!message || message.role === 'system') return false;
  if (message.role !== 'user') return true;
  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((c: any) => c?.text || '').join('')
        : '';
  return !/<!-- goal-continuation: [\w:-]+ -->/.test(text);
}

/** 历史快照后到达的增量仍须保留。只合并当前会话，不跨会话沿用旧消息。 */
export function mergeSessionMessages(history: any[], incoming: any[]): any[] {
  const result = history.filter(visibleMessage);
  const keys = new Set(result.map(messageKey));
  for (const message of incoming) {
    if (!visibleMessage(message) || keys.has(messageKey(message))) continue;
    keys.add(messageKey(message));
    result.push(message);
  }
  return result;
}
