import { describe, it, expect } from 'vitest';
import { splitMarkdownBlocks } from '../../src/utils/markdown-blocks';

describe('splitMarkdownBlocks', () => {
  it('空内容返回空数组', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n')).toEqual([]);
  });

  it('单段内容不切分', () => {
    expect(splitMarkdownBlocks('hello world')).toEqual(['hello world']);
    expect(splitMarkdownBlocks('para one\nstill same para')).toEqual(['para one\nstill same para']);
  });

  it('空白行 + 顶格普通段落切分', () => {
    expect(splitMarkdownBlocks('para one\n\npara two')).toEqual(['para one', 'para two']);
  });

  it('标题 / 围栏代码块是合法切点，表格行不是（保守：可能续接上块）', () => {
    expect(splitMarkdownBlocks('intro\n\n# Title\n\nbody')).toEqual(['intro', '# Title', 'body']);
    expect(splitMarkdownBlocks('intro\n\n```ts\nconst a = 1;\n```')).toEqual([
      'intro',
      '```ts\nconst a = 1;\n```'
    ]);
    expect(splitMarkdownBlocks('intro\n\n| a | b |\n| - | - |\n| 1 | 2 |')).toEqual([
      'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    ]);
  });

  it('围栏代码块内部的空白行不切分', () => {
    const content = '```md\nline a\n\nline b\n```\n\nafter';
    expect(splitMarkdownBlocks(content)).toEqual(['```md\nline a\n\nline b\n```', 'after']);
  });

  it('未闭合的围栏（流式中途）保持为同一块', () => {
    const content = '说明\n\n```ts\nconst a = 1;\n\nconst b = 2;';
    expect(splitMarkdownBlocks(content)).toEqual(['说明', '```ts\nconst a = 1;\n\nconst b = 2;']);
  });

  it('松列表 / 引用块续段不被截断（列表标记与 > 不是切点）', () => {
    const list = '- item 1\n\n- item 2\n\n- item 3';
    expect(splitMarkdownBlocks(list)).toEqual([list]);

    const ordered = '1. one\n\n2. two';
    expect(splitMarkdownBlocks(ordered)).toEqual([ordered]);

    const quote = '> line a\n\n> line b';
    expect(splitMarkdownBlocks(quote)).toEqual([quote]);
  });

  it('缩进续行（四空格代码块等）不是切点，跟随上一个块', () => {
    const content = 'para\n\n    indented code\n\nnext para';
    expect(splitMarkdownBlocks(content)).toEqual(['para\n\n    indented code', 'next para']);
  });

  it('分隔线不是切点（避免与 setext 语义混淆）', () => {
    const content = 'para\n\n---\n\nnext';
    expect(splitMarkdownBlocks(content)).toEqual(['para\n\n---', 'next']);
  });

  it('拼接后内容不丢失（除空白行归一）', () => {
    const content = 'a\n\nb\n\nc\n\n\n# d';
    const blocks = splitMarkdownBlocks(content);
    expect(blocks.join('\n\n')).toBe('a\n\nb\n\nc\n\n# d');
  });
});
