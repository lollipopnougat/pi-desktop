/**
 * 生成随安装包分发的第三方许可清单：resources/THIRD-PARTY-NOTICES.txt
 *
 * 为什么需要：electron-builder 的 files 负规则会剔除 node_modules 里的文档
 * （`!**\/node_modules/**\/*.{md,markdown,...}` 会带走大量 LICENSE.md / COPYING.md），
 * 而 MIT / Apache-2.0 / BSD / ISC 等许可证都要求「分发时随附许可与版权声明」，
 * 所以构建期把整棵依赖树的许可文本汇总成一份纯文本，放进 `resourcesPath` 根目录：
 *   · 单文件便于用户在安装目录里直接找到，不受 asar 打包与负规则影响；
 *   · 不依赖 node_modules 里的文件在打包后是否还存在。
 *
 * 用法：
 *   node scripts/generate-third-party-notices.mjs                          # → resources/THIRD-PARTY-NOTICES.txt
 *   node scripts/generate-third-party-notices.mjs --out /tmp/notices.txt   # 指定输出路径
 *   node scripts/generate-third-party-notices.mjs --modules D:/x/node_modules  # 指定依赖树（默认 <repo>/node_modules）
 *   node scripts/generate-third-party-notices.mjs --project /tmp/fixture   # 指定项目目录（读它的 package.json / package-lock.json）
 *
 * 数据来源：
 * - package-lock.json 的 `packages` 键（`node_modules/**`）→ 包名 / 版本 / 声明许可证 / 是否构建期依赖
 * - 各包目录根部的许可类文件（licen[cs]e / copying / unlicense / copyright / notice*）原文，逐字节照录
 * - 未随附许可文件的包（如 @earendil-works/pi-* 全系列）→ 第 2 部分列出，第 3 部分附上「同许可证的
 *   其他包随附的原文」，并标注来源包与逐字节相同的包数；**不臆造 / 不手写许可文本**
 *
 * 挂载点：package.json 的 `electron:build*` 脚本在 electron-builder 之前跑 `npm run notices`，
 * 产物经 `build.extraResources`（`{"from":"resources/THIRD-PARTY-NOTICES.txt"}`）落到安装目录。
 *
 * tests/packaging/third-party-notices.test.ts 覆盖下面的纯函数（文件名筛选、字段归一化、渲染）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_OUT = path.join('resources', 'THIRD-PARTY-NOTICES.txt');
/** 单个许可文件字节上限，超出的只记一行说明、不逐字照录 */
export const MAX_FILE_BYTES = 512 * 1024;
/** 每个包最多收录几个许可类文件（LICENSE / COPYING / NOTICE…） */
export const MAX_FILES_PER_PACKAGE = 4;
/** 生成结果超过这个大小就在控制台告警（正常约 2–3 MB） */
export const MAX_NOTICE_BYTES = 8 * 1024 * 1024;

const RULE = '='.repeat(80);
const THIN = '-'.repeat(80);

/** 许可类文件名：licen[cs]e / copying / unlicense / copyright / notice，可带 `-MIT`、`.md` 等后缀 */
export const LICENSE_FILE_RE = /^(licen[cs]e|copying|unlicense|copyright|notice)([._-].*)?$/i;

/** 名字排序（不依赖 locale，保证跨平台生成结果一致） */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 许可证文件排序权重：正主（LICENSE）在前，COPYING / UNLICENSE / NOTICE 依次靠后；无后缀 > .txt > .md */
function licenseFileRank(name) {
  const lower = name.toLowerCase();
  const family = lower.startsWith('licen')
    ? 0
    : lower.startsWith('copying')
      ? 1
      : lower.startsWith('unlicense')
        ? 2
        : 3;
  const ext = path.extname(lower);
  const extRank =
    ext === '' ? 0 : ext === '.txt' ? 1 : ext === '.md' || ext === '.markdown' ? 2 : 3;
  return family * 10 + extRank;
}

/** 从目录列表里挑出要收录的许可类文件名（按权重排序、截断到 max 个） */
export function pickLicenseFileNames(names, max = MAX_FILES_PER_PACKAGE) {
  return names
    .filter((name) => LICENSE_FILE_RE.test(name))
    .sort((a, b) => licenseFileRank(a) - licenseFileRank(b) || compareStrings(a, b))
    .slice(0, max);
}

/** 归一化 package.json / package-lock.json 的 license（或老式 licenses）字段 */
export function normalizeLicenseField(value) {
  if (Array.isArray(value)) {
    const parts = value.map((item) => normalizeLicenseField(item)).filter(Boolean);
    return parts.join(' OR ');
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text.toLowerCase() === 'unlicensed' ? '' : text;
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') {
    return value.type.trim();
  }
  return '';
}

/** 归一化 package.json 的 author / contributors 字段（第 2 部分没有许可文件，用作者行做版权归属） */
export function normalizeAuthorField(pkg) {
  const parts = [];
  const push = (value) => {
    if (!value) return;
    if (typeof value === 'string') parts.push(value.trim());
    else if (typeof value === 'object' && typeof value.name === 'string') {
      parts.push(
        [value.name.trim(), value.email ? `<${value.email}>` : ''].filter(Boolean).join(' ')
      );
    }
  };
  push(pkg?.author);
  if (Array.isArray(pkg?.contributors)) pkg.contributors.slice(0, 5).forEach(push);
  return [...new Set(parts.filter(Boolean))].join('；');
}

/** 许可证标识 → SPDX 官方文本地址（第 2 部分给没随附文本的包指路） */
export function spdxUrl(license) {
  if (!license) return 'https://spdx.org/licenses/';
  const first = license
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/)[0]
    .trim();
  return `https://spdx.org/licenses/${encodeURIComponent(first)}.html`;
}

/** 读 package.json（包名/版本/许可证兜底用） */
function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readLicenseFile(dir, name) {
  const full = path.join(dir, name);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  if (stat.size > MAX_FILE_BYTES) {
    return {
      name,
      text: `（文件过大：${(stat.size / 1024).toFixed(1)} KB，超过 ${MAX_FILE_BYTES / 1024} KB 上限，未逐字收录）`,
      skipped: true
    };
  }
  const text = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return text.trim() ? { name, text } : null;
}

/**
 * 按 package-lock.json 收集依赖包与它们的许可文本。
 * @param {{ projectDir?: string, modulesDir?: string }} options
 */
export function collectPackages({ projectDir = root, modulesDir } = {}) {
  const modules = modulesDir ?? path.join(projectDir, 'node_modules');
  const lockPath = path.join(projectDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error(`找不到 ${lockPath}（依赖清单就是它的产物，不能缺）`);
  }
  if (!fs.existsSync(modules)) {
    throw new Error(`找不到依赖目录 ${modules}，先执行 npm install`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pkg = readPackageJson(projectDir);
  const packages = [];
  const missing = [];

  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || !meta || !meta.version) continue;
    const rel = key.slice('node_modules/'.length);
    const nested = rel.lastIndexOf('node_modules/');
    const name = nested === -1 ? rel : rel.slice(nested + 'node_modules/'.length);
    const pkgDir = path.join(modules, rel);
    if (!fs.existsSync(pkgDir)) {
      missing.push(name);
      continue;
    }
    let license = normalizeLicenseField(meta.license ?? meta.licenses);
    let entries = [];
    try {
      entries = fs.readdirSync(pkgDir);
    } catch {
      missing.push(name);
      continue;
    }
    const files = [];
    for (const file of pickLicenseFileNames(entries)) {
      const read = readLicenseFile(pkgDir, file);
      if (read) files.push(read);
    }
    // 没有许可文件的包才需要读 package.json：补许可证字段 + 取 author 作为版权归属
    const pkgJson = !license || files.length === 0 ? readPackageJson(pkgDir) : null;
    if (!license) {
      license = normalizeLicenseField(pkgJson?.license ?? pkgJson?.licenses);
    }
    packages.push({
      name,
      version: String(meta.version),
      dir: key,
      license,
      author: files.length === 0 ? normalizeAuthorField(pkgJson) : '',
      buildOnly: meta.dev === true,
      files
    });
  }

  packages.sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.version, b.version));

  return {
    appName: pkg.build?.productName || pkg.name || 'pi-desktop',
    appVersion: pkg.version || '',
    appLicense: normalizeLicenseField(pkg.license),
    generatedAt: new Date().toISOString(),
    modulesDir: modules,
    packages,
    missing
  };
}

/**
 * 第 3 部分的文本挑选：对某个许可证，取「声明该许可证且随附了文本」的包中最常见的那份原文
 * （逐字节相同的算一份），并记录来源包与相同份数。不合成、不改写。
 */
function pickCanonicalTexts(packages, licenseIds) {
  const out = new Map();
  for (const id of licenseIds) {
    const declaring = packages.filter((item) => item.license === id);
    const withText = declaring.filter((item) => item.files.length > 0);
    const tally = new Map();
    for (const item of withText) {
      const file = item.files[0];
      const entry = tally.get(file.text) ?? {
        count: 0,
        text: file.text,
        fileName: file.name,
        source: `${item.name}@${item.version}`
      };
      entry.count += 1;
      tally.set(file.text, entry);
    }
    const ranked = [...tally.values()].sort(
      (a, b) => b.count - a.count || compareStrings(a.source, b.source)
    );
    out.set(id, {
      declared: declaring.length,
      withText: withText.length,
      best: ranked[0] ?? null
    });
  }
  return out;
}

/** 渲染整份清单（纯函数，方便测试） */
export function renderNotices(model) {
  const { packages } = model;
  const withText = packages.filter((item) => item.files.length > 0);
  const withoutText = packages.filter((item) => item.files.length === 0);
  const buildOnly = packages.filter((item) => item.buildOnly).length;
  const bytes = withText.reduce(
    (sum, item) => sum + item.files.reduce((acc, file) => acc + Buffer.byteLength(file.text), 0),
    0
  );
  const lines = [];

  // ── 头部说明 ────────────────────────────────────────────────────────────────
  lines.push(RULE);
  lines.push(`${model.appName} ${model.appVersion} 第三方许可清单（THIRD-PARTY NOTICES）`);
  lines.push(RULE);
  lines.push(
    '本文件由构建脚本 scripts/generate-third-party-notices.mjs 自动生成（npm run notices，'
  );
  lines.push('每次 electron:build 前重跑），随安装包分发在 resources 目录根部。');
  lines.push('');
  lines.push(`依赖清单来源：package-lock.json（共 ${packages.length} 个包）`);
  lines.push(`  · 第 1 部分：随附自身许可文件的包 ${withText.length} 个（许可原文逐字照录）`);
  lines.push(`  · 第 2 部分：仅声明许可证、未随附文本的包 ${withoutText.length} 个`);
  lines.push('  · 第 3 部分：第 2 部分涉及许可证的标准文本（取自本依赖树中其他包随附的原文）');
  lines.push('');
  lines.push(
    `其中 ${buildOnly} 个包仅在构建期使用（会被 Vite 编译进 dist/ 前端产物），` +
      `${packages.length - buildOnly} 个是运行时依赖（随 app.asar 一起分发）。`
  );
  lines.push('两类都构成分发的一部分，故一并列出。');
  lines.push(
    `${model.appName} 自身以 ${model.appLicense || '自有'} 协议分发，见仓库根目录 LICENSE；` +
      '本文件仅覆盖第三方依赖。'
  );
  lines.push(`许可原文合计 ${(bytes / 1024).toFixed(1)} KB，生成时间 ${model.generatedAt}。`);
  if (model.missing && model.missing.length) {
    lines.push('');
    lines.push(
      `注意：另有 ${model.missing.length} 个包未安装在本机依赖目录中（多为其他平台的可选二进制依赖），` +
        '不参与本机构建、也不构成分发内容，故未收录（完整名单见构建日志）。'
    );
  }

  // ── 第 1 部分：随附许可文件 ────────────────────────────────────────────────
  lines.push('');
  lines.push(RULE);
  lines.push(`第 1 部分：随附许可文件的包（${withText.length} 个，按包名排序）`);
  lines.push(RULE);
  withText.forEach((item, index) => {
    lines.push('');
    lines.push(
      `[${String(index + 1).padStart(4, '0')}] ${item.name}@${item.version} — ` +
        `${item.license || '未声明许可证'}${item.buildOnly ? '（构建期依赖）' : ''}`
    );
    lines.push(`路径：${item.dir}`);
    for (const file of item.files) {
      lines.push(`文件：${file.name}`);
      lines.push(THIN);
      lines.push(file.text);
      lines.push(THIN);
    }
  });

  // ── 第 2 部分：只声明许可证 ────────────────────────────────────────────────
  lines.push('');
  lines.push(RULE);
  lines.push(`第 2 部分：未随附许可文件、仅声明许可证的包（${withoutText.length} 个）`);
  lines.push(RULE);
  lines.push('这些包在 package.json 的 license 字段里声明了许可证，但包内没有许可文件。');
  lines.push('对应的标准文本见第 3 部分；SPDX 官方文本见每条下方的链接。');
  withoutText.forEach((item, index) => {
    lines.push('');
    lines.push(
      `[${String(index + 1).padStart(4, '0')}] ${item.name}@${item.version} — ` +
        `${item.license ? `声明许可证：${item.license}` : '未声明许可证（package.json 无有效 license 字段）'}` +
        `${item.buildOnly ? '（构建期依赖）' : ''}`
    );
    lines.push(`路径：${item.dir}`);
    if (item.author) lines.push(`作者：${item.author}`);
    if (item.license) lines.push(`官方文本：${spdxUrl(item.license)}`);
  });

  // ── 第 3 部分：标准文本附录 ────────────────────────────────────────────────
  const needed = [...new Set(withoutText.map((item) => item.license).filter(Boolean))].sort(
    compareStrings
  );
  const canonical = pickCanonicalTexts(packages, needed);
  const secondPartCount = new Map();
  for (const item of withoutText) {
    if (item.license)
      secondPartCount.set(item.license, (secondPartCount.get(item.license) ?? 0) + 1);
  }
  lines.push('');
  lines.push(RULE);
  lines.push(`第 3 部分：标准许可文本（第 2 部分涉及的 ${needed.length} 种许可证）`);
  lines.push(RULE);
  lines.push('以下文本逐字取自本依赖树中随附了许可文件的包（标注了来源），不是手写或改写的内容。');
  lines.push(
    '同一许可证下各包的版权声明行各不相同：第 2 部分中的包各自的版权归属见其条目下的「作者」'
  );
  lines.push('（取自该包 package.json 的 author / contributors），并以各包仓库元数据为准。');
  for (const id of needed) {
    const info = canonical.get(id);
    lines.push('');
    lines.push(THIN);
    lines.push(
      `${id} —— 第 2 部分有 ${secondPartCount.get(id) ?? 0} 个包声明该许可证；` +
        `本依赖树中共 ${info.declared} 个包声明该许可证，其中 ${info.withText} 个随附了许可文件`
    );
    if (info.best) {
      lines.push(
        `文本来源：${info.best.source} 随附的 ${info.best.fileName}` +
          (info.best.count > 1
            ? `（本树中另有 ${info.best.count - 1} 个包随附的文件与下文逐字节相同）`
            : '（本树中仅该包随附此文本）')
      );
      lines.push(THIN);
      lines.push(info.best.text);
    } else {
      lines.push(THIN);
      lines.push(`（本依赖树中没有随附该许可证文本的包，请参考 ${spdxUrl(id)}）`);
    }
  }
  if (!needed.length) {
    lines.push('');
    lines.push('（无需附录：所有包都随附了自己的许可文件。）');
  }
  lines.push('');
  lines.push(RULE);
  lines.push('清单结束');
  lines.push(RULE);

  return lines.join('\n') + '\n';
}

/** CLI 参数解析：--out / --project / --modules / --quiet */
export function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, projectDir: undefined, modulesDir: undefined, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) options.out = argv[++i];
    else if (arg === '--project' && argv[i + 1]) options.projectDir = path.resolve(argv[++i]);
    else if (arg === '--modules' && argv[i + 1]) options.modulesDir = path.resolve(argv[++i]);
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      '用法：node scripts/generate-third-party-notices.mjs [--out <文件>] [--project <项目目录>] [--modules <node_modules 目录>] [--quiet]'
    );
    return 0;
  }
  const projectDir = options.projectDir ?? root;
  const model = collectPackages({ projectDir, modulesDir: options.modulesDir });
  const declared = model.packages.length + model.missing.length;
  // 护栏：大多数包找不到目录说明依赖没装好（node_modules 空 / 只装了生产依赖）。
  // 此时生成的清单会声称“共 N 个包”却几乎不含许可原文，随包分发反而制造合规风险 → 直接失败。
  if (declared > 0 && model.missing.length > declared / 2) {
    throw new Error(
      `依赖未安装完整：package-lock.json 声明 ${declared} 个包，其中 ${model.missing.length} 个在 node_modules 里找不到` +
        `（先执行 npm install / npm ci，再重跑 npm run notices）`
    );
  }
  const text = renderNotices(model);
  const outPath = path.resolve(root, options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');

  const size = Buffer.byteLength(text);
  const withText = model.packages.filter((item) => item.files.length).length;
  const log = options.quiet ? () => {} : (...args) => console.log(...args);
  log(
    `[notices] 依赖包 ${model.packages.length} 个（运行时 ${
      model.packages.length - model.packages.filter((item) => item.buildOnly).length
    } / 构建期 ${model.packages.filter((item) => item.buildOnly).length}）`
  );
  log(
    `[notices] 随附许可文件 ${withText} 个包；仅声明许可证 ${model.packages.length - withText} 个包`
  );
  log(`[notices] 已写入 ${path.relative(root, outPath)}（${(size / 1024).toFixed(1)} KB）`);
  if (model.missing.length) {
    console.warn(
      `[notices] 警告：${model.missing.length} 个包目录不存在，未收录：${model.missing
        .slice(0, 10)
        .join(', ')}${model.missing.length > 10 ? ' …' : ''}`
    );
  }
  if (size > MAX_NOTICE_BYTES) {
    console.warn(
      `[notices] 警告：生成结果 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_NOTICE_BYTES / 1024 / 1024} MB，考虑调整收录范围`
    );
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[notices] 生成失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
