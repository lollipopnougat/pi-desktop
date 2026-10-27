import { describe, expect, it } from 'vitest';
import {
  buildFileMentionItems,
  mentionItemLabel,
  splitMentionPath,
  type MentionEntry
} from '../../src/lib/mention-paths';

const entry = (name: string, isDirectory = false, path = name): MentionEntry => ({
  name,
  path,
  isDirectory
});

describe('splitMentionPath', () => {
  it('没有斜杠时整段都是前缀', () => {
    expect(splitMentionPath('')).toEqual({ dir: '', partial: '' });
    expect(splitMentionPath('src')).toEqual({ dir: '', partial: 'src' });
  });

  it('末尾斜杠表示列出该目录', () => {
    expect(splitMentionPath('src/')).toEqual({ dir: 'src', partial: '' });
    expect(splitMentionPath('src/components/')).toEqual({ dir: 'src/components', partial: '' });
  });

  it('多级路径按最后一个斜杠拆分', () => {
    expect(splitMentionPath('src/comp')).toEqual({ dir: 'src', partial: 'comp' });
    expect(splitMentionPath('a/b/c')).toEqual({ dir: 'a/b', partial: 'c' });
    expect(splitMentionPath('/src')).toEqual({ dir: '', partial: 'src' });
  });
});

describe('buildFileMentionItems', () => {
  it('目录优先，其次按名称排序', () => {
    const items = buildFileMentionItems(
      [entry('b.ts'), entry('src', true), entry('a.ts'), entry('lib', true)],
      ''
    );
    expect(items.map((x) => x.label)).toEqual(['lib/', 'src/', 'a.ts', 'b.ts']);
    expect(items[0].isDirectory).toBe(true);
    expect(items[2].isDirectory).toBe(false);
  });

  it('按前缀过滤且大小写不敏感', () => {
    const items = buildFileMentionItems(
      [entry('README.md'), entry('src', true), entry('static', true)],
      'ST'
    );
    expect(items.map((x) => x.label)).toEqual(['static/']);
  });

  it('隐藏依赖/构建/版本库目录，但同名文件照常保留', () => {
    const items = buildFileMentionItems(
      [entry('node_modules', true), entry('.git', true), entry('dist', true), entry('dist', false)],
      ''
    );
    expect(items.map((x) => x.label)).toEqual(['dist']);
    expect(items[0].isDirectory).toBe(false);
  });

  it('value 用目录内的相对路径，目录标签带尾斜杠', () => {
    const items = buildFileMentionItems(
      [entry('comp', true, 'src/comp'), entry('index.ts', false, 'src/index.ts')],
      ''
    );
    expect(items[0]).toMatchObject({ label: 'comp/', value: 'src/comp', isDirectory: true });
    expect(items[1]).toMatchObject({ label: 'index.ts', value: 'src/index.ts' });
  });

  it('截断到 limit 条', () => {
    const many = Array.from({ length: 50 }, (_, i) => entry(`f${i}.ts`));
    expect(buildFileMentionItems(many, '', 30)).toHaveLength(30);
  });

  it('mentionItemLabel 对目录加尾斜杠', () => {
    expect(mentionItemLabel(entry('src', true))).toBe('src/');
    expect(mentionItemLabel(entry('a.ts'))).toBe('a.ts');
  });
});
