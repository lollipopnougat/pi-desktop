import { describe, expect, it } from 'vitest';
import { buildCancelScript, buildPickerScript } from '../../electron/browser/picker';

describe('browser element picker scripts', () => {
  it('builds a self-contained script that is valid JavaScript', () => {
    const script = buildPickerScript();
    // 关键约束：脚本会被 toString() 后单独执行，语法必须自洽（不能引用模块作用域变量）
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('__piPicker');
    expect(script).toContain('data-pi-picker');
    // 拦截点击必须用捕获阶段，否则页面自己的 click 先跑（会导航/提交）
    expect(script).toMatch(/['"]click['"], onClick, true/);
  });

  it('cancel script is valid and looks up the same global', () => {
    const script = buildCancelScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('__piPicker');
    expect(script).toContain('cancel');
  });
});
