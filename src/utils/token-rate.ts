/**
 * 流式输出速率（token/s）追踪器。
 *
 * 数据源：取「provider 流式上报的累计 output token」与「本地字符估算」
 * 的较大者。Anthropic Messages 流式只在 message_start（output 为 1~3）
 * 与最终 message_delta 上报 usage，中段冻结不增长，需本地估算接管；
 * 持续上报累计 usage 的供应商真实值自然胜出，详见 extractOutputTokens。
 * 本地估算规则：content 各 block 字符数 / 4（与 SDK estimateTextTokens 的
 * CHARS_PER_TOKEN=4 一致，text 取 text 长度、thinking 取 thinking 长度、
 * toolCall 计工具名 + JSON 序列化后的 arguments）。
 *
 * 速率算法：滑动窗口（最近 ~2.5s）内 Δtokens / Δtime，避免「全程平均」
 * 在流后期趋稳不动。窗口按 event 到达时间记录，事件本身高频（每个 delta
 * 一次），无需额外定时器。
 *
 * 线程模型：renderer 单线程事件流，message_start 创建实例、message_update
 * 喂事件、message_end/agent_settled 丢弃即可。
 */

const WINDOW_MS = 2500;
/** 至少 2 个不同时间戳的样本才出速率，防止同毫秒双样本 dt=0 卡住 0 */
const MIN_SAMPLES = 2;
const CHARS_PER_TOKEN = 4;
/** EMA 平滑系数：越小越稳但响应越慢；0.25 下约 4~6 个事件收敛 */
const EMA_ALPHA = 0.25;

interface Sample {
  t: number;
  tokens: number;
}

/**
 * 从 partial AssistantMessage 提取累计 output token 数。
 *
 * 取「真实 usage」与「本地估算」的较大者，而非二选一：
 * - Anthropic Messages 流式只在 message_start（output 通常为 1~3）与最终
 *   message_delta 上报 usage，流中段冻结不增长。若仅按 usage>0 判断采用真实值，
 *   整个流期间 Δtokens=0，速率恒为 0，且本地估算兜底永远不生效。
 * - 持续上报累计 usage 的供应商（OpenAI 系），真实值自然 ≥ 估算值，行为不变。
 */
export function extractOutputTokens(message: any): number {
  let chars = 0;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        chars += block.text.length;
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        chars += block.thinking.length;
      } else if (block?.type === 'toolCall') {
        chars += (block.name?.length || 0) + safeJsonLen(block.arguments);
      }
    }
  }
  const estimated = Math.ceil(chars / CHARS_PER_TOKEN);
  const u = message?.usage;
  const reported = u && typeof u.output === 'number' && u.output > 0 ? u.output : 0;
  return Math.max(reported, estimated);
}

function safeJsonLen(v: any): number {
  try {
    return JSON.stringify(v ?? null)?.length || 0;
  } catch {
    return 0;
  }
}

export class TokenRateTracker {
  private samples: Sample[] = [];
  private lastTotal = 0;
  /** EMA 平滑后的速率；record 时更新，供 UI 显示避免原始窗口速率抖动 */
  private smoothed = 0;

  /** 喂入一次流式更新（partial 为 assistantMessageEvent.partial 或 event.message） */
  record(partial: any): void {
    const total = extractOutputTokens(partial);
    // usage 可能先出现再回落（不同供应商流式累计口径不一），保守取 max 防倒退
    if (total < this.lastTotal) return;
    const now = Date.now();
    this.samples.push({ t: now, tokens: total });
    this.lastTotal = total;
    // 裁剪窗口过期样本（留一个窗口外的最早样本做基准，提高速率连续度）
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].t < cutoff) {
      this.samples.shift();
    }
    // EMA 平滑：首个非 0 瞬时速率直接采纳（避免从 0 缓慢爬坡）
    const inst = this.rate();
    if (inst > 0) {
      this.smoothed =
        this.smoothed === 0 ? inst : EMA_ALPHA * inst + (1 - EMA_ALPHA) * this.smoothed;
    }
  }

  /** 当前速率（token/s），样本不足时返回 0 */
  rate(): number {
    if (this.samples.length < MIN_SAMPLES) return 0;
    const last = this.samples[this.samples.length - 1];
    // 基准：最后一个时间戳 < last 的样本。同毫秒连发 delta 时跳过同刻样本，避免 dt=0 卡住。
    // 该基准靠近 last（间隔最短），得到「突刺瞬时」速率，交给 EMA 去平滑。
    let base: Sample | null = null;
    for (let i = this.samples.length - 2; i >= 0; i--) {
      if (this.samples[i].t < last.t) {
        base = this.samples[i];
        break;
      }
    }
    if (!base) return 0; // 所有样本同刻，无法出速率
    const dt = (last.t - base.t) / 1000;
    return Math.max(0, (last.tokens - base.tokens) / dt);
  }

  /**
   * EMA 平滑后的速率（token/s）。UI 层应显示该值而非 rate()：
   * 原始窗口速率逐事件跳变，直接渲染会闪烁。
   */
  smoothedRate(): number {
    return this.smoothed;
  }

  get totalTokens(): number {
    return this.lastTotal;
  }

  reset(): void {
    this.samples = [];
    this.lastTotal = 0;
    this.smoothed = 0;
  }
}
