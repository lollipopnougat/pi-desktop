import { describe, it, expect } from 'vitest';
import { computeBreadcrumbPath, shortenHomePath } from '../../src/components/code/breadcrumb-path';

const CWD = '/Users/me/work/demo';
const HOME = '/Users/me';

/** 便捷断言：labels + 可点击段的 treeRoot/expandToPath */
const labels = (p: { segments: { label: string }[] }) => p.segments.map((s) => s.label);
const clickable = (p: { segments: { treeRoot: string | null }[] }) =>
  p.segments.filter((s) => s.treeRoot !== null).map((s) => s.label);

describe('computeBreadcrumbPath：项目内文件', () => {
  it('相对路径按 cwd 目录名 + 各级展示（保持原行为）', () => {
    const info = computeBreadcrumbPath('src/components/App.tsx', CWD, HOME);
    expect(labels(info)).toEqual(['demo', 'src', 'components', 'App.tsx']);
    expect(info.activePath).toBe('src/components/App.tsx');
    // 每段都可点击，且 treeRoot 均为项目根（''）
    expect(info.segments.every((s) => s.treeRoot === '')).toBe(true);
    // 根段不展开，末段展开到文件自身
    expect(info.segments[0].expandToPath).toBe('');
    expect(info.segments[1].expandToPath).toBe('src');
    expect(info.segments[3].expandToPath).toBe('src/components/App.tsx');
  });

  it('项目内绝对路径先剥掉 cwd 前缀，不再重复 cwd 目录名', () => {
    const info = computeBreadcrumbPath(`${CWD}/.pi-desktop/skills/x/SKILL.md`, CWD, HOME);
    expect(labels(info)).toEqual(['demo', '.pi-desktop', 'skills', 'x', 'SKILL.md']);
    expect(info.activePath).toBe('.pi-desktop/skills/x/SKILL.md');
  });

  it('同前缀的兄弟目录不算项目内（/Users/me/work/demo-copy）', () => {
    const info = computeBreadcrumbPath('/Users/me/work/demo-copy/a.ts', CWD, HOME);
    expect(labels(info)).toEqual(['~', 'work', 'demo-copy', 'a.ts']);
    expect(clickable(info)).toEqual(['demo-copy', 'a.ts']);
  });

  it('兼容 Windows 反斜杠相对路径', () => {
    const info = computeBreadcrumbPath('C:\\proj\\src\\a.ts', 'C:\\proj', 'C:\\Users\\me');
    expect(labels(info)).toEqual(['proj', 'src', 'a.ts']);
    expect(info.activePath).toBe('src/a.ts');
  });
});

describe('computeBreadcrumbPath：项目外文件（技能等）', () => {
  const SKILL = `${HOME}/.agents/skills/obsidian-markdown/SKILL.md`;

  it('家目录内的绝对路径显示成 ~ 起头，不再重复 cwd 段', () => {
    const info = computeBreadcrumbPath(SKILL, CWD, HOME);
    expect(labels(info)).toEqual(['~', '.agents', 'skills', 'obsidian-markdown', 'SKILL.md']);
    expect(info.activePath).toBe(SKILL);
  });

  it('只有文件自身与所在目录可点开目录树，上层目录为纯标签', () => {
    const info = computeBreadcrumbPath(SKILL, CWD, HOME);
    expect(clickable(info)).toEqual(['obsidian-markdown', 'SKILL.md']);
    const dirSeg = info.segments[3];
    const fileSeg = info.segments[4];
    // 目录树根 = 文件所在目录；文件段额外级联展开到文件
    expect(dirSeg.treeRoot).toBe(`${HOME}/.agents/skills/obsidian-markdown`);
    expect(dirSeg.expandToPath).toBe(`${HOME}/.agents/skills/obsidian-markdown`);
    expect(fileSeg.treeRoot).toBe(`${HOME}/.agents/skills/obsidian-markdown`);
    expect(fileSeg.expandToPath).toBe(SKILL);
    // 上层段落不可点击
    expect(info.segments.slice(0, 3).every((s) => s.treeRoot === null)).toBe(true);
  });

  it('非家目录的绝对路径以 / 起头', () => {
    const info = computeBreadcrumbPath('/tmp/piui/notes.md', CWD, HOME);
    expect(labels(info)).toEqual(['/', 'tmp', 'piui', 'notes.md']);
    expect(clickable(info)).toEqual(['piui', 'notes.md']);
    expect(info.segments[2].treeRoot).toBe('/tmp/piui');
  });

  it('home 为空时不缩写，且不因缺少家目录而误判', () => {
    const info = computeBreadcrumbPath(SKILL, CWD, '');
    expect(labels(info)).toEqual([
      '/',
      'Users',
      'me',
      '.agents',
      'skills',
      'obsidian-markdown',
      'SKILL.md'
    ]);
  });

  it('Windows 盘符路径的根段为盘符（不可点击）', () => {
    const info = computeBreadcrumbPath('C:\\temp\\a.txt', CWD, HOME);
    expect(labels(info)).toEqual(['C:', 'temp', 'a.txt']);
    expect(clickable(info)).toEqual(['temp', 'a.txt']);
    expect(info.segments[1].treeRoot).toBe('C:/temp');
  });

  it('末尾带分隔符也能解析', () => {
    const info = computeBreadcrumbPath(`${HOME}/.agents/skills/x/`, CWD, HOME);
    expect(labels(info)).toEqual(['~', '.agents', 'skills', 'x']);
  });
});

describe('shortenHomePath', () => {
  it('家目录内缩写为 ~，其它路径原样返回', () => {
    expect(shortenHomePath(`${HOME}/.agents/skills/x/SKILL.md`, HOME)).toBe(
      '~/.agents/skills/x/SKILL.md'
    );
    expect(shortenHomePath('/etc/hosts', HOME)).toBe('/etc/hosts');
    expect(shortenHomePath(`${HOME}/.agents/x`, '')).toBe(`${HOME}/.agents/x`);
  });
});
