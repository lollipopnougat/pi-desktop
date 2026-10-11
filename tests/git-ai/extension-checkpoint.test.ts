/**
 * git-ai 内联扩展的事件门控单测：总开关 / 上报范围 / payload 形状。
 *
 * 用 vi.mock 替换 child_process 的 spawn，捕获 stdin 里写入的 checkpoint payload，
 * 从而在不真的调用 git-ai 的前提下验证「哪些事件会/不会上报」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: spawnMock }));

import { gitAiExtensionFactory } from '../../electron/git-ai/extension';
import { writeGitAiConfig } from '../../electron/git-ai/config';

type Handler = (event: any, ctx: any) => Promise<void>;

let dir: string;
let workDir: string;
let payloads: string[];

/** 假子进程：记录 stdin 写入的 payload，并在下一个微任务里触发 close（让 await 结算） */
function makeChild() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child = {
    stdin: {
      end: (data?: string) => {
        if (typeof data === 'string') payloads.push(data);
      }
    },
    kill: () => {},
    on: (name: string, cb: (...args: unknown[]) => void) => {
      (handlers[name] ??= []).push(cb);
      return child;
    }
  };
  queueMicrotask(() => {
    for (const cb of handlers.close ?? []) cb(0);
  });
  return child;
}

/** 挂载扩展工厂，返回按事件名索引的 handler */
function setup(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const api = {
    on: (name: string, cb: Handler) => {
      handlers[name] = cb;
    }
  };
  gitAiExtensionFactory().factory(api as unknown as ExtensionAPI);
  return handlers;
}

function ctx(sessionId = 'sess-1') {
  return {
    cwd: workDir,
    sessionManager: { getSessionId: () => sessionId },
    model: { id: 'test-model' }
  };
}

const checkpointPayloads = () => payloads.map((raw) => JSON.parse(raw));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ai-events-'));
  workDir = path.join(dir, 'proj');
  fs.mkdirSync(workDir, { recursive: true });
  process.env.PI_GIT_AI_CONFIG = path.join(dir, 'git-ai.json');
  process.env.PI_DESKTOP_GIT_AI_BIN = '/fake/git-ai';
  payloads = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeChild());
});

afterEach(() => {
  delete process.env.PI_GIT_AI_CONFIG;
  delete process.env.PI_DESKTOP_GIT_AI_BIN;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('git-ai 扩展事件门控', () => {
  it('spawn 参数与二进制：checkpoint agent-v1 --hook-input stdin + windowsHide', async () => {
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'ls' }, toolCallId: 'b1' },
      ctx()
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('/fake/git-ai');
    expect(spawnMock.mock.calls[0][1]).toEqual(['checkpoint', 'agent-v1', '--hook-input', 'stdin']);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  });

  it('设置页路径优先于环境变量', async () => {
    writeGitAiConfig({ binPath: '/custom/git-ai' });
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'ls' }, toolCallId: 'b1' },
      ctx()
    );

    expect(spawnMock.mock.calls[0][0]).toBe('/custom/git-ai');
  });

  it('关闭开关后不再上报任何 checkpoint', async () => {
    writeGitAiConfig({ enabled: false });
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'edit', input: { path: 'a.ts' }, toolCallId: 'e1' },
      ctx()
    );
    await handlers.tool_result({ toolCallId: 'e1', content: 'ok', isError: false }, ctx());

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('scope=files：只上报 edit/write，跳过 bash', async () => {
    writeGitAiConfig({ scope: 'files' });
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'ls' }, toolCallId: 'b1' },
      ctx()
    );
    expect(spawnMock).not.toHaveBeenCalled();

    await handlers.tool_call(
      { toolName: 'edit', input: { path: 'a.ts' }, toolCallId: 'e1' },
      ctx()
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(checkpointPayloads()[0].type).toBe('human');
  });

  it('scope=shell：只上报 bash，跳过 edit/write', async () => {
    writeGitAiConfig({ scope: 'shell' });
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'edit', input: { path: 'a.ts' }, toolCallId: 'e1' },
      ctx()
    );
    expect(spawnMock).not.toHaveBeenCalled();

    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'ls' }, toolCallId: 'b1' },
      ctx()
    );
    expect(checkpointPayloads()[0]).toMatchObject({
      type: 'pre_shell_command',
      command: 'ls',
      conversation_id: 'sess-1',
      repo_working_dir: workDir
    });
  });

  it('edit：tool_call 上报 human（含改动前内容），tool_result 上报 ai_agent', async () => {
    const handlers = setup();
    const file = path.join(workDir, 'a.ts');
    fs.writeFileSync(file, 'before');

    await handlers.tool_call(
      { toolName: 'edit', input: { path: 'a.ts' }, toolCallId: 'e1' },
      ctx()
    );
    fs.writeFileSync(file, 'after');
    await handlers.tool_result({ toolCallId: 'e1', content: 'ok', isError: false }, ctx());

    const [human, agent] = checkpointPayloads();
    expect(human).toMatchObject({
      type: 'human',
      will_edit_filepaths: [file],
      conversation_id: 'sess-1'
    });
    expect(human.dirty_files).toEqual({ [file]: 'before' });
    expect(agent).toMatchObject({ type: 'ai_agent', edited_filepaths: [file] });
    // 当前实现按 tool_result 时刻的文件内容上报（与上游扩展一致）
    expect(agent.dirty_files).toEqual({ [file]: 'after' });
  });

  it('tool_call 与 tool_result 之间关闭开关：不再结算 ai_agent', async () => {
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'edit', input: { path: 'a.ts' }, toolCallId: 'e1' },
      ctx()
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);

    writeGitAiConfig({ enabled: false });
    await handlers.tool_result({ toolCallId: 'e1', content: 'ok', isError: false }, ctx());
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('失败的工具调用不上报 post_shell_command', async () => {
    const handlers = setup();
    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'boom' }, toolCallId: 'b1' },
      ctx()
    );
    await handlers.tool_result({ toolCallId: 'b1', content: 'err', isError: true }, ctx());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(checkpointPayloads()[0].type).toBe('pre_shell_command');
  });

  it('拿不到 sessionId 时跳过上报（无会话上下文）', async () => {
    const handlers = setup();
    const brokenCtx = {
      cwd: workDir,
      sessionManager: {
        getSessionId: () => {
          throw new Error('no session');
        }
      }
    };
    await handlers.tool_call(
      { toolName: 'bash', input: { command: 'ls' }, toolCallId: 'b1' },
      brokenCtx
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
