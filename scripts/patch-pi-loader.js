/**
 * Patch @earendil-works/pi-coding-agent 扩展加载器，使其在 Vite bundle 后仍能工作。
 *
 * 背景：pi SDK 的 loader.js（getAliases）用 import.meta.resolve 解析 pi 内部包路径。
 * Vite/Rollup bundle 后 import.meta.resolve 被静态求值为 undefined，导致
 * fileURLToPath(undefined(...)) 抛错 '(void 0) is not a function'，
 * 所有扩展加载失败（'Cannot find module typebox' 是其连带表现）。
 *
 * 本脚本把 `fileURLToPath(import.meta.resolve(specifier))` 改写为容错版本：
 * 运行时若 import.meta.resolve 不可用或解析失败，返回 undefined。
 * getAliases 拿到 undefined alias 后，jiti 回退到默认 node_modules 解析，
 * 扩展从自身 node_modules 正确解析 pi 内部包（这是 npm 安装场景的正确行为）。
 *
 * 同时在项目根 node_modules 创建 typebox 等包的绝对路径符号链接，
 * 供 loader 的 require.resolve('typebox') 从 dist-electron 解析到。
 *
 * 幂等：重复运行不产生副作用。
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sdkPkgRoot = path.join(
  projectRoot,
  'node_modules/@earendil-works/pi-coding-agent'
);
const loaderPath = path.join(
  sdkPkgRoot,
  'dist/core/extensions/loader.js'
);

const MARKER = '/* pi-desktop bundle patch applied */';

function patchLoader() {
  if (!fs.existsSync(loaderPath)) {
    console.log('[patch-loader] loader.js not found, skip');
    return;
  }
  let src = fs.readFileSync(loaderPath, 'utf8');

  if (src.includes(MARKER)) {
    console.log('[patch-loader] already patched, skip');
    return;
  }

  const target = 'return fileURLToPath(import.meta.resolve(specifier));';
  if (!src.includes(target)) {
    console.log('[patch-loader] target pattern not found, skip');
    return;
  }

  // 容错版本：bundle 后 import.meta.resolve 可能是 undefined 或解析失败，
  // 此时返回 undefined 让 jiti 回退到默认 node_modules 解析。
  const replacement =
    'try { return fileURLToPath(import.meta.resolve(specifier)); } ' +
    'catch { return undefined; }';

  src = src.replace(target, replacement);

  // packageIndex 原为 path.resolve(__dirname, "../..", "index.js")，
  // bundle 后 __dirname 指向 dist-electron，推算出错误路径。
  // 改为 import.meta.resolve 容错解析；失败返回 undefined，jiti 回退默认解析。
  const pkgIndexTarget =
    'const packageIndex = path.resolve(__dirname, "../..", "index.js");';
  const pkgIndexReplacement =
    'const packageIndex = (() => { try { return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); } catch { return undefined; } })();';
  if (src.includes(pkgIndexTarget)) {
    src = src.replace(pkgIndexTarget, pkgIndexReplacement);
  }
  src = src + '\n' + MARKER + '\n';
  fs.writeFileSync(loaderPath, src, 'utf8');
  console.log('[patch-loader] patched loader.js OK');
}

function linkPkg(relPath, linkName) {
  const target = path.join(sdkPkgRoot, 'node_modules', relPath);
  const linkPath = path.join(projectRoot, 'node_modules', linkName);
  if (!fs.existsSync(target)) {
    console.log(`[patch-loader] source not found, skip link: ${linkName}`);
    return;
  }
  // 幂等：已存在且指向正确目标则跳过
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath);
      if (path.resolve(path.dirname(linkPath), cur) === target) {
        return;
      }
    } else if (st.isDirectory()) {
      // 已存在真实目录（如项目自身直接依赖 typebox）——不覆盖，保留原样。
      // 0.86 起 SDK 自带 typebox 1.3.27，root 已有 1.3.10 也能用（仅类型层 import
      // 主入口，运行时由 SDK 嵌套副本提供）。
      console.log(`[patch-loader] ${linkName} already a real directory, skip link`);
      return;
    }
    fs.rmSync(linkPath, { force: true });
  } catch {
    // 不存在，继续
  }
  // 用绝对路径符号链接（相对符号链接在 ESM resolver 下会因 realpath 规范化失效）
  fs.symlinkSync(target, linkPath, 'dir');
  console.log(`[patch-loader] linked ${linkName} -> ${target}`);
}

patchLoader();
linkPkg('typebox', 'typebox');
linkPkg('@earendil-works/pi-agent-core', '@earendil-works/pi-agent-core');
linkPkg('@earendil-works/pi-ai', '@earendil-works/pi-ai');
linkPkg('@earendil-works/pi-tui', '@earendil-works/pi-tui');

console.log('[patch-loader] done');
