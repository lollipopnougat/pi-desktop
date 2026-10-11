import { describe, it, expect } from 'vitest';
import {
  buildMemoryInjection,
  buildMemoryInjectionSections,
  renderMemoryInjection
} from '../../electron/memory/prompts';

describe('记忆注入分段（buildMemoryInjectionSections / renderMemoryInjection）', () => {
  const filled = { userProfile: '- 回答用中文\n', standing: '- 只用 pnpm\n', projectName: 'proj' };

  it('分段拼接结果与注入串一致，且 chars 与内容长度一致', () => {
    const sections = buildMemoryInjectionSections(filled);
    expect(renderMemoryInjection(sections)).toBe(buildMemoryInjection(filled));
    for (const s of sections) {
      expect(s.chars).toBe(s.content.length);
      expect(s.included).toBe(s.content.length > 0);
    }
    expect(sections.map((s) => s.id)).toEqual([
      'context-header',
      'standing',
      'user-profile',
      'topics',
      'context-footer',
      'policy'
    ]);
  });

  it('来源标注正确：记忆文件 vs 固定文案', () => {
    const sections = buildMemoryInjectionSections(filled);
    const byId = new Map(sections.map((s) => [s.id, s]));
    expect(byId.get('standing')!.source).toBe('STANDING.md');
    expect(byId.get('standing')!.fixed).toBe(false);
    expect(byId.get('user-profile')!.source).toBe('USER.md');
    expect(byId.get('user-profile')!.fixed).toBe(false);
    expect(byId.get('policy')!.fixed).toBe(true);
    expect(byId.get('context-header')!.fixed).toBe(true);
  });

  it('单个文件为空时该段不注入，其余照常', () => {
    const sections = buildMemoryInjectionSections({
      userProfile: '',
      standing: '- rule\n',
      projectName: 'proj'
    });
    const byId = new Map(sections.map((s) => [s.id, s]));
    expect(byId.get('standing')!.included).toBe(true);
    expect(byId.get('user-profile')!.included).toBe(false);
    expect(byId.get('user-profile')!.chars).toBe(0);
    expect(byId.get('user-profile')!.content).toBe('');
    // 整块注入仍在，且不含 user-profile 标签
    const injection = renderMemoryInjection(sections);
    expect(injection).toContain('<standing-instructions>');
    expect(injection).not.toContain('<user-profile>');
  });

  it('画像为空时仍提供检索规则', () => {
    const sections = buildMemoryInjectionSections({
      userProfile: '   \n',
      standing: '\n',
      projectName: 'proj'
    });
    expect(sections.find((s) => s.id === 'user-profile')?.included).toBe(false);
    expect(renderMemoryInjection(sections)).toContain('<memory-policy>');
    expect(buildMemoryInjection({ userProfile: '', standing: '', projectName: 'proj' })).toContain(
      'memory_read'
    );
  });

  it('截断时透出 truncated / originalChars 与截断提示', () => {
    const opts = {
      userProfile: 'x'.repeat(10),
      standing: '',
      projectName: 'proj',
      truncatedProfile: true,
      originalProfileChars: 9999
    };
    const profile = buildMemoryInjectionSections(opts).find((s) => s.id === 'user-profile')!;
    expect(profile.truncated).toBe(true);
    expect(profile.originalChars).toBe(9999);
    expect(profile.content).toContain('（注意：用户画像过长已被截断）');
    expect(
      buildMemoryInjectionSections({ ...opts, truncatedProfile: false })[2].truncated
    ).toBeUndefined();
  });
});
