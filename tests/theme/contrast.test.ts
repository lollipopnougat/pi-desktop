/**
 * 主题可读性回归：颜色变量是手写的 "R G B" 字符串，很容易在调色时把
 * 「选中文字」和「选中底色」调成同一个颜色（历史 bug：6 个浅色主题里
 * 选中文字几乎不可见），或者把次要文字调得比背景还淡。
 * 这里对每个主题族 × 明暗变体做 WCAG 对比度断言，改色板时先跑这个测试。
 */
import { describe, expect, it } from 'vitest';
import { THEME_FAMILIES } from '../../src/theme/themes';

/** 线性化后的相对亮度分量 */
function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: string): number {
  const [r, g, b] = rgb.split(' ').map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Solarized 本身就是低对比主题（官方配色即如此），次要文字只保证不糊成背景 */
const LOW_CONTRAST_DIM = new Set(['solarized']);

describe('主题对比度', () => {
  for (const family of THEME_FAMILIES) {
    for (const mode of ['dark', 'light'] as const) {
      const vars = family[mode].vars;
      const name = `${family.id}/${mode}`;

      it(`${name} 正文与背景对比度 >= 4.5`, () => {
        expect(contrast(vars.text, vars.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars['text-bright'], vars.bg)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${name} 选中文字与选中底色对比度 >= 4.5`, () => {
        expect(contrast(vars['sel-text'], vars['sel-bg'])).toBeGreaterThanOrEqual(4.5);
      });

      it(`${name} 次要文字与面板底色对比度 >= 4.0`, () => {
        const floor = LOW_CONTRAST_DIM.has(family.id) ? 2.5 : 4.0;
        expect(contrast(vars['text-dim'], vars['bg-alt'])).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});
