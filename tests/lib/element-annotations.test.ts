import { describe, expect, it } from 'vitest';
import {
  annotationImages,
  buildAnnotationPrompt,
  createAnnotation,
  elementLabel,
  elementSummary,
  withAnnotationPrompt,
  type ElementAnnotation
} from '../../src/lib/element-annotations';
import type { BrowserPickedElement } from '../../src/types/pi';

function element(overrides: Partial<BrowserPickedElement> = {}): BrowserPickedElement {
  return {
    tagName: 'div',
    selector: 'main > div.hero-banner',
    text: '  PIXEL   DEFENSE ',
    html: '<div class="hero-banner"><img src="a.png"></div>',
    rect: { x: 12.4, y: 30.6, width: 197.2, height: 42.4 },
    clip: { x: 12, y: 31, width: 197, height: 42 },
    styles: {
      color: 'rgb(244, 237, 207)',
      background: 'rgba(0, 0, 0, 0)',
      font: '"PingFang SC", sans-serif',
      fontSize: '16px'
    },
    url: 'https://example.com/landing',
    title: '示例页面',
    viewport: { width: 1280, height: 800 },
    ...overrides
  };
}

function annotation(overrides: Partial<ElementAnnotation> = {}): ElementAnnotation {
  return {
    id: 'el-1',
    createdAt: 1,
    element: element(),
    comment: '这个像素图是怎么来的',
    ...overrides
  };
}

describe('createAnnotation', () => {
  it('returns null when the user cancelled the pick', () => {
    expect(createAnnotation({ element: null })).toBeNull();
  });

  it('starts with an empty comment and keeps the element snapshot', () => {
    const created = createAnnotation({ element: element() });
    expect(created).not.toBeNull();
    expect(created!.comment).toBe('');
    expect(created!.element.selector).toBe('main > div.hero-banner');
    expect(created!.image).toBeUndefined();
    expect(created!.id).toMatch(/^el-/);
  });

  it('attaches the screenshot only when it carries data', () => {
    const withImage = createAnnotation({
      element: element(),
      image: { data: 'png', mimeType: 'image/png' }
    });
    expect(withImage!.image).toEqual({ data: 'png', mimeType: 'image/png' });
    // 空图绝不能进附件：base64 为空会让整轮请求 400（见 docs/report2.md）
    const emptyImage = createAnnotation({
      element: element(),
      image: { data: '', mimeType: 'image/png' }
    });
    expect(emptyImage!.image).toBeUndefined();
  });
});

describe('elementLabel / elementSummary', () => {
  it('labels with the last selector segment', () => {
    expect(elementLabel(element())).toBe('div.hero-banner');
    expect(elementLabel(element({ selector: '', tagName: 'a' }))).toBe('a');
  });

  it('summarizes size and collapsed text', () => {
    expect(elementSummary(element())).toBe('197×42 · PIXEL DEFENSE');
    expect(elementSummary(element({ text: '   ' }))).toBe('197×42');
  });
});

describe('buildAnnotationPrompt', () => {
  it('returns an empty string when there is nothing to send', () => {
    expect(buildAnnotationPrompt([])).toBe('');
    expect(withAnnotationPrompt('你好', [])).toBe('你好');
  });

  it('renders one block per annotation with all the element facts', () => {
    const block = buildAnnotationPrompt([annotation()]);
    expect(block).toContain('### 页面元素批注');
    expect(block).toContain('标注了 1 个页面元素');
    expect(block).toContain('这些批注没有附带截图');
    expect(block).toContain('**批注 1**');
    expect(block).toContain('- 页面：示例页面 — https://example.com/landing');
    expect(block).toContain('- 元素：<div> 选择器 main > div.hero-banner');
    expect(block).toContain('- 尺寸：197×42（位置 12,31）');
    expect(block).toContain('- 文本："PIXEL DEFENSE"');
    expect(block).toContain('color rgb(244, 237, 207)');
    expect(block).toContain('font 16px "PingFang SC", sans-serif');
    // 透明背景不值得占用 token
    expect(block).not.toContain('background');
    expect(block).toContain('- HTML：<div class="hero-banner">');
    expect(block).toContain('- 用户批注：这个像素图是怎么来的');
  });

  it('numbers multiple annotations and points at the leading screenshots', () => {
    const block = buildAnnotationPrompt([
      annotation(),
      annotation({
        id: 'el-2',
        comment: '',
        element: element({ selector: 'a.cta', tagName: 'a' }),
        image: { data: 'png', mimeType: 'image/png' }
      })
    ]);
    expect(block).toContain('标注了 2 个页面元素');
    expect(block).toContain('最前面的 1 张图片');
    expect(block).toContain('**批注 2**（附截图 2）');
    expect(block).toContain('- 用户批注：(只标注了元素，没有额外说明)');
  });

  it('truncates long HTML', () => {
    const block = buildAnnotationPrompt([
      annotation({ element: element({ html: '<div>' + 'x'.repeat(2000) + '</div>' }) })
    ]);
    const line = block.split('\n').find((item) => item.startsWith('- HTML：')) ?? '';
    expect(line.length).toBeLessThan(640);
  });

  it('joins with the user text when present', () => {
    const merged = withAnnotationPrompt('请改一下这个横幅', [annotation()]);
    expect(merged.startsWith('请改一下这个横幅\n\n### 页面元素批注')).toBe(true);
  });
});

describe('annotationImages', () => {
  it('keeps only annotations with image data, in order', () => {
    const images = annotationImages([
      annotation({ id: 'a', image: { data: 'one', mimeType: 'image/png' } }),
      annotation({ id: 'b' }),
      annotation({ id: 'c', image: { data: 'two', mimeType: 'image/jpeg' } })
    ]);
    expect(images).toEqual([
      { type: 'image', data: 'one', mimeType: 'image/png' },
      { type: 'image', data: 'two', mimeType: 'image/jpeg' }
    ]);
  });

  it('returns an empty list when nothing has a screenshot', () => {
    expect(annotationImages([annotation()])).toEqual([]);
  });
});
