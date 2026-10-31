/**
 * 图片内容守卫：拦住「空图片 / 非法 base64 图片」进入模型请求。
 *
 * 事故背景（docs/report2.md）：内置浏览器 `screenshot` 在视图未真正绘制时
 * `capturePage()` 返回空 NativeImage，`toPNG().toString('base64')` 得到 `""`，
 * 这个空图片经 MCP 工具结果原样写进会话历史：
 *
 * ```json
 * {"type":"image","data":"","mimeType":"image/png"}
 * ```
 *
 * pi-ai 的转换器（openai-completions / anthropic-messages / google ...）不校验 data
 * 是否为空，直接拼成 `data:image/png;base64,` —— 上游网关解码失败后整轮请求 400
 * （`invalid base64 image_url`）。更糟的是坏图片留在历史里，之后每次请求都会重新带上，
 * 会话彻底不可用（切到无视觉能力的模型才会跳过图片）。
 *
 * 三道防线：
 * 1. 数据源不产出空图片：`electron/browser/controller.ts`（截图）、
 *    `electron/mcp/manager.ts`（任意 MCP 服务器）、`electron/tools/read-img-tool.ts`（空文件）。
 * 2. 内存自愈：`sanitizeAgentMessages()` 在建槽/换会话时清掉历史里的非法图片块
 *    （compaction 摘要走的是 session.messages，只有清内存才覆盖得到）。
 * 3. 请求兜底：`installImageGuard()` 包装 `agent.convertToLlm`，任何发往模型的
 *    消息都会再过一遍（覆盖 rewind / navigateTree 从文件重建出来的历史）。
 */

/** 模型侧可见的占位文案：与 SDK 自己的 "(image omitted: ...)" 风格保持一致（英文） */
const INVALID_IMAGE_PLACEHOLDER = '(invalid image dropped: empty or malformed base64 data)';

/** base64 字符集 + 尾部填充；Node Buffer.toString('base64') 的结果总是 4 的倍数 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 包装标记：同一个 agent 只包一次 convertToLlm */
const GUARD_WRAPPED = Symbol.for('pi-desktop.image-guard');

interface ContentBlockLike {
  type?: unknown;
  data?: unknown;
  text?: unknown;
}

interface MessageLike {
  content?: unknown;
  [key: string]: unknown;
}

/**
 * 图片 base64 是否可用。
 *
 * 判据刻意保守（只挡「一定非法」的数据，不猜内容）：
 * - 空串 / 纯空白 → 一定非法（本次事故的形态）
 * - 不是合法 base64 字符集，或长度不是 4 的倍数 → 上游解码必失败
 *
 * 截断但仍是合法 base64 的图片（长度恰好对齐）无法在这里识别——那种图片 URI 合法，
 * 由上游按图片损坏处理，不会引发 `invalid base64 image_url`。
 */
export function isUsableImageData(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const value = data.trim();
  if (value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(value);
}

/** 从内容块数组里剔除非法图片块；有剔除时补一条文本占位（返回原引用表示未改动） */
export function sanitizeContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let dropped = 0;
  const kept: unknown[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as ContentBlockLike).type === 'image') {
      if (!isUsableImageData((block as ContentBlockLike).data)) {
        dropped += 1;
        continue;
      }
    }
    kept.push(block);
  }
  if (dropped === 0) return content;
  return [...kept, { type: 'text', text: `${INVALID_IMAGE_PLACEHOLDER} ×${dropped}` }];
}

/**
 * 剔除消息里的非法图片块（适用于 pi-ai 的 Message 与 pi-agent-core 的 AgentMessage）。
 * 没有任何改动时返回入参引用本身，调用方可用身份比较判断是否需要写回。
 */
export function sanitizeMessages<T extends MessageLike>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const content = sanitizeContentBlocks(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content } as T;
  });
  return changed ? next : messages;
}

/** 会话里是否有非法图片（用于日志/诊断；不改动数据） */
export function hasInvalidImages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = (message as MessageLike | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && (block as ContentBlockLike).type === 'image') {
        if (!isUsableImageData((block as ContentBlockLike).data)) return true;
      }
    }
  }
  return false;
}

interface GuardableAgent {
  convertToLlm?: (messages: unknown[]) => unknown;
  messages?: unknown;
  [key: string]: unknown;
}

/**
 * 给会话的 agent 装上图片守卫（幂等）：
 * - 内存：把 agent 当前 transcript 里的非法图片块清掉（含 compaction 摘要请求）
 * - 请求：包装 `agent.convertToLlm`，每条发往模型的消息都过滤一次
 *
 * 只依赖 pi-agent-core 的公开形状（`Agent.messages` / `Agent.convertToLlm`），
 * 取不到 agent 或形状不符时静默跳过（SDK 升级不至于让会话创建失败）。
 * 返回是否真的清掉了历史里的非法图片。
 */
export function installImageGuard(session: unknown): boolean {
  const agent = (session as { agent?: GuardableAgent } | null)?.agent;
  if (!agent || typeof agent !== 'object') return false;

  const current = agent.convertToLlm;
  const alreadyWrapped = (current as { [GUARD_WRAPPED]?: true } | undefined)?.[GUARD_WRAPPED];

  if (typeof current === 'function' && !alreadyWrapped) {
    const original = current.bind(agent) as (messages: unknown[]) => unknown;
    const guarded = async (messages: unknown[]) => {
      const result = await original(messages);
      if (!Array.isArray(result)) return result;
      return sanitizeMessages(result as MessageLike[]);
    };
    (guarded as unknown as { [GUARD_WRAPPED]: true })[GUARD_WRAPPED] = true;
    agent.convertToLlm = guarded as typeof current;
  }

  const messages = agent.messages;
  let repaired = false;
  if (Array.isArray(messages)) {
    const sanitized = sanitizeMessages(messages as MessageLike[]);
    if (sanitized !== messages) {
      agent.messages = sanitized;
      repaired = true;
    }
  }
  return repaired;
}
