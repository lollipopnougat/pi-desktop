/**
 * 「帮我审批」（reviewer-auto）配置归一化单测。
 *
 * 重点守两件事：
 * - 非法/缺字段的配置不能抛错，只能被丢弃（设置页坏数据不能把闸门搞崩）
 * - 数值必须 clamp 到安全区间（超时太小 = 评审名存实亡；熔断阈值过大 = 等于没熔断）
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_REVIEWER_MAX_DENIALS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  PERMISSION_POLICIES,
  isPermissionPolicy,
  normalizeReviewerApprovalConfig
} from '../../electron/permission/policy';

describe('reviewer-auto 策略枚举', () => {
  it('包含第 5 档且默认策略不变', () => {
    expect(PERMISSION_POLICIES).toContain('reviewer-auto');
    expect(PERMISSION_POLICIES).toHaveLength(5);
    // 默认值绝不能被新档位改掉：老用户升级后行为必须不变
    expect(DEFAULT_PERMISSION_POLICY).toBe('auto-safe');
  });

  it('isPermissionPolicy 认得 reviewer-auto，不认近似值', () => {
    expect(isPermissionPolicy('reviewer-auto')).toBe(true);
    expect(isPermissionPolicy('reviewer')).toBe(false);
    expect(isPermissionPolicy('auto-review')).toBe(false);
  });
});

describe('normalizeReviewerApprovalConfig', () => {
  it('空/非法输入回退空配置', () => {
    expect(normalizeReviewerApprovalConfig(undefined)).toEqual({});
    expect(normalizeReviewerApprovalConfig(null)).toEqual({});
    expect(normalizeReviewerApprovalConfig('nope')).toEqual({});
    expect(normalizeReviewerApprovalConfig(42)).toEqual({});
    expect(normalizeReviewerApprovalConfig([])).toEqual({});
  });

  it('providerId/modelId 必须成对，单边丢弃', () => {
    expect(normalizeReviewerApprovalConfig({ providerId: 'p' })).toEqual({});
    expect(normalizeReviewerApprovalConfig({ modelId: 'm' })).toEqual({});
    expect(normalizeReviewerApprovalConfig({ providerId: 'p', modelId: 'm' })).toEqual({
      providerId: 'p',
      modelId: 'm'
    });
  });

  it('超时 clamp 到 5000~180000', () => {
    expect(normalizeReviewerApprovalConfig({ timeoutMs: 1 }).timeoutMs).toBe(5000);
    expect(normalizeReviewerApprovalConfig({ timeoutMs: 999999 }).timeoutMs).toBe(180000);
    expect(normalizeReviewerApprovalConfig({ timeoutMs: 20000 }).timeoutMs).toBe(20000);
    // 非数字直接丢弃（不是回退默认值：让 DEFAULT 常量在消费处生效）
    expect(normalizeReviewerApprovalConfig({ timeoutMs: 'abc' })).toEqual({});
    expect(DEFAULT_REVIEWER_TIMEOUT_MS).toBe(45000);
  });

  it('onFailure 只接受 ask-user / deny', () => {
    expect(normalizeReviewerApprovalConfig({ onFailure: 'ask-user' }).onFailure).toBe('ask-user');
    expect(normalizeReviewerApprovalConfig({ onFailure: 'deny' }).onFailure).toBe('deny');
    expect(normalizeReviewerApprovalConfig({ onFailure: 'allow' })).toEqual({});
  });

  it('熔断阈值 clamp 到 0~10（0 = 关闭熔断）', () => {
    expect(
      normalizeReviewerApprovalConfig({ maxConsecutiveDenials: 0 }).maxConsecutiveDenials
    ).toBe(0);
    expect(
      normalizeReviewerApprovalConfig({ maxConsecutiveDenials: -5 }).maxConsecutiveDenials
    ).toBe(0);
    expect(
      normalizeReviewerApprovalConfig({ maxConsecutiveDenials: 99 }).maxConsecutiveDenials
    ).toBe(10);
    expect(DEFAULT_REVIEWER_MAX_DENIALS).toBe(3);
  });

  it('extraPolicy 去空白、超长截断、空串丢弃', () => {
    expect(normalizeReviewerApprovalConfig({ extraPolicy: '   ' })).toEqual({});
    expect(normalizeReviewerApprovalConfig({ extraPolicy: '  禁止部署  ' }).extraPolicy).toBe(
      '禁止部署'
    );
    const long = normalizeReviewerApprovalConfig({ extraPolicy: 'x'.repeat(5000) });
    expect(long.extraPolicy).toHaveLength(4000);
  });

  it('readOnlyTools 只认布尔值', () => {
    expect(normalizeReviewerApprovalConfig({ readOnlyTools: false }).readOnlyTools).toBe(false);
    expect(normalizeReviewerApprovalConfig({ readOnlyTools: true }).readOnlyTools).toBe(true);
    expect(normalizeReviewerApprovalConfig({ readOnlyTools: 'yes' })).toEqual({});
  });

  it('未知字段被丢弃（白名单语义）', () => {
    expect(
      normalizeReviewerApprovalConfig({ timeoutMs: 20000, unknownField: 'x', autoAllow: true })
    ).toEqual({ timeoutMs: 20000 });
  });
});
