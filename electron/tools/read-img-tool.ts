/**
 * read_img 工具：用视觉模型描述图片。
 *
 * 场景：当前会话模型不支持视觉（model.input 不含 "image"）时，agent 无法直接
 * "看"图片（用户上传的图片/截图）。read_img 把图片路径交给用户在设置页配置的
 * 视觉模型，取回文字描述作为工具结果，让非视觉模型间接获得图片理解能力。
 *
 * 工具注入规则（PiBridge 管理，见 syncReadImgTool）：
 * - 未配置视觉模型 → 任何情况都不注册
 * - 当前模型支持视觉 → 不注入（agent 直接可看图）
 * - 当前模型不支持视觉且已配置 → 注入
 *
 * IPC 数据流：与 ask 工具同模式——工具 execute 在主进程内直接调用
 * modelRuntime.complete()（无需经过渲染进程）。
 *
 * 调用参数注意（都是踩过的坑）：
 * - 必须显式传 reasoningEffort：不传时 SDK 会回落到 model.thinkingLevelMap.off
 *   （models.json 里默认是 "off"），JD 网关等上游会以 400 拒绝 "off"，
 *   表现为 stopReason=error + 空 content。
 * - opencode 系供应商按会话路由，缺 x-opencode-session 头会 400 MissingSessionID。
 * - complete() 出错时**不抛异常**，而是 resolve 出 stopReason='error' + 空 content，
 *   真实原因在 result.errorMessage，必须显式读取，否则只剩"未返回内容"。
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** 图片识别模型配置（ui-config.json 的 readImgModel 字段） */
export interface ReadImgModelConfig {
  provider: string;
  modelId: string;
}

/** 当前配置（由 pi-bridge 启动时注入） */
let readImgModel: ReadImgModelConfig | null = null;

/** modelRuntime 访问器（由 pi-bridge 注入，避免循环依赖） */
let modelRuntimeAccessor: (() => any) | null = null;

/** 注入配置（pi-bridge 启动/设置页变更时调用） */
export function setReadImgModelConfig(config: ReadImgModelConfig | null): void {
  readImgModel = config;
}

export function getReadImgModelConfig(): ReadImgModelConfig | null {
  return readImgModel;
}

export function setModelRuntimeAccessor(accessor: () => any): void {
  modelRuntimeAccessor = accessor;
}

/** 支持的图片 MIME（按扩展名映射；不认识的扩展名拒绝） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

/** 读文件并转 base64；不支持的扩展名/空文件返回 null（空文件会变成空图片，必须拒绝） */
function readImageBase64(filePath: string): { data: string; mimeType: string } | null {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return null;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) return null;
    return { data: buf.toString('base64'), mimeType };
  } catch {
    return null;
  }
}

/** read_img 调视觉模型时的思考档位：低档即可，且是各上游都接受的档位（medium 会被部分模型拒绝） */
const READ_IMG_REASONING_EFFORT = 'low';

/**
 * 构造按会话路由的供应商所需的请求头。
 * opencode 系（opencode / opencode-go）要求 x-opencode-session，缺失时返回
 * 400 MissingSessionID（"cannot be routed efficiently"）。
 */
function buildReadImgHeaders(model: any): Record<string, string> {
  const providerId = String(model?.provider ?? '');
  if (providerId.includes('opencode')) {
    return { 'x-opencode-session': `piui-readimg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
  }
  return {};
}

/** MIME → 扩展名（落盘临时文件用） */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

/**
 * 把用户随消息发送的图片落盘为临时文件（供非视觉模型场景引用）。
 * 原因：pi-ai transform-messages 对非视觉模型会把 image 块替换成
 * 无信息量占位符 "(image omitted...)"，模型完全看不到图片的存在。
 * 落盘后在文本中注入路径，模型可用 read_img 识别，或至少知道图片存在。
 * @returns 成功保存的绝对路径列表
 */
export function saveImagesToTempFiles(images: Array<{ data: string; mimeType: string }>): string[] {
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img.data !== 'string') continue;
    const ext = EXT_BY_MIME[img.mimeType] ?? '.png';
    const file = path.join(os.tmpdir(), `piui-img-${Date.now()}-${i}${ext}`);
    try {
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      paths.push(file);
    } catch {
      // 单张保存失败跳过，不阻塞消息发送
    }
  }
  return paths;
}

/** read_img 工具定义 */
export const readImgTool = defineTool({
  name: 'read_img',
  label: '图片识别',
  description: `读取图片文件并返回详细文字描述。当前模型不支持直接查看图片，此工具用视觉模型代为识别。
参数：
- path: 图片文件的绝对或相对路径（支持 png/jpg/jpeg/gif/webp/bmp）
- question: 可选，针对图片的具体问题（如"图中的报错信息是什么"）；不填则返回图片的完整通用描述
适用于：用户提到的截图、设计稿、图表、报错截图等图片内容理解。`,
  promptSnippet: '识别图片内容（当前模型不支持视觉时使用）',
  promptGuidelines: [
    '需要理解图片内容时使用 read_img（当前模型无法直接查看图片）',
    '有具体关注点时传 question 参数，会得到针对性回答'
  ],
  parameters: Type.Object({
    path: Type.String({ description: '图片文件路径' }),
    question: Type.Optional(Type.String({ description: '针对图片的问题（可选）' }))
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { path: imgPath, question } = params as { path: string; question?: string };

    // ① 前置校验：配置与模型可用
    if (!readImgModel) {
      return {
        content: [{ type: 'text', text: '未配置图片识别模型，无法识别图片。请用户在设置页配置。' }],
        details: { error: 'no_model_configured' }
      };
    }
    const runtime = modelRuntimeAccessor?.();
    if (!runtime) {
      return {
        content: [{ type: 'text', text: '模型运行时不可用，无法识别图片。' }],
        details: { error: 'no_runtime' }
      };
    }
    const model = runtime.getModel?.(readImgModel.provider, readImgModel.modelId);
    if (!model) {
      return {
        content: [
          {
            type: 'text',
            text: `图片识别模型不可用：${readImgModel.provider}/${readImgModel.modelId}。请用户在设置页重新配置。`
          }
        ],
        details: { error: 'model_not_found' }
      };
    }

    // 配置的模型必须声明图片输入能力：否则 pi-ai 会在发请求前把 image 块替换成
    // "(image omitted...)" 占位符，模型只会回"我看不到图片"，看起来像识别失败。
    if (!Array.isArray(model.input) || !model.input.includes('image')) {
      return {
        content: [
          {
            type: 'text',
            text: `配置的图片识别模型（${readImgModel.provider}/${readImgModel.modelId}）未声明图片输入能力，无法识别图片。请用户在设置页改选支持视觉的模型。`
          }
        ],
        details: { error: 'model_not_vision' }
      };
    }

    // ② 读图片文件
    const absPath = path.isAbsolute(imgPath)
      ? imgPath
      : path.resolve(_ctx?.cwd ?? process.cwd(), imgPath);
    const image = readImageBase64(absPath);
    if (!image) {
      return {
        content: [
          {
            type: 'text',
            text: `无法读取图片：${imgPath}（文件不存在、文件为空或格式不支持，支持 png/jpg/jpeg/gif/webp/bmp）`
          }
        ],
        details: { error: 'read_failed', path: absPath }
      };
    }

    // ③ 调视觉模型取描述
    const prompt = question?.trim()
      ? `请针对这张图片回答以下问题，用中文详细作答：\n${question.trim()}`
      : '请用中文详细描述这张图片的内容，包括可见的文字、图表数据、UI 布局或报错信息等关键细节。';

    try {
      const result = await runtime.complete(model, {
        systemPrompt:
          '你是图片识别助手。根据图片内容准确、详细地回答问题，不要编造图中不存在的内容。',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image', data: image.data, mimeType: image.mimeType }
            ],
            timestamp: Date.now()
          }
        ]
      },
      {
        reasoningEffort: READ_IMG_REASONING_EFFORT,
        headers: buildReadImgHeaders(model)
      });

      // complete() 出错时不抛异常，而是返回 stopReason='error' + 空 content，
      // 真实原因在 errorMessage：必须显式暴露，否则用户只看到"未返回内容"。
      if (result?.stopReason === 'error') {
        const reason = String(result?.errorMessage ?? '').trim();
        return {
          content: [
            {
              type: 'text',
              text: `图片识别模型调用失败（${readImgModel.provider}/${readImgModel.modelId}）：${
                reason || '上游返回错误但未提供错误信息'
              }`
            }
          ],
          details: { error: 'model_error', message: reason || null }
        };
      }

      // 提取 assistant 文本
      const text =
        result?.content
          ?.filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text || '')
          .join('\n') ?? '';

      if (!text) {
        // 有些推理模型会把 maxTokens 全用在思考上，正文为空：区分开，避免误报
        const thinking = result?.content
          ?.filter((c: any) => c?.type === 'thinking')
          .map((c: any) => c.thinking || '')
          .join('\n')
          ?.trim();
        return {
          content: [
            {
              type: 'text',
              text: thinking
                ? '图片识别模型只返回了思考内容、没有输出正文，请重试或换用其他视觉模型。'
                : '图片识别模型未返回内容。'
            }
          ],
          details: { error: 'empty_response', stopReason: result?.stopReason ?? null }
        };
      }

      const details = {
        model: `${readImgModel.provider}/${readImgModel.modelId}`,
        path: absPath,
        question: question?.trim() || null
      };
      const result2: AgentToolResult<typeof details> = {
        content: [{ type: 'text', text }],
        details
      };
      return result2;
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `图片识别调用失败：${err instanceof Error ? err.message : String(err)}`
          }
        ],
        details: { error: 'call_failed' }
      };
    }
  }
});
