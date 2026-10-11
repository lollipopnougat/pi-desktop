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

/** 当前挂起的 ask 请求 */
let pendingAsk: { questions: AskQuestion[]; resolve: AskResolver } | null = null;

/** 注册外部回调：当 ask 请求发起时通知渲染进程 */
let askNotifier: ((questions: AskQuestion[]) => void) | null = null;

/** 设置 ask 通知器（由 pi-bridge 调用） */
export function setAskNotifier(notifier: ((questions: AskQuestion[]) => void) | null) {
  askNotifier = notifier;
}

/** 渲染进程提交答案时调用（由 pi-bridge IPC 调用） */
export function resolveAsk(answers: AskAnswer[] | null) {
  if (pendingAsk) {
    pendingAsk.resolve(answers);
    pendingAsk = null;
  }
}

/** 当前是否有挂起的 ask 请求 */
export function hasPendingAsk(): boolean {
  return pendingAsk !== null;
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
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { questions } = params as AskToolArgs;

    // 创建 promise 等待用户响应
    const answerPromise = new Promise<AskAnswer[] | null>((resolve) => {
      pendingAsk = { questions, resolve };
    });

    // 通知渲染进程展示 UI
    if (askNotifier) {
      askNotifier(questions);
    }

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
