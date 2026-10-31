/**
 * 评审员输出解析单测。
 *
 * 这里守的是**不依赖提示词听话**的两条硬约束（提示词写得很清楚，但模型不一定听）：
 * - allow + critical → 必须 deny（极高风险不可自动放行）
 * - allow + high 且授权缺失/unknown/low → 必须 deny
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DENY_RATIONALE,
  extractJsonObject,
  parseReviewerVerdict
} from '../../electron/permission/reviewer/verdict';

describe('extractJsonObject', () => {
  it('裸 JSON', () => {
    expect(extractJsonObject('{"outcome":"allow"}')).toBe('{"outcome":"allow"}');
  });

  it('```json 围栏', () => {
    expect(extractJsonObject('```json\n{"outcome":"deny"}\n```')).toBe('{"outcome":"deny"}');
  });

  it('围栏里的内容不是对象时退回花括号截取', () => {
    expect(extractJsonObject('```json\n[1,2]\n```\n{"outcome":"allow"}')).toBe(
      '{"outcome":"allow"}'
    );
  });

  it('带前后说明文字', () => {
    expect(extractJsonObject('结论如下：\n{"outcome":"allow"}\n以上。')).toBe(
      '{"outcome":"allow"}'
    );
  });

  it('没有对象时返回 null', () => {
    expect(extractJsonObject('allow')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('parseReviewerVerdict', () => {
  it('低风险可简写为 {"outcome":"allow"}', () => {
    expect(parseReviewerVerdict('{"outcome":"allow"}')).toEqual({
      outcome: 'allow',
      rationale: ''
    });
  });

  it('完整四字段', () => {
    expect(
      parseReviewerVerdict(
        '{"risk_level":"medium","user_authorization":"high","outcome":"allow","rationale":"用户要求清理构建产物"}'
      )
    ).toEqual({
      outcome: 'allow',
      riskLevel: 'medium',
      userAuthorization: 'high',
      rationale: '用户要求清理构建产物'
    });
  });

  it('非法 JSON / 缺 outcome / outcome 非法都返回 null', () => {
    expect(parseReviewerVerdict('not json')).toBeNull();
    expect(parseReviewerVerdict('{"risk_level":"low"}')).toBeNull();
    expect(parseReviewerVerdict('{"outcome":"maybe"}')).toBeNull();
    expect(parseReviewerVerdict('')).toBeNull();
    expect(parseReviewerVerdict(null)).toBeNull();
    expect(parseReviewerVerdict(undefined)).toBeNull();
  });

  it('非法 risk_level / user_authorization 被丢弃但结论保留', () => {
    expect(parseReviewerVerdict('{"outcome":"deny","risk_level":"catastrophic"}')).toEqual({
      outcome: 'deny',
      rationale: DEFAULT_DENY_RATIONALE
    });
    expect(parseReviewerVerdict('{"outcome":"allow","user_authorization":"total"}')).toEqual({
      outcome: 'allow',
      rationale: ''
    });
  });

  it('deny 且理由为空时补默认理由（面板不能出现空理由）', () => {
    expect(parseReviewerVerdict('{"outcome":"deny"}')?.rationale).toBe(DEFAULT_DENY_RATIONALE);
    expect(parseReviewerVerdict('{"outcome":"deny","rationale":"   "}')?.rationale).toBe(
      DEFAULT_DENY_RATIONALE
    );
  });

  it('理由超长截到 400 字符', () => {
    const verdict = parseReviewerVerdict(
      JSON.stringify({ outcome: 'deny', rationale: 'x'.repeat(1000) })
    );
    expect(verdict?.rationale).toHaveLength(400);
  });

  it('硬约束：allow + critical → deny', () => {
    const verdict = parseReviewerVerdict(
      '{"outcome":"allow","risk_level":"critical","user_authorization":"high","rationale":"用户要求"}'
    );
    expect(verdict?.outcome).toBe('deny');
    expect(verdict?.coerced).toBe('critical');
  });

  it('硬约束：allow + high 且授权缺失/unknown/low → deny', () => {
    for (const auth of ['unknown', 'low', undefined]) {
      const payload = JSON.stringify({
        outcome: 'allow',
        risk_level: 'high',
        ...(auth ? { user_authorization: auth } : {})
      });
      const verdict = parseReviewerVerdict(payload);
      expect(verdict?.outcome, `auth=${auth}`).toBe('deny');
      expect(verdict?.coerced).toBe('unauthorized-high');
    }
  });

  it('allow + high 但授权 medium/high 时保持放行', () => {
    for (const auth of ['medium', 'high']) {
      const verdict = parseReviewerVerdict(
        JSON.stringify({ outcome: 'allow', risk_level: 'high', user_authorization: auth })
      );
      expect(verdict?.outcome, `auth=${auth}`).toBe('allow');
      expect(verdict?.coerced).toBeUndefined();
    }
  });

  it('deny + critical 不加 coerced 标记（本来就是拒绝）', () => {
    const verdict = parseReviewerVerdict('{"outcome":"deny","risk_level":"critical"}');
    expect(verdict?.outcome).toBe('deny');
    expect(verdict?.coerced).toBeUndefined();
  });
});
