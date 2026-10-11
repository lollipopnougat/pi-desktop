import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProjectPath, resolveReadablePath } from '../../electron/project-path';

let temp: string;
let root: string;
let sibling: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'piui-path-boundary-'));
  root = path.join(temp, 'project');
  sibling = path.join(temp, 'project-copy');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(root, 'src', 'example.txt'), 'inside');
  fs.writeFileSync(path.join(sibling, 'example.txt'), 'outside');
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('resolveProjectPath', () => {
  it('allows the root, child directories and relative or absolute child files', () => {
    expect(resolveProjectPath(root)).toBe(fs.realpathSync(root));
    expect(fs.readdirSync(resolveProjectPath(root, 'src'))).toEqual(['example.txt']);
    for (const input of ['src/example.txt', path.join(root, 'src', 'example.txt')]) {
      expect(fs.readFileSync(resolveProjectPath(root, input), 'utf8')).toBe('inside');
    }
  });

  it('rejects parent traversal and sibling names with the same prefix', () => {
    for (const input of [
      '..',
      '../project-copy',
      '../project-copy/example.txt',
      path.join(sibling, 'example.txt')
    ]) {
      expect(() => resolveProjectPath(root, input)).toThrow('项目目录之外');
    }
  });

  it('resolves an internal symlink and a symlinked project root', () => {
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'internal'), 'junction');
    expect(fs.readFileSync(resolveProjectPath(alias, 'internal/example.txt'), 'utf8')).toBe(
      'inside'
    );
  });

  it('rejects escaped directory symlinks through a symlinked project root', () => {
    fs.symlinkSync(sibling, path.join(root, 'external'), 'junction');
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    for (const cwd of [root, alias]) {
      expect(() => resolveProjectPath(cwd, 'external')).toThrow('项目目录之外');
      expect(() => resolveProjectPath(cwd, 'external/example.txt')).toThrow('项目目录之外');
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a file symlink outside the project', () => {
    fs.symlinkSync(path.join(sibling, 'example.txt'), path.join(root, 'link.txt'));
    expect(() => resolveProjectPath(root, 'link.txt')).toThrow('项目目录之外');
  });

  it('preserves missing-file failures instead of granting access', () => {
    expect(() => resolveProjectPath(root, 'missing')).toThrow();
  });
});

describe('resolveReadablePath', () => {
  let home: string;
  beforeEach(() => {
    home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, '.pi-desktop', 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'skills', 'global-skill'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pi-desktop', 'skills', 'demo', 'SKILL.md'), 'demo');
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'global-skill', 'SKILL.md'), 'global');
    for (const name of ['auth.json', 'models.json', 'mcp.json']) {
      fs.writeFileSync(path.join(home, '.pi-desktop', name), '{"secret":true}');
    }
    fs.writeFileSync(path.join(home, '.pi-desktop', 'ui-config.json'), '{}');
  });

  it('项目目录内按原项目边界放行', () => {
    expect(fs.readFileSync(resolveReadablePath(root, 'src/example.txt', { home }), 'utf8')).toBe(
      'inside'
    );
  });

  it('放行 ~/.agents 与 ~/.pi-desktop 下的技能文件', () => {
    const skill = path.join(home, '.agents', 'skills', 'global-skill', 'SKILL.md');
    expect(fs.readFileSync(resolveReadablePath(root, skill, { home }), 'utf8')).toBe('global');
    const local = 'skills/demo/SKILL.md';
    expect(
      fs.readFileSync(
        resolveReadablePath(root, path.join(home, '.pi-desktop', local), { home }),
        'utf8'
      )
    ).toBe('demo');
  });

  it('放行 extra 白名单根（内置技能目录）', () => {
    const builtin = path.join(temp, 'builtin-skills', 'creator');
    fs.mkdirSync(builtin, { recursive: true });
    fs.writeFileSync(path.join(builtin, 'SKILL.md'), 'builtin');
    expect(
      fs.readFileSync(
        resolveReadablePath(root, path.join(builtin, 'SKILL.md'), {
          home,
          extra: [path.join(temp, 'builtin-skills')]
        }),
        'utf8'
      )
    ).toBe('builtin');
  });

  it('凭证文件即使在白名单目录内也拒绝', () => {
    for (const name of ['auth.json', 'models.json', 'mcp.json']) {
      expect(() =>
        resolveReadablePath(root, path.join(home, '.pi-desktop', name), { home })
      ).toThrow('项目目录之外');
    }
    // 同名但不在配置目录根下的文件不受影响
    const nested = path.join(home, '.pi-desktop', 'skills', 'demo', 'auth.json');
    fs.writeFileSync(nested, 'demo');
    expect(resolveReadablePath(root, nested, { home })).toBe(fs.realpathSync(nested));
  });

  it('白名单之外仍拒绝（含目录软链逃逸）', () => {
    expect(() => resolveReadablePath(root, '../project-copy/example.txt', { home })).toThrow(
      '项目目录之外'
    );
    const escape = path.join(home, '.agents', 'escape');
    fs.symlinkSync(path.join(temp, 'project-copy'), escape, 'junction');
    expect(() => resolveReadablePath(root, path.join(escape, 'example.txt'), { home })).toThrow(
      '项目目录之外'
    );
  });

  it('白名单根不存在时跳过而不是报错', () => {
    const noAgents = path.join(temp, 'empty-home');
    fs.mkdirSync(path.join(noAgents, '.pi-desktop'), { recursive: true });
    fs.writeFileSync(path.join(noAgents, '.pi-desktop', 'notes.md'), 'notes');
    // ~/.agents 不存在：读 ~/.pi-desktop 下的文件应正常放行（缺失的白名单根直接跳过）
    expect(
      fs.readFileSync(
        resolveReadablePath(root, path.join(noAgents, '.pi-desktop', 'notes.md'), {
          home: noAgents
        }),
        'utf8'
      )
    ).toBe('notes');
    expect(fs.existsSync(path.join(noAgents, '.agents'))).toBe(false);
  });
});
