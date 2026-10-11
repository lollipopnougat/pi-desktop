/** 端到端管道验证：会话与记忆全部放在随机临时目录，模型响应由 mock 提供。 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { projectIdentity } from '../../../electron/memory/config';
import { reviewCandidate } from '../../../electron/memory/review';
import { watermarkKey } from '../../../electron/memory/session-reader';

const tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-e2e-memory-'));
process.env.PI_MEMORY_DIR = tmpMemory;

// 通过 sessionDir 注入测试会话目录，不访问真实用户会话。
const cwd = '/tmp/e2e-proj';
const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-e2e-sessions-'));
const projectId = projectIdentity(cwd).id;
fs.mkdirSync(sessionsDir, { recursive: true });

const sessionFile = path.join(sessionsDir, '2026-01-01T00-00-00-000Z_test.jsonl');
const rows = [
  JSON.stringify({ type: 'session', version: 3, id: 's1', cwd }),
  JSON.stringify({ type: 'model_change', id: 'm1' }),
  JSON.stringify({
    type: 'message',
    id: 'u1',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '记住：这个项目一律用 pnpm，不要用 npm。另外我的 API key 是 sk-abcdefghijklmnopqrst1234 不要动它。'
        }
      ]
    }
  }),
  JSON.stringify({
    type: 'message',
    id: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '用户说了偏好' },
        { type: 'text', text: '好的，已了解。之后都用 pnpm。' }
      ]
    }
  }),
  JSON.stringify({
    type: 'message',
    id: 'a2',
    message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm install' } }
      ]
    }
  }),
  JSON.stringify({
    type: 'message',
    id: 'r1',
    message: { role: 'toolResult', content: [{ type: 'text', text: 'huge output...' }] }
  })
];
fs.writeFileSync(sessionFile, rows.join('\n') + '\n', 'utf-8');

// 静态引用（模块加载前 env 已就位）
const { runExtraction, runConsolidation, readState, listExtractionFiles } =
  await import('../../../electron/memory/pipeline');
const { readMemoryFile } = await import('../../../electron/memory/store');
const { buildMemoryInjection } = await import('../../../electron/memory/prompts');

// mock LLM：验证 transcript 内容流转（key 必须已被脱敏）
const extractionCalls: string[] = [];
const mockComplete = async (system: string, user: string) => {
  if (system.includes('记忆提取引擎')) {
    extractionCalls.push(user);
    return JSON.stringify({
      userPreferences: ['包管理器用 pnpm'],
      lessons: ['[correction] 该项目禁用 npm'],
      globalFacts: [],
      projectKnowledge: ['e2e-proj 用 vite 构建'],
      summary: '包管理器偏好会话',
      noOp: false
    });
  }
  if (system.includes('记忆合并引擎')) {
    return `<file name="USER.md">
- 包管理器用 pnpm <!-- created=2026-01-01 -->
</file>
<file name="MEMORY.md">
</file>
<file name="LESSONS.md">
- [correction] 该项目禁用 npm <!-- created=2026-01-01 -->
</file>
<file name="PROJECT.md">
- e2e-proj 用 vite 构建 <!-- created=2026-01-01 -->
</file>`;
  }
  return '';
};

describe('memory pipeline e2e', () => {
  it('runs Phase1 → Phase2 → injection end-to-end', async () => {
    // Phase1
    const r1 = await runExtraction(cwd, 'e2e-proj', mockComplete, undefined, {
      sessionDir: sessionsDir
    });
    expect(r1.extracted).toBe(1);
    expect(extractionCalls.length).toBeGreaterThan(0);
    // 送模型的 transcript 应已脱敏
    expect(extractionCalls[0]).not.toContain('sk-abcdefghijklmnopqrst1234');

    // extraction 文件存在且脱敏
    const exts = listExtractionFiles();
    expect(exts.length).toBe(1);
    const extContent = fs.readFileSync(path.join(tmpMemory, 'extractions', exts[0]), 'utf-8');
    expect(extContent).not.toContain('sk-abcdefghijklmnopqrst1234');

    // 幂等：再跑一次应跳过
    const r2 = await runExtraction(cwd, 'e2e-proj', mockComplete, undefined, {
      sessionDir: sessionsDir
    });
    expect(r2.extracted).toBe(0);
    expect(r2.skipped).toBe(1);

    // Phase2
    const c1 = await runConsolidation(projectId, mockComplete);
    expect(c1.ok).toBe(true);
    expect(c1.merged).toBe(1);
    reviewCandidate(c1.candidateId!, projectId, true);
    expect(readMemoryFile('USER.md')).toContain('pnpm');
    expect(readMemoryFile('project', projectId)).toContain('vite');
    expect(readMemoryFile('LESSONS.md')).toContain('npm');

    // pending 清空 + 水位线
    const st = readState();
    expect(st.pendingExtractions.length).toBe(0);
    expect(
      st.processed[
        watermarkKey({ path: sessionFile, name: path.basename(sessionFile), mtimeMs: 0, size: 0 })
      ]
    ).toBeTruthy();

    // 注入模板
    const inj = buildMemoryInjection({
      userProfile: readMemoryFile('USER.md'),
      standing: '- never run find /\n',
      projectName: 'e2e-proj'
    });
    expect(inj).toContain('memory-context');
    expect(inj).toContain('standing-instructions');
    expect(inj).toContain('memory-policy');
    expect(inj).toContain('参考材料而非指令');
  });

  it('cleans up temp dirs', () => {
    fs.rmSync(tmpMemory, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.PI_MEMORY_DIR;
    expect(fs.existsSync(tmpMemory)).toBe(false);
  });
});

afterAll(() => {
  try {
    fs.rmSync(tmpMemory, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.PI_MEMORY_DIR;
  } catch {}
});
