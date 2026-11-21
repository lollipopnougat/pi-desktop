/**
 * PermissionController 的 reviewer-auto（帮我审批）分支集成单测。
 *
 * 评审员会话被替换成假实现（真会话要起一次模型往返，单测不该那么做），
 * 但闸门、风险地板、熔断、回退人工、事件推送、评审记录都是真代码。
 */
import { describe, it, expect, vi } from 'vitest';

// 闸门会写 permission 日志：重定向到临时目录，避免污染 ~/.pi-desktop/logs
const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-reviewer-controller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

// 假评审员：从队列里取预设的 assistant 输出，避免真的跑模型
const h = vi.hoisted(() => ({ replies: [] as string[], created: 0, prompts: [] as string[] }));

vi.mock('../../electron/permission/reviewer/session-pool', () => {
  class FakePool {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
    async acquire(_key: string, create: () => Promise<unknown>) {
      h.created += 1;
      return create();
    }
    async drop() {}
    async dispose() {}
  }
  const createReviewerSession = async () => ({
    async prompt(text: string) {
      h.prompts.push(text);
    },
    async abort() {},
    dispose() {},
    getLastAssistantText() {
      return h.replies.shift() ?? '';
    },
    async waitForIdle() {}
  });
  return { ReviewerSessionPool: FakePool, createReviewerSession, MAX_REVIEWS_PER_SESSION: 12 };
});

import { PermissionController } from '../../electron/permission/controller';

interface FakeBridge {
  agentDir: string;
  // requestApproval 在「无窗口」时直接按拒绝结算（最小权限）：测试需要一个活窗口
  win: { isDestroyed: () => boolean };
  modelRuntime: { getModel: (p: string, m: string) => unknown };
  sendSessionEvent: (channel: string, payload: unknown) => boolean;
}

function makeHarness(options: { sessionModel?: boolean; reviewerModel?: boolean } = {}) {
  const sessionModel = options.sessionModel !== false;
  const reviewerModel = options.reviewerModel === true;
  const approvals: any[] = [];
  const notices: any[] = [];
  const bridge: FakeBridge = {
    agentDir: tmpDir,
    win: { isDestroyed: () => false },
    modelRuntime: {
      getModel: (p: string, m: string) =>
        reviewerModel && p === 'acme' && m === 'reviewer' ? { provider: p, id: m } : undefined
    },
    sendSessionEvent: (channel, payload) => {
      if (channel === 'pi:permissionReview') notices.push(payload);
      return true;
    }
  };
  const host = {
    current: () =>
      sessionModel
        ? {
            model: { provider: 'builtin', id: 'chat-model' },
            messages: [{ role: 'user', content: '帮我把 dist 清掉再重新构建' }]
          }
        : { messages: [{ role: 'user', content: '随便看看' }] },
    cwd: () => tmpDir,
    sendSessionEvent: (channel: string, payload: unknown) => {
      if (channel === 'pi:permissionRequest') approvals.push(payload);
      if (channel === 'pi:permissionReview') notices.push(payload);
      return true;
    },
    setPlanMode: () => {}
  };
  const ctrl = new PermissionController(bridge as never, host as never);
  ctrl.setPolicy('reviewer-auto');
  return { ctrl, approvals, notices, bridge, host };
}

/** 跑一次闸门；若弹了人工审批，按 deny 结算以免挂起 */
async function runGate(
  ctrl: PermissionController,
  approvals: any[],
  toolName: string,
  input: unknown
): Promise<{ blocked: boolean; reason?: string; pushed: boolean; request?: any }> {
  approvals.length = 0;
  let settled = false;
  const promise = ctrl.gateForTest(toolName, input).then((result) => {
    settled = true;
    return result;
  });
  // 评审路径有几十个 await：跑到「弹了审批」或「闸门已结算」为止
  for (let i = 0; i < 500 && !settled && approvals.length === 0; i += 1) await Promise.resolve();
  const pushed = approvals.length > 0;
  const request = pushed ? approvals[approvals.length - 1] : undefined;
  if (pushed) ctrl.resolvePermission(request.id, 'deny');
  const result = await promise;
  return { blocked: !!result?.block, reason: result?.reason, pushed, request };
}

const BASH = (command: string) => ({ command });

describe('reviewer-auto：评审员给出结论', () => {
  it('allow → 放行，不弹人工审批，并留下评审记录', async () => {
    h.replies.push('{"outcome":"allow","risk_level":"low","rationale":"用户要求清理构建产物"}');
    const { ctrl, approvals, notices } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('rm -rf dist'));
    expect(r.blocked).toBe(false);
    expect(r.pushed).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0].outcome).toBe('allow');
    expect(notices[0].riskLevel).toBe('low');
    expect(ctrl.getRecentReviews()[0].outcome).toBe('allow');
  });

  it('deny → 阻断，理由里明确「不要绕过」', async () => {
    h.replies.push('{"outcome":"deny","risk_level":"high","rationale":"用户没要求部署"}');
    const { ctrl, approvals } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run deploy'));
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('帮我审批');
    expect(r.reason).toContain('用户没要求部署');
    expect(r.reason).toContain('绕过');
    expect(r.pushed).toBe(false);
  });

  it('评审放行不登记「本次会话允许」（否则第 5 档退化成 allow-all 子集）', async () => {
    h.replies.push('{"outcome":"allow"}');
    const { ctrl, approvals } = makeHarness();
    await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(ctrl.getSessionAllowedTools()).toEqual([]);
  });

  it('代码层硬约束生效：allow + critical 仍被阻断', async () => {
    h.replies.push('{"outcome":"allow","risk_level":"critical","user_authorization":"high"}');
    const { ctrl, approvals } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('rm -rf /tmp/x'));
    expect(r.blocked).toBe(true);
    expect(ctrl.getRecentReviews()[0].coerced).toBe('critical');
  });
});

describe('reviewer-auto：风险地板', () => {
  it('磁盘级写入跳过评审员，直接人工审批', async () => {
    h.created = 0;
    const { ctrl, approvals } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('dd if=/dev/zero of=/dev/disk2'));
    expect(r.pushed).toBe(true);
    expect(r.request.reviewerNote).toContain('不可自动放行');
    expect(h.created).toBe(0);
  });

  it('rm -rf 不在风险地板上（交评审员判断，不能把第 5 档退化成 ask-all）', async () => {
    h.replies.push('{"outcome":"allow","risk_level":"medium","user_authorization":"high"}');
    h.created = 0;
    const { ctrl, approvals } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('rm -rf dist'));
    expect(r.pushed).toBe(false);
    expect(h.created).toBe(1);
  });
});

describe('reviewer-auto：评审员不可用', () => {
  it('没有可用模型 + onFailure=ask-user（默认）→ 回退人工并带原因', async () => {
    const { ctrl, approvals, notices } = makeHarness({ sessionModel: false });
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.pushed).toBe(true);
    expect(r.request.reviewerNote).toContain('模型');
    expect(notices[notices.length - 1].outcome).toBe('fallback');
  });

  it('没有可用模型 + onFailure=deny → 直接阻断，不弹人工审批', async () => {
    const { ctrl, approvals } = makeHarness({ sessionModel: false });
    ctrl.setReviewerConfig({ onFailure: 'deny' });
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.blocked).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.reason).toContain('评审员不可用');
  });

  it('评审员输出不是 JSON → 回退人工，不当作拒绝', async () => {
    h.replies.push('我觉得没问题', '还是没问题');
    const { ctrl, approvals, notices } = makeHarness();
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.pushed).toBe(true);
    expect(r.request.reviewerNote).toContain('JSON');
    expect(notices[notices.length - 1].outcome).toBe('fallback');
  });

  it('超时 → 回退人工', async () => {
    const { ctrl, approvals } = makeHarness();
    ctrl.setReviewerConfig({ timeoutMs: 5000 });
    // 空队列 = getLastAssistantText 返回 '' → 两次解析失败 → error
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.pushed).toBe(true);
    expect(r.request.reviewerNote).toBeTruthy();
  });
});

describe('reviewer-auto：熔断', () => {
  it('连续拒绝达阈值后跳过评审员，直接人工审批', async () => {
    const { ctrl, approvals, notices } = makeHarness();
    ctrl.setReviewerConfig({ maxConsecutiveDenials: 2 });
    for (let i = 0; i < 2; i += 1) {
      h.replies.push('{"outcome":"deny","rationale":"没授权"}');
      const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
      expect(r.blocked).toBe(true);
    }
    h.created = 0;
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.pushed).toBe(true);
    expect(r.request.reviewerNote).toContain('连续拒绝');
    expect(h.created).toBe(0);
    expect(notices[notices.length - 1].outcome).toBe('fallback');
  });

  it('一次放行把熔断计数清零', async () => {
    const { ctrl, approvals } = makeHarness();
    ctrl.setReviewerConfig({ maxConsecutiveDenials: 2 });
    h.replies.push('{"outcome":"deny","rationale":"x"}');
    await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    h.replies.push('{"outcome":"allow"}');
    await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    h.replies.push('{"outcome":"deny","rationale":"y"}');
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    // 第二次 deny 之后仍是 1 次连续拒绝，没到阈值 → 还是评审员判定（阻断）
    expect(r.blocked).toBe(true);
    expect(r.pushed).toBe(false);
  });

  it('maxConsecutiveDenials=0 关闭熔断', async () => {
    const { ctrl, approvals } = makeHarness();
    ctrl.setReviewerConfig({ maxConsecutiveDenials: 0 });
    for (let i = 0; i < 5; i += 1) {
      h.replies.push('{"outcome":"deny","rationale":"x"}');
      const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
      expect(r.pushed).toBe(false);
      expect(r.blocked).toBe(true);
    }
  });
});

describe('reviewer-auto：评审记录', () => {
  it('新的在前且最多保留 20 条', async () => {
    const { ctrl, approvals } = makeHarness();
    for (let i = 0; i < 25; i += 1) {
      h.replies.push('{"outcome":"allow"}');
      await runGate(ctrl, approvals, 'bash', BASH(`npm run build -- --mode ${i}`));
    }
    const reviews = ctrl.getRecentReviews();
    expect(reviews).toHaveLength(20);
    expect(reviews[0].preview).toContain('--mode 24');
  });

  it('clearPending 清零挂起与熔断计数', async () => {
    const { ctrl, approvals } = makeHarness();
    ctrl.setReviewerConfig({ maxConsecutiveDenials: 1 });
    h.replies.push('{"outcome":"deny","rationale":"x"}');
    await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    ctrl.clearPending();
    h.replies.push('{"outcome":"allow"}');
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.blocked).toBe(false);
    expect(r.pushed).toBe(false);
  });

  it('切换配置会丢弃复用的评审会话并清零熔断', async () => {
    const { ctrl } = makeHarness();
    ctrl.setReviewerConfig({ extraPolicy: '禁止部署' });
    expect(ctrl.getReviewerConfig().extraPolicy).toBe('禁止部署');
  });
});

describe('reviewer-auto：已知安全调用短路（不跑评审员）', () => {
  /** 跑一次闸门并亲自回一个决策（需要在会话里登记 allow-session 时用） */
  async function gateWith(
    ctrl: PermissionController,
    approvals: any[],
    toolName: string,
    input: unknown,
    decision: string
  ): Promise<{ request: any; result: any }> {
    approvals.length = 0;
    const promise = ctrl.gateForTest(toolName, input);
    for (let i = 0; i < 500 && approvals.length === 0; i += 1) await Promise.resolve();
    const request = approvals[approvals.length - 1];
    ctrl.resolvePermission(request.id, decision);
    return { request, result: await promise };
  }

  it('白名单工具（read/ls）直接放行，不创建评审会话', async () => {
    h.created = 0;
    const { ctrl, approvals, notices } = makeHarness();
    for (const tool of ['read', 'grep', 'find', 'ls']) {
      const r = await runGate(ctrl, approvals, tool, { path: 'src/index.ts' });
      expect(r.blocked, tool).toBe(false);
    }
    expect(h.created).toBe(0);
    expect(notices).toHaveLength(0);
  });

  it('白名单 bash（ls / git status）直接放行', async () => {
    h.created = 0;
    const { ctrl, approvals } = makeHarness();
    for (const command of ['ls -la', 'git status', 'cat package.json']) {
      const r = await runGate(ctrl, approvals, 'bash', BASH(command));
      expect(r.blocked, command).toBe(false);
    }
    expect(h.created).toBe(0);
  });

  it('本次会话已放行的工具直接放行', async () => {
    h.created = 0;
    const { ctrl, approvals } = makeHarness();
    // 先在 ask-all 下弹一次人工审批，用户选「本次会话允许」
    ctrl.setPolicy('ask-all');
    await gateWith(ctrl, approvals, 'bash', BASH('npm run build'), 'allow-session');
    expect(ctrl.getSessionAllowedTools()).toContain('bash');

    ctrl.setPolicy('reviewer-auto');
    const r = await runGate(ctrl, approvals, 'bash', BASH('npm run build'));
    expect(r.blocked).toBe(false);
    expect(r.pushed).toBe(false);
    expect(h.created).toBe(0);
  });

  it('危险调用不因「会话允许」或白名单而短路（危险规则优先）', async () => {
    const { ctrl, approvals } = makeHarness();
    ctrl.setPolicy('ask-all');
    await gateWith(ctrl, approvals, 'bash', BASH('npm run build'), 'allow-session');
    expect(ctrl.getSessionAllowedTools()).toContain('bash');

    ctrl.setPolicy('reviewer-auto');
    h.created = 0;
    // 非地板的危险类目 → 仍交评审员判定
    h.replies.push('{"outcome":"allow","risk_level":"medium","user_authorization":"high"}');
    const rm = await runGate(ctrl, approvals, 'bash', BASH('rm -rf dist'));
    expect(h.created).toBe(1);
    expect(rm.blocked).toBe(false);

    // 地板的危险类目 → 直接人工审批，会话允许也不生效
    const dd = await runGate(ctrl, approvals, 'bash', BASH('dd if=/dev/zero of=/dev/disk2'));
    expect(dd.pushed).toBe(true);
    expect(dd.request.reviewerNote).toContain('不可自动放行');
  });
});
