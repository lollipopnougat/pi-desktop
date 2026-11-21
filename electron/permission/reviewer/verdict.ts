/**
 * 评审员输出的解析与**代码层硬约束**（纯函数，无 IO）。
 *
 * 提示词要求严格 JSON，但模型输出永远不可全信 —— 所以这里做两件事：
 * 1. 容错解析：裸 JSON / ```json 围栏 / 前后夹带解释文字都能取出来，取不出就返回 null
 *    （null = 评审不可用，由调用方按 `onFailure` 回退人工或拒绝，**不猜**）。
 * 2. 硬约束：`critical` 必须拒绝、`high` 无授权必须拒绝。这两条不依赖提示词的听话程度，
 *    即使模型输出 `{"risk_level":"critical","outcome":"allow"}` 也会被改写成拒绝。
 *
 * 为什么要在代码里再挡一次：提示词会随模型/语言漂移，而"凭据外泄"这种动作的代价不可逆。
 */

export type ReviewRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ReviewAuthorization = 'unknown' | 'low' | 'medium' | 'high';

const RISK_LEVELS: ReviewRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const AUTHORIZATIONS: ReviewAuthorization[] = ['unknown', 'low', 'medium', 'high'];

export interface ReviewerVerdict {
  outcome: 'allow' | 'deny';
  riskLevel?: ReviewRiskLevel;
  userAuthorization?: ReviewAuthorization;
  /** 一句话主因（展示给用户与模型） */
  rationale: string;
  /**
   * 代码层强制改写的痕迹（模型说 allow 但被硬约束改成 deny）：
   * - 'critical'：风险等级为 critical
   * - 'unauthorized-high'：high 风险但没有足够授权
   */
  coerced?: 'critical' | 'unauthorized-high';
}

/** 拒绝但模型没给理由时的兜底文案（不能出现空理由，否则用户无从判断） */
export const DEFAULT_DENY_RATIONALE = '评审员认为该操作风险高于当前授权范围';

/** rationale 上限（面板展示 + 日志体积） */
const MAX_RATIONALE_CHARS = 400;

function isRiskLevel(value: unknown): value is ReviewRiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as string[]).includes(value);
}

function isAuthorization(value: unknown): value is ReviewAuthorization {
  return typeof value === 'string' && (AUTHORIZATIONS as string[]).includes(value);
}

/** 从模型输出里取出 JSON 文本：优先围栏块，其次首个 `{` 到末个 `}` */
export function extractJsonObject(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]?.trim()) {
    const body = fenced[1].trim();
    if (body.startsWith('{')) return body;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * 解析评审员输出。返回 `null` 表示**这次的输出不可用**（不是拒绝，是"没判出来"）。
 */
export function parseReviewerVerdict(text: string | null | undefined): ReviewerVerdict | null {
  if (typeof text !== 'string') return null;
  const json = extractJsonObject(text);
  if (!json) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const outcome = record.outcome;
  if (outcome !== 'allow' && outcome !== 'deny') return null;

  const riskLevel = isRiskLevel(record.risk_level) ? record.risk_level : undefined;
  const userAuthorization = isAuthorization(record.user_authorization)
    ? record.user_authorization
    : undefined;
  const rawRationale = typeof record.rationale === 'string' ? record.rationale.trim() : '';
  const rationale = rawRationale.slice(0, MAX_RATIONALE_CHARS);

  const verdict: ReviewerVerdict = {
    outcome,
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    rationale: rationale || (outcome === 'deny' ? DEFAULT_DENY_RATIONALE : '')
  };

  // 硬约束一：critical 不可被放行
  if (verdict.outcome === 'allow' && riskLevel === 'critical') {
    return {
      ...verdict,
      outcome: 'deny',
      coerced: 'critical',
      rationale: `风险等级 critical 不可自动放行${rationale ? `：${rationale}` : ''}`
    };
  }

  // 硬约束二：high 风险必须有 medium 以上的授权
  if (
    verdict.outcome === 'allow' &&
    riskLevel === 'high' &&
    (userAuthorization === undefined ||
      userAuthorization === 'unknown' ||
      userAuthorization === 'low')
  ) {
    return {
      ...verdict,
      outcome: 'deny',
      coerced: 'unauthorized-high',
      rationale: `高风险操作但未能确认用户授权${rationale ? `：${rationale}` : ''}`
    };
  }

  return verdict;
}
