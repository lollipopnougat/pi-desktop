/**
 * pi-desktop 系统提示词追加段测试
 *
 * 验证两件事：
 * 1. 随安装包发布的说明文档存在且包含关键约定（打包 extraResources + asarUnpack 失效时能及时发现）；
 * 2. 用 appendSystemPromptOverride 追加自定义段落时，SDK 仍会加载用户自己的
 *    APPEND_SYSTEM.md（这是选择 override 而不是 appendSystemPrompt 的原因：
 *    显式传 appendSystemPrompt 会让 SDK 跳过对用户追加段的发现，等于顶掉用户文件）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'resources', 'docs');
const PROMPT_FILE = path.join(DOCS_DIR, 'pi-desktop-system-prompt.md');
const GUIDE_FILE = path.join(DOCS_DIR, 'pi-desktop.md');

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-prompt-'));
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe('pi-desktop 说明文档资源', () => {
  it('系统提示词追加段存在，且覆盖 GUI 宿主的关键约定', () => {
    expect(fs.existsSync(PROMPT_FILE)).toBe(true);
    const body = fs.readFileSync(PROMPT_FILE, 'utf8');
    // 关键事实：GUI 宿主、目录隔离、GUI 专有工具、权限审批、与 CLI 的差异
    expect(body).toContain('pi-desktop');
    expect(body).toContain('~/.pi-desktop/');
    expect(body).toContain('update_plan');
    expect(body).toContain('bg_run');
    expect(body).toContain('pi-browser');
    expect(body).toContain('auto-safe');
    // 追加段必须精简（每轮请求都要付 token）
    expect(body.length).toBeLessThan(4000);
  });

  it('完整说明文档存在且非空', () => {
    expect(fs.existsSync(GUIDE_FILE)).toBe(true);
    expect(fs.readFileSync(GUIDE_FILE, 'utf8').trim().length).toBeGreaterThan(500);
  });
});

describe('appendSystemPromptOverride 注入', () => {
  it('追加自定义段落，同时保留用户 APPEND_SYSTEM.md', async () => {
    fs.writeFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'USER_APPEND_MARKER');

    const addendum = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPromptOverride: (base) => [...base, addendum]
    });
    await loader.reload();

    const combined = loader.getAppendSystemPrompt().join('\n\n');
    // 用户的追加段没被顶掉
    expect(combined).toContain('USER_APPEND_MARKER');
    // 我们的说明段也在
    expect(combined).toContain('pi-desktop');
    expect(combined).toContain('~/.pi-desktop/');
  });
});
