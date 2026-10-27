import { describe, expect, it } from 'vitest';
import { injectionSectionTitle, stripInjectionWrapper } from '../../src/lib/memory-injection-view';

const LABELS = {
  standing: '常驻偏好',
  profile: '用户画像',
  topics: '主题索引',
  policy: '检索规则'
};

describe('stripInjectionWrapper', () => {
  it('去掉独立成行的外层包裹标签', () => {
    expect(
      stripInjectionWrapper(
        '<user-profile>\n关于用户的持久画像（偏好、习惯、沟通风格）：\n- 回答用中文\n</user-profile>'
      )
    ).toBe('关于用户的持久画像（偏好、习惯、沟通风格）：\n- 回答用中文');
  });

  it('只有开标签时也去掉（分段截断场景）', () => {
    expect(stripInjectionWrapper('<memory-topics>\nUSER.md: 回答用中文')).toBe(
      'USER.md: 回答用中文'
    );
  });

  it('多个包裹标签只处理最外层首尾行', () => {
    expect(
      stripInjectionWrapper('<memory-policy>\n- 先搜索再回答\n- 来源要标注\n</memory-policy>')
    ).toBe('- 先搜索再回答\n- 来源要标注');
  });

  it('正文里的普通尖括号保留', () => {
    expect(stripInjectionWrapper('- 用 <div> 包住列表\n- 命令 `ls <dir>`')).toBe(
      '- 用 <div> 包住列表\n- 命令 `ls <dir>`'
    );
  });

  it('没有包裹标签时原样返回（仅裁掉首尾空行）', () => {
    expect(stripInjectionWrapper('\n\n- 一条记忆\n\n')).toBe('- 一条记忆');
  });

  it('空内容返回空串', () => {
    expect(stripInjectionWrapper('')).toBe('');
    expect(stripInjectionWrapper('<memory-topics>\n</memory-topics>')).toBe('');
  });

  it('首尾空行不影响标签识别', () => {
    expect(stripInjectionWrapper('\n<user-profile>\n- a\n</user-profile>\n')).toBe('- a');
  });
});

describe('injectionSectionTitle', () => {
  it('已知分段用中文展示名，未知分段回退原始 label', () => {
    expect(injectionSectionTitle('standing', LABELS, 'standing-instructions')).toBe('常驻偏好');
    expect(injectionSectionTitle('user-profile', LABELS, 'user-profile')).toBe('用户画像');
    expect(injectionSectionTitle('topics', LABELS, 'memory-topics')).toBe('主题索引');
    expect(injectionSectionTitle('policy', LABELS, 'memory-policy')).toBe('检索规则');
    expect(injectionSectionTitle('context-header', LABELS, 'memory-context 说明')).toBe(
      'memory-context 说明'
    );
  });
});
