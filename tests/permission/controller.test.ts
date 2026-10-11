/**
 * PermissionController「本次会话允许」逻辑单测。
 *
 * 用最小 fake PiBridge（win.webContents.send 收集推送的审批请求）驱动：
 * - allow-session 决策后，同名工具在会话内自动放行（不再弹审批）
 * - 其他工具不受影响，仍走审批
 * - clearPending（会话切换）后恢复逐次审批
 */
import { describe, it, expect, vi } from 'vitest';

// 闸门现在会写 tools / permission 日志：把日志目录重定向到临时目录，避免污染用户的 ~/.pi-desktop/logs
const { tmpDir } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-permission-controller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir };
});

vi.mock('../../electron/config-dir', () => ({ DESKTOP_AGENT_DIR: tmpDir }));

import { PermissionController } from '../../electron/permission/controller';

/** 最小 fake PiBridge：捕获审批推送，并提供手动回决策的入口 */
function makeFakeBridge() {
  const requests: { id: string; toolName: string; preview: string; requestedAt: number }[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, request: any) => {
        requests.push(request);
      }
    }
  };
  const bridge = {
    win,
    sendSessionEvent: (channel: string, request: unknown) => {
      win.webContents.send(channel, request);
      return true;
    }
  } as any;
  return { bridge, requests };
}

/** 推动闸门：返回本次是否弹了审批（true）以及弹出的请求 */
async function runGate(
  ctrl: PermissionController,
  fake: ReturnType<typeof makeFakeBridge>,
  toolName: string,
  input: unknown
): Promise<{ blocked: boolean; reason?: string; pushed: boolean }> {
  fake.requests.length = 0; // 只统计本次调用弹出的审批
  const promise = ctrl.gateForTest(toolName, input);
  // 等待微任务队列跑完（若弹审批，promise 挂起；若放行，直接 resolve）
  await Promise.resolve();
  await Promise.resolve();
  const pushed = fake.requests.length > 0;
  if (pushed) {
    const req = fake.requests[fake.requests.length - 1];
    // 不回决策：用 deny 结算以免挂起（blocked=true 的语义由调用方另行断言）
    ctrl.resolvePermission(req.id, 'deny');
  }
  const result = await promise;
  return { blocked: !!result?.block, reason: result?.reason, pushed };
}

describe('PermissionController session-allow', () => {
  it('auto-safe 下目标上报和方案提案直接放行', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe');
    for (const toolName of ['goal_complete', 'goal_blocked', 'propose_plan']) {
      const result = await runGate(ctrl, fake, toolName, {});
      expect(result.pushed).toBe(false);
      expect(result.blocked).toBe(false);
    }
  });

  it('ask-all 仍对目标上报和方案提案请求工具审批', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('ask-all');
    for (const toolName of ['goal_complete', 'goal_blocked', 'propose_plan']) {
      expect((await runGate(ctrl, fake, toolName, {})).pushed).toBe(true);
    }
  });

  it('ask-all 下 allow-session 后同名工具自动放行', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('ask-all');

    // 第一次：弹审批，用户选择 allow-session
    const p = ctrl.gateForTest('mcp', { op: 'call' });
    await Promise.resolve();
    expect(fake.requests.length).toBe(1);
    const req = fake.requests[0];
    ctrl.resolvePermission(req.id, 'allow-session');
    const gate1 = await p;
    expect(gate1?.block).toBeFalsy(); // 本次放行

    // 第二次：同名工具不再弹审批，直接放行
    const r2 = await runGate(ctrl, fake, 'mcp', { op: 'list' });
    expect(r2.pushed).toBe(false);
    expect(r2.blocked).toBe(false);

    // 其他工具名不受影响，仍弹审批
    const r3 = await runGate(ctrl, fake, 'bash', { command: 'rm -rf /' });
    expect(r3.pushed).toBe(true);
    expect(r3.blocked).toBe(true);
  });

  it('auto-safe 下 allow-session 对非安全工具同样生效', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe'); // 默认

    const p = ctrl.gateForTest('mcp', { op: 'call' });
    await Promise.resolve();
    expect(fake.requests.length).toBe(1);
    ctrl.resolvePermission(fake.requests[0].id, 'allow-session');
    expect((await p)?.block).toBeFalsy();

    const r = await runGate(ctrl, fake, 'mcp', { op: 'call' });
    expect(r.pushed).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it('clearPending（会话切换）后恢复逐次审批', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('ask-all');

    const p = ctrl.gateForTest('mcp', { op: 'call' });
    await Promise.resolve();
    ctrl.resolvePermission(fake.requests[0].id, 'allow-session');
    await p;

    ctrl.clearPending(); // 模拟会话切换

    const r = await runGate(ctrl, fake, 'mcp', { op: 'call' });
    expect(r.pushed).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it('clearSessionAllowedTools 手动撤销', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('ask-all');

    const p = ctrl.gateForTest('mcp', { op: 'call' });
    await Promise.resolve();
    ctrl.resolvePermission(fake.requests[0].id, 'allow-session');
    await p;
    expect(ctrl.getSessionAllowedTools()).toEqual(['mcp']);

    ctrl.clearSessionAllowedTools();
    expect(ctrl.getSessionAllowedTools()).toEqual([]);

    const r = await runGate(ctrl, fake, 'mcp', { op: 'call' });
    expect(r.pushed).toBe(true);
  });

  it('allow-all 策略仍然完全放行（不受会话级状态影响）', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('allow-all');
    const r = await runGate(ctrl, fake, 'bash', { command: 'rm -rf /' });
    expect(r.pushed).toBe(false);
    expect(r.blocked).toBe(false);
  });
});

describe('PermissionController 会话级放行 × 危险命令 denylist', () => {
  it.each(['ask-all', 'auto-safe'])(
    '%s 下危险规则优先于会话授权和两种自定义白名单',
    async (policy) => {
      const fake = makeFakeBridge();
      const ctrl = new PermissionController(fake.bridge);
      ctrl.setPolicy(policy);

      // 先对一个普通调用登记会话授权，随后再配置宽泛的静态白名单。
      const first = ctrl.gateForTest('bash', { command: 'npm test' });
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      ctrl.resolvePermission(fake.requests[0].id, 'allow-session');
      await first;

      for (const config of [{ safeTools: ['bash'] }, { safeBashCommands: ['rm', 'dd'] }]) {
        ctrl.setAutoSafeConfig(config);
        for (const command of ['rm -rf build', 'dd if=input of=output', 'echo x > /dev/sda']) {
          const result = await runGate(ctrl, fake, 'bash', { command });
          expect(result.pushed).toBe(true);
          expect(result.blocked).toBe(true);
        }
      }
    }
  );

  /** 先登记 bash 为「本次会话允许」，再验证后续命令的放行行为 */
  async function allowBashForSession(
    ctrl: PermissionController,
    fake: ReturnType<typeof makeFakeBridge>
  ) {
    const p = ctrl.gateForTest('bash', { command: 'cat foo.txt | grep bar' });
    await Promise.resolve();
    await Promise.resolve();
    const req = fake.requests[fake.requests.length - 1];
    ctrl.resolvePermission(req.id, 'allow-session');
    await p;
  }

  it('allow-session 后普通 bash 命令自动放行（不弹审批）', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe');
    await allowBashForSession(ctrl, fake);

    const r = await runGate(ctrl, fake, 'bash', { command: 'cat foo.txt | grep bar' });
    expect(r.pushed).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it('allow-session 后 rm -rf 仍强制弹审批（危险命令不静默放行）', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe');
    await allowBashForSession(ctrl, fake);

    const r = await runGate(ctrl, fake, 'bash', { command: 'rm -rf /' });
    expect(r.pushed).toBe(true); // 仍然弹审批
    expect(r.blocked).toBe(true); // runGate 用 deny 结算
  });

  it('allow-session 后 sudo / dd / mkfs 均强制弹审批', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe');
    await allowBashForSession(ctrl, fake);

    for (const cmd of [
      'sudo apt install x',
      'dd if=/dev/zero of=/dev/sda',
      'mkfs.ext4 /dev/sdb1'
    ]) {
      const r = await runGate(ctrl, fake, 'bash', { command: cmd });
      expect(r.pushed).toBe(true);
    }
  });

  it('危险命令审批通过后本次执行（allow 决策），下一条危险命令仍弹审批', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('auto-safe');
    await allowBashForSession(ctrl, fake);

    // 第一条 rm：弹审批，用户点「允许」
    fake.requests.length = 0;
    const p1 = ctrl.gateForTest('bash', { command: 'rm -rf /tmp/x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.requests.length).toBe(1);
    const r1 = fake.requests[0];
    expect(r1.danger?.dangerous).toBe(true); // 审批请求携带危险标识
    expect(r1.danger?.category).toBe('destructive-remove');
    ctrl.resolvePermission(r1.id, 'allow');
    expect((await p1)?.block).toBeFalsy(); // 放行本次

    // 第二条 rm：仍然弹审批（不会因为上一条 allow 而静默放行）
    const p2 = ctrl.gateForTest('bash', { command: 'rm -rf /tmp/y' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.requests.length).toBe(2);
    ctrl.resolvePermission(fake.requests[1].id, 'deny');
    expect((await p2)?.block).toBe(true);
  });

  it('危险命令在普通审批路径也携带 danger 标识（ask-all 首次审批）', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('ask-all');

    const p = ctrl.gateForTest('bash', { command: 'dd if=/dev/zero of=/dev/sda' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.requests[0].danger?.category).toBe('disk-write');
    ctrl.resolvePermission(fake.requests[0].id, 'deny');
    await p;
  });

  it('allow-all 不做危险检测（yolo 模式保持原语义）', async () => {
    const fake = makeFakeBridge();
    const ctrl = new PermissionController(fake.bridge);
    ctrl.setPolicy('allow-all');
    const r = await runGate(ctrl, fake, 'bash', { command: 'rm -rf /' });
    expect(r.pushed).toBe(false);
    expect(r.blocked).toBe(false);
  });
});
