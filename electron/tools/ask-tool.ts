/**
 * ask 工具：让 agent 在执行中暂停，向用户提问并等待回答。
 *
 * 参考 oh-my-pi 的 ask 工具和 codex-rs 的 request_user_input：
 * - 请求-响应模式：execute 阻塞等待用户响应
 * - 自动追加"其他"选项（自由输入）
 * - 多问题分步填写
 * - 取消 = 中止整个回合
 *
 * IPC 数据流：
 *   主进程 execute() → IPC 事件 pi:askUser → 渲染进程展示 UI
 *   渲染进程提交 → IPC 调用 pi:askUserResponse → 主进程 resolve promise → execute 返回
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** 单个选项 */
export interface AskOption {
  label: string;
  description?: string;
}

/** 单个问题 */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

/** 工具参数 */
export interface AskToolArgs {
  questions: AskQuestion[];
}

/** 用户对单个问题的回答 */
export interface AskAnswer {
  questionId: string;
  selectedLabels: string[];
  customInput?: string;
}

/** 工具返回的 details */
export interface AskToolDetails {
  questions: AskQuestion[];
  answers: AskAnswer[];
  cancelled: boolean;
}

/** 等待用户回答的 resolver（由 pi-bridge 持有） */
export type AskResolver = (answers: AskAnswer[] | null) => void;

/**
 * 挂起的 ask 请求（**按会话分键**：多会话下每个会话各一份，互不覆盖）。
 * 键 = SDK sessionId（由工具 execute 的 ctx.sessionManager 解析），渲染端也用同一个键回传答案。
 */
const pendingAsks = new Map<string, { questions: AskQuestion[]; resolve: AskResolver }>();

/** 注册外部回调：当 ask 请求发起时通知渲染进程（sessionKey 标识是哪个会话在提问） */
let askNotifier: ((sessionKey: string, questions: AskQuestion[]) => void) | null = null;

/** 设置 ask 通知器（由 pi-bridge 调用） */
export function setAskNotifier(notifier: ((sessionKey: string, questions: AskQuestion[]) => void) | null) {
  askNotifier = notifier;
}

/** 渲染进程提交答案时调用（由 pi-bridge IPC 调用）；找不到该会话的挂起提问则返回 false */
export function resolveAsk(sessionKey: string, answers: AskAnswer[] | null): boolean {
  const pending = pendingAsks.get(sessionKey);
  if (!pending) return false;
  pendingAsks.delete(sessionKey);
  pending.resolve(answers);
  return true;
}

/** 进程关闭/会话释放时清掉全部挂起提问（按取消结算，避免工具调用永远挂着） */
export function resolveAllAsks(): number {
  const count = pendingAsks.size;
  for (const [key, pending] of [...pendingAsks]) {
    pendingAsks.delete(key);
    pending.resolve(null);
  }
  return count;
}

/** 某会话挂起的问题（切回该会话时重新推给渲染进程用） */
export function pendingAskQuestions(sessionKey: string): AskQuestion[] | null {
  return pendingAsks.get(sessionKey)?.questions ?? null;
}

/** 当前是否有挂起的 ask 请求（不传会话键=任意会话） */
export function hasPendingAsk(sessionKey?: string): boolean {
  return sessionKey === undefined ? pendingAsks.size > 0 : pendingAsks.has(sessionKey);
}

/** 从工具 execute 的 ctx 解析当前会话键（取不到时退化为空串，等价单会话） */
function askSessionKey(ctx: unknown): string {
  try {
    const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | null)?.sessionManager
      ?.getSessionId?.();
    return typeof id === 'string' && id ? id : '';
  } catch {
    return '';
  }
}

/** ask 工具定义 */
export const askTool = defineTool({
  name: 'ask',
  label: '询问用户',
  description: `向用户提问并等待回答。适用于多个方案权衡显著不同、必须用户拍板的场景。
规则：
- 优先用代码/配置/文档自行消歧，只在必要时提问
- 每个问题提供 2-4 个选项，选项 label 简短（1-5 词）
- 不要自己生成 "其他" 选项，系统会自动追加自由输入
- 用 recommended 标记推荐项（0 起的索引）
- 多个相关问题一次性提出，不要逐个问`,
  promptSnippet: '向用户提问，在方案权衡时获取用户决策',
  promptGuidelines: [
    '只在多个方案权衡显著不同时使用 ask，能用代码/配置/文档消歧的不要问',
    '可接受时直接选最保守/标准的选项并声明选择，不提问',
    '不要自己生成"其他"选项，系统会自动追加自由输入'
  ],
  parameters: Type.Object({
    questions: Type.Array(
      Type.Object({
        id: Type.String({ description: '问题标识（snake_case）' }),
        question: Type.String({ description: '问题文本（单句）' }),
        header: Type.Optional(Type.String({ description: '简短标题（12字以内）' })),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: '选项标签（1-5词）' }),
            description: Type.Optional(Type.String({ description: '选项说明' }))
          }),
          { description: '选项列表（2-4个）' }
        ),
        multi: Type.Optional(Type.Boolean({ description: '是否允许多选' })),
        recommended: Type.Optional(Type.Number({ description: '推荐项索引（0起）' }))
      }),
      { description: '问题列表（1-3个）' }
    )
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { questions } = params as AskToolArgs;
    const sessionKey = askSessionKey(ctx);

    // 等待用户响应；本轮被 abort（用户点停止 / 会话被替换 / 关闭）时按取消结算，避免挂死
    const answerPromise = new Promise<AskAnswer[] | null>((resolve) => {
      let settled = false;
      const onAbort = () => finish(null);
      const finish = (answers: AskAnswer[] | null) => {
        if (settled) return;
        settled = true;
        if (pendingAsks.get(sessionKey)?.resolve === finish) pendingAsks.delete(sessionKey);
        signal?.removeEventListener('abort', onAbort);
        resolve(answers);
      };
      if (signal?.aborted) {
        finish(null);
        return;
      }
      pendingAsks.set(sessionKey, { questions, resolve: finish });
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    // 通知渲染进程展示 UI（事件带本槽身份，渲染端只展示焦点会话的提问）；
    // 没有通知器（窗口已销毁/应用在退出）时直接按取消结算
    if (askNotifier) askNotifier(sessionKey, questions);
    else resolveAsk(sessionKey, null);

    const answers = await answerPromise;
    const cancelled = answers === null;

    const details: AskToolDetails = { questions, answers: answers ?? [], cancelled };

    let contentText: string;
    if (cancelled) {
      contentText = '用户取消了提问';
    } else if (answers!.length === 0) {
      contentText = '用户未做选择';
    } else {
      const lines: string[] = [];
      for (const ans of answers!) {
        const q = questions.find((x) => x.id === ans.questionId);
        const qText = q?.question ?? ans.questionId;
        if (ans.customInput && ans.selectedLabels.length === 0) {
          lines.push(`${qText}: 用户输入: ${ans.customInput}`);
        } else {
          lines.push(`${qText}: 用户选择: ${ans.selectedLabels.join(', ')}`);
          if (ans.customInput) {
            lines.push(`  补充说明: ${ans.customInput}`);
          }
        }
      }
      contentText = lines.join('\n');
    }

    const result: AgentToolResult<AskToolDetails> = {
      content: [{ type: 'text', text: contentText }],
      details
    };
    return result;
  }
});
