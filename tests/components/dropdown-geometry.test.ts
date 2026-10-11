import { describe, it, expect } from 'vitest';
import {
  computePanelGeometry,
  samePanelGeometry,
  truncateGroups,
  MIN_PANEL_HEIGHT,
  PANEL_GAP,
  type TriggerRect,
  type ViewportSize
} from '../../src/components/common/dropdown-geometry';

const viewport: ViewportSize = { width: 1000, height: 800 };

/** 生成触发按钮矩形：默认靠近顶部、空间充足 */
function rect(partial: Partial<TriggerRect> = {}): TriggerRect {
  return { top: 100, bottom: 128, left: 20, right: 120, width: 100, ...partial };
}

describe('computePanelGeometry', () => {
  it('打开向下展开：贴齐触发按钮下沿，右侧对齐，宽度不小于触发按钮', () => {
    const g = computePanelGeometry(rect(), viewport, {
      align: 'right',
      placement: 'bottom',
      matchTriggerWidth: false
    });
    expect(g.top).toBe(128 + PANEL_GAP);
    expect(g.bottom).toBeUndefined();
    expect(g.right).toBe(880);
    expect(g.left).toBeUndefined();
    expect(g.width).toBeUndefined();
    expect(g.minWidth).toBe(100);
    // 800 - 128 - 8 - 4
    expect(g.maxHeight).toBe(660);
  });

  it('下方空间不足且上方更宽裕时向上翻转', () => {
    const g = computePanelGeometry(rect({ top: 700, bottom: 728 }), viewport, {
      align: 'right',
      placement: 'bottom',
      matchTriggerWidth: false
    });
    expect(g.top).toBeUndefined();
    expect(g.bottom).toBe(800 - 700 + PANEL_GAP);
    // 700 - 8 - 4
    expect(g.maxHeight).toBe(688);
  });

  it('placement=top 且上方宽裕时向上展开', () => {
    const g = computePanelGeometry(rect({ top: 600, bottom: 628 }), viewport, {
      align: 'right',
      placement: 'top',
      matchTriggerWidth: false
    });
    expect(g.bottom).toBe(800 - 600 + PANEL_GAP);
    expect(g.top).toBeUndefined();
    expect(g.maxHeight).toBe(588);
  });

  it('placement=top 但上方太挤时翻回向下', () => {
    const g = computePanelGeometry(rect(), viewport, {
      align: 'right',
      placement: 'top',
      matchTriggerWidth: false
    });
    expect(g.top).toBe(128 + PANEL_GAP);
    expect(g.bottom).toBeUndefined();
    expect(g.maxHeight).toBe(660);
  });

  it('两侧都放不下时高度保底为 MIN_PANEL_HEIGHT，靠列表滚动查看', () => {
    const g = computePanelGeometry(
      { top: 10, bottom: 30, left: 0, right: 100, width: 100 },
      { width: 400, height: 40 },
      { align: 'right', placement: 'bottom', matchTriggerWidth: false }
    );
    expect(g.maxHeight).toBe(MIN_PANEL_HEIGHT);
  });

  it('align=left 用触发按钮左沿，matchTriggerWidth 时面板与触发按钮等宽', () => {
    const g = computePanelGeometry(
      rect({ top: 300, bottom: 328, left: 40, right: 140 }),
      viewport,
      {
        align: 'left',
        placement: 'bottom',
        matchTriggerWidth: true
      }
    );
    expect(g.left).toBe(40);
    expect(g.right).toBeUndefined();
    expect(g.width).toBe(100);
  });
});

describe('samePanelGeometry', () => {
  const base = computePanelGeometry(rect(), viewport, {
    align: 'right',
    placement: 'bottom',
    matchTriggerWidth: false
  });

  it('字段完全一致时返回 true', () => {
    expect(samePanelGeometry(base, { ...base })).toBe(true);
  });

  it('任一字段变化时返回 false', () => {
    expect(samePanelGeometry(base, { ...base, top: 999 })).toBe(false);
    expect(samePanelGeometry(base, { ...base, maxHeight: base.maxHeight + 1 })).toBe(false);
    expect(samePanelGeometry(base, { ...base, width: 12 })).toBe(false);
  });
});

describe('truncateGroups', () => {
  const groups = [
    { label: 'OpenAI', options: ['a', 'b', 'c'] },
    { label: 'Anthropic', options: ['d', 'e'] },
    { label: 'OpenRouter', options: ['f', 'g', 'h', 'i'] }
  ];

  it('未传上限 / 上限不小于总数时原样返回', () => {
    expect(truncateGroups(groups)).toEqual({ groups, hidden: 0 });
    expect(truncateGroups(groups, 0)).toEqual({ groups, hidden: 0 });
    expect(truncateGroups(groups, 9)).toEqual({ groups, hidden: 0 });
  });

  it('按组顺序保留前 N 个选项，组标题跟着保留', () => {
    const { groups: out, hidden } = truncateGroups(groups, 4);
    expect(out.map((g) => g.label)).toEqual(['OpenAI', 'Anthropic']);
    expect(out[0].options).toEqual(['a', 'b', 'c']);
    expect(out[1].options).toEqual(['d']);
    expect(hidden).toBe(5);
  });

  it('上限落在组边界时整组保留，不产生空组', () => {
    const { groups: out, hidden } = truncateGroups(groups, 3);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('OpenAI');
    expect(hidden).toBe(6);
  });

  it('上限为 1 时只保留首组首项', () => {
    const { groups: out, hidden } = truncateGroups(groups, 1);
    expect(out).toEqual([{ label: 'OpenAI', options: ['a'] }]);
    expect(hidden).toBe(8);
  });

  it('不修改输入（切片返回新数组）', () => {
    truncateGroups(groups, 4);
    expect(groups[1].options).toEqual(['d', 'e']);
  });
});
