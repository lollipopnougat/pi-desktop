import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * 构建期把 SDK 依赖的 Photon WASM 拷到主进程产物目录。
 *
 * ## 为什么需要这个插件
 *
 * SDK 用 Photon（`@silvia-odwyer/photon-node`）做图片缩放（`dist/utils/image-resize-core.js`
 * 的 `resizeImageInProcess`）。Photon 的 CJS 入口在模块初始化时按 `__dirname` 读同目录的
 * wasm 再编译：
 *
 *   const B = X.join(__dirname, "photon_rs_bg.wasm"), H = Y.readFileSync(B),
 *         J = new WebAssembly.Module(H);
 *
 * 主进程由 Vite 打包，SDK 的 photon 入口被 rollup 成 `dist-electron/photon_rs-<hash>.js`，
 * 运行时 `__dirname` 变成 `dist-electron`，而 Vite 不会把 `.wasm` 一起 emit。缺文件时：
 *
 * 1. `photon.js` 的 `loadPhoton()` 吞掉异常返回 null（它的兜底路径只有
 *    `dirname(process.execPath)` / `process.cwd()`，开发与打包环境都不命中）；
 * 2. `resizeImageInProcess()` 拿到 null 直接 `return null`；
 * 3. `processImage()` 把图片替换成
 *    `[Image omitted: could not be resized below the inline image size limit.]`。
 *
 * 这个失败点在「尺寸与体积都已达标就直接返回」的判断**之前**，所以**任何**图片（哪怕
 * 10KB 的 PNG）都会被丢掉，不只是超大图 —— 症状是上传图片后模型只看到一行占位文本。
 *
 * ## 兜底与打包
 *
 * - 打包版读的是 asar 内的 `dist-electron/photon_rs_bg.wasm`，Electron 的 fs 对 asar
 *   透明（readFileSync 正常），不需要进 `asarUnpack`；
 * - wasm 缺失只告警不抛错：构建不该因为「SDK 将来换了缩放实现」而整体失败，但必须在
 *   终端里说清症状，否则又会退化成静默丢图。
 */

export const PHOTON_WASM_FILENAME = 'photon_rs_bg.wasm';

const PHOTON_PACKAGE = '@silvia-odwyer/photon-node';
const SDK_SCOPE = '@earendil-works';

/**
 * 在已安装的依赖树里找 `photon_rs_bg.wasm`。
 *
 * npm 依赖提升规则决定 Photon 可能是顶层依赖，也可能嵌在 SDK 自己的 node_modules 里
 * （当前就是后者），所以按候选目录逐个探测，再对 `@earendil-works/*` 扫一遍兜底。
 */
export function resolvePhotonWasm(projectRoot: string = process.cwd()): string | null {
  const candidates = [
    path.join(projectRoot, 'node_modules', PHOTON_PACKAGE),
    path.join(
      projectRoot,
      'node_modules',
      SDK_SCOPE,
      'pi-coding-agent',
      'node_modules',
      PHOTON_PACKAGE
    )
  ];

  const scopeDir = path.join(projectRoot, 'node_modules', SDK_SCOPE);
  if (existsSync(scopeDir)) {
    for (const entry of readdirSync(scopeDir)) {
      candidates.push(path.join(scopeDir, entry, 'node_modules', PHOTON_PACKAGE));
    }
  }

  for (const dir of candidates) {
    const file = path.join(dir, PHOTON_WASM_FILENAME);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * 主进程构建完成后把 wasm 放到产物目录旁（`writeBundle` 在 rollup 写完所有 chunk 之后跑）。
 * `apply: 'build'` 同时覆盖 `vite build` 与 `npm run dev`（vite-plugin-electron 走的也是 build）。
 */
export function photonWasmPlugin(projectRoot: string = process.cwd()): Plugin {
  return {
    name: 'pi-desktop:photon-wasm',
    apply: 'build',
    writeBundle(options) {
      const outDir = path.resolve(projectRoot, options.dir ?? 'dist-electron');
      const source = resolvePhotonWasm(projectRoot);
      if (!source) {
        this.warn(
          `找不到 ${PHOTON_PACKAGE} 的 ${PHOTON_WASM_FILENAME}（依赖没装好？）。` +
            '缺少它时 SDK 无法缩放图片，聊天里上传的图片会被替换成 ' +
            '"[Image omitted: could not be resized below the inline image size limit.]"'
        );
        return;
      }
      mkdirSync(outDir, { recursive: true });
      copyFileSync(source, path.join(outDir, PHOTON_WASM_FILENAME));
    }
  };
}
