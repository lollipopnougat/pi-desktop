/**
 * 第三方许可清单生成器（scripts/generate-third-party-notices.mjs）的端到端测试。
 *
 * 用临时目录搭一棵假依赖树（带 / 不带许可文件、多文件、缺目录、构建期依赖、未声明许可证），
 * 跑真实 CLI，校验产物结构、原文照录、附录来源与生成的确定性。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../../scripts/generate-third-party-notices.mjs', import.meta.url)
);

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2024 Alpha Author',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  ''
].join('\n');

const ISC_TEXT = [
  'ISC License',
  '',
  'Copyright (c) 2024 Delta Author',
  '',
  'Permission to use, copy, modify, and/or distribute this software for any',
  'purpose with or without fee is hereby granted.',
  ''
].join('\n');

let fixtureDir = '';
let outFile = '';
let output = '';

/** 写一个包目录：pkg 形如 '@scope/beta' / 'alpha' */
function writePackage(
  rel: string,
  files: Record<string, string>,
  pkg: Record<string, unknown> = {}
) {
  const dir = path.join(fixtureDir, 'node_modules', rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: rel, version: '0.0.0', ...pkg }, null, 2)
  );
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notices-'));
  outFile = path.join(fixtureDir, 'out', 'THIRD-PARTY-NOTICES.txt');

  fs.writeFileSync(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify(
      {
        name: 'pi-desktop-fixture',
        version: '9.9.9',
        license: 'MIT',
        build: { productName: 'Pi Desktop Fixture' }
      },
      null,
      2
    )
  );

  // alpha：MIT + 两个许可文件（LICENSE / LICENSE-MIT）→ 都该收录
  writePackage('alpha', { LICENSE: MIT_TEXT, 'LICENSE-MIT': MIT_TEXT }, { license: 'MIT' });
  // @scope/beta：Apache-2.0，只有 LICENSE.md（被 files 负规则排除的那一类）
  writePackage(
    '@scope/beta',
    { 'LICENSE.md': 'Apache License\nVersion 2.0, January 2004\n' },
    { license: 'Apache-2.0' }
  );
  // gamma：声明 MIT 但没有许可文件 → 第 2 部分，版权归属走 author
  writePackage(
    'gamma',
    { 'index.js': 'module.exports = 1;\n' },
    { license: 'MIT', author: 'Gamma Author <g@example.com>' }
  );
  // delta：ISC + 只带 COPYING（验证非 LICENSE 文件名也能被识别），给附录提供文本
  writePackage('delta', { COPYING: ISC_TEXT }, { license: 'ISC' });
  // epsilon：老式 licenses 数组字段 + 未随附文件
  writePackage('epsilon', {}, { licenses: [{ type: 'BSD-3-Clause' }] });
  // zeta：既没许可文件也没 license 字段
  writePackage('zeta', {});
  // nested：嵌套安装（node_modules/alpha/node_modules/nested）→ 包名应取最后一段
  writePackage('alpha/node_modules/nested', { LICENSE: MIT_TEXT }, { license: 'MIT' });

  fs.writeFileSync(
    path.join(fixtureDir, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'pi-desktop-fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'pi-desktop-fixture', version: '9.9.9' },
          'node_modules/alpha': { version: '1.0.0', license: 'MIT', dev: true },
          'node_modules/@scope/beta': { version: '2.0.0', license: 'Apache-2.0' },
          'node_modules/gamma': { version: '3.0.0', license: 'MIT' },
          'node_modules/delta': { version: '4.0.0', license: 'ISC' },
          'node_modules/epsilon': { version: '5.0.0' },
          'node_modules/zeta': { version: '6.0.0' },
          'node_modules/alpha/node_modules/nested': { version: '7.0.0', license: 'MIT' },
          'node_modules/gone': { version: '8.0.0', license: 'MIT' }
        }
      },
      null,
      2
    )
  );

  const run = spawnSync(
    process.execPath,
    [scriptPath, '--project', fixtureDir, '--out', outFile, '--quiet'],
    { encoding: 'utf8' }
  );
  expect(run.stderr).toContain('警告：1 个包目录不存在');
  expect(run.stderr).toContain('gone');
  expect(run.status).toBe(0);
  output = fs.readFileSync(outFile, 'utf8');
});

afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('第三方许可清单生成器', () => {
  it('头部说明含产品名、版本、包数量与三部分索引', () => {
    expect(output).toContain('Pi Desktop Fixture 9.9.9 第三方许可清单');
    expect(output).toContain('依赖清单来源：package-lock.json（共 7 个包）');
    expect(output).toContain('第 1 部分：随附自身许可文件的包 4 个');
    expect(output).toContain('第 2 部分：仅声明许可证、未随附文本的包 3 个');
    expect(output).toContain('其中 1 个包仅在构建期使用');
    // 8 个包里有 1 个（gone）没安装 → 头部要有说明
    expect(output).toContain('另有 1 个包未安装在本机依赖目录中');
  });

  it('第 1 部分逐字照录许可文本，且一个包的多个许可文件都收录', () => {
    expect(output).toContain('[0001] @scope/beta@2.0.0 — Apache-2.0');
    expect(output).toContain('文件：LICENSE.md');
    expect(output).toContain('[0002] alpha@1.0.0 — MIT（构建期依赖）');
    expect(output).toContain('路径：node_modules/alpha');
    expect(output).toContain(MIT_TEXT);
    // alpha 同时带 LICENSE 与 LICENSE-MIT → 两个文件都该收录
    expect(output.match(/^文件：LICENSE$/gm)?.length).toBe(2);
    expect(output.match(/^文件：LICENSE-MIT$/gm)?.length).toBe(1);
    // COPYING 这类非 LICENSE 命名也识别
    expect(output).toContain('[0003] delta@4.0.0 — ISC');
    expect(output).toContain('文件：COPYING');
    expect(output).toContain(ISC_TEXT);
    // 嵌套安装的包名取 node_modules 之后的一段
    expect(output).toContain('[0004] nested@7.0.0 — MIT');
    expect(output).toContain('路径：node_modules/alpha/node_modules/nested');
  });

  it('第 2 部分列出没有许可文件的包、带 author 与 SPDX 链接；区分未声明许可证', () => {
    expect(output).toContain('第 2 部分：未随附许可文件、仅声明许可证的包（3 个）');
    expect(output).toContain('[0001] epsilon@5.0.0 — 声明许可证：BSD-3-Clause');
    expect(output).toContain('官方文本：https://spdx.org/licenses/BSD-3-Clause.html');
    expect(output).toContain('[0002] gamma@3.0.0 — 声明许可证：MIT');
    expect(output).toContain('作者：Gamma Author <g@example.com>');
    expect(output).toContain(
      '[0003] zeta@6.0.0 — 未声明许可证（package.json 无有效 license 字段）'
    );
    // 未声明许可证的包不给 SPDX 链接
    expect(output).not.toContain('/licenses/.html');
  });

  it('第 3 部分为缺失文本的许可证附上同许可证其他包随附的原文（不改写、标注来源）', () => {
    expect(output).toContain('第 3 部分：标准许可文本（第 2 部分涉及的 2 种许可证）');
    expect(output).toContain(
      'MIT —— 第 2 部分有 1 个包声明该许可证；本依赖树中共 3 个包声明该许可证，其中 2 个随附了许可文件'
    );
    expect(output).toContain(
      '文本来源：alpha@1.0.0 随附的 LICENSE（本树中另有 1 个包随附的文件与下文逐字节相同）'
    );
    // 随附了文本的许可证（ISC）不进附录，第 1 部分已收录
    expect(output).not.toContain('ISC —— 第 2 部分');
    // 树里没有任何 BSD-3-Clause 文本 → 只能给官方链接，不许编造
    expect(output).toContain('BSD-3-Clause —— 第 2 部分有 1 个包声明该许可证');
    expect(output).toContain(
      '（本依赖树中没有随附该许可证文本的包，请参考 https://spdx.org/licenses/BSD-3-Clause.html）'
    );
    expect(output).toContain('清单结束');
  });

  it('依赖没装好时直接失败，不写出一份骗人的清单', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notices-bare-'));
    try {
      fs.writeFileSync(
        path.join(bare, 'package.json'),
        JSON.stringify({ name: 'bare', version: '1.0.0' }, null, 2)
      );
      fs.writeFileSync(
        path.join(bare, 'package-lock.json'),
        JSON.stringify(
          {
            name: 'bare',
            lockfileVersion: 3,
            packages: {
              '': { name: 'bare', version: '1.0.0' },
              'node_modules/one': { version: '1.0.0', license: 'MIT' },
              'node_modules/two': { version: '1.0.0', license: 'MIT' }
            }
          },
          null,
          2
        )
      );
      const out = path.join(bare, 'out.txt');
      const runCli = () =>
        spawnSync(process.execPath, [scriptPath, '--project', bare, '--out', out, '--quiet'], {
          encoding: 'utf8'
        });

      // ① 根本没有 node_modules
      const noDir = runCli();
      expect(noDir.status).toBe(1);
      expect(noDir.stderr).toContain('找不到依赖目录');
      expect(fs.existsSync(out)).toBe(false);

      // ② node_modules 在但几乎全空（空目录 / 只装了生产依赖）→ 缺失过半直接失败
      fs.mkdirSync(path.join(bare, 'node_modules'), { recursive: true });
      const almostEmpty = runCli();
      expect(almostEmpty.status).toBe(1);
      expect(almostEmpty.stderr).toContain('依赖未安装完整');
      expect(almostEmpty.stderr).toContain('npm install / npm ci');
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('生成结果只差时间戳：同输入两次运行一致', () => {
    const again = spawnSync(
      process.execPath,
      [scriptPath, '--project', fixtureDir, '--out', path.join(fixtureDir, 'again.txt'), '--quiet'],
      { encoding: 'utf8' }
    );
    expect(again.status).toBe(0);
    const strip = (text: string) => text.replace(/生成时间 [^\n]+/g, '');
    expect(strip(fs.readFileSync(path.join(fixtureDir, 'again.txt'), 'utf8'))).toBe(strip(output));
  });
});
