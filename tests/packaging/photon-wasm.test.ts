/**
 * 主进程构建期的 Photon WASM 拷贝插件（scripts/photon-wasm.ts）的单元测试。
 *
 * 背景：SDK 的图片缩放（resizeImageInProcess）依赖 Photon，而 Photon 的 CJS 入口按
 * `__dirname` 读 photon_rs_bg.wasm。Vite 把 SDK 打包进 dist-electron 后不 emit 这个 wasm，
 * 于是 loadPhoton() 返回 null，SDK 把聊天里上传的**每一张**图片都替换成
 * "[Image omitted: could not be resized below the inline image size limit.]"。
 *
 * 这里守两件事：① 依赖树里能解析到 wasm（嵌套安装 / 顶层安装都要行）；② 构建钩子确实把
 * 文件拷进产物目录，且缺依赖时不抛错（只告警）。
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
  PHOTON_WASM_FILENAME,
  photonWasmPlugin,
  resolvePhotonWasm
} from '../../scripts/photon-wasm';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function makeTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pi-photon-wasm-'));
}

/** 造一个假依赖树：nested 时放在 SDK 自己的 node_modules 里（npm 实际安装形态） */
function installFakePhoton(projectRoot: string, layout: 'top' | 'nested' | 'sibling'): string {
  const dir =
    layout === 'top'
      ? path.join(projectRoot, 'node_modules/@silvia-odwyer/photon-node')
      : layout === 'nested'
        ? path.join(
            projectRoot,
            'node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node'
          )
        : path.join(
            projectRoot,
            'node_modules/@earendil-works/pi-agent-core/node_modules/@silvia-odwyer/photon-node'
          );
  mkdirSync(dir, { recursive: true });
  const wasm = path.join(dir, PHOTON_WASM_FILENAME);
  writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  return wasm;
}

function runWriteBundle(plugin: Plugin, outDir: string): string[] {
  const warn = vi.fn();
  const hook = plugin.writeBundle as unknown as
    | ((this: unknown, options: { dir: string }) => void)
    | { handler: (this: unknown, options: { dir: string }) => void };
  const fn = typeof hook === 'function' ? hook : hook.handler;
  fn.call({ warn }, { dir: outDir });
  return warn.mock.calls.map((call) => String(call[0]));
}

describe('resolvePhotonWasm', () => {
  it('在本仓库已安装的依赖树里能找到 wasm', () => {
    const resolved = resolvePhotonWasm(repoRoot);
    expect(resolved).not.toBeNull();
    expect(existsSync(resolved as string)).toBe(true);
    expect(path.basename(resolved as string)).toBe(PHOTON_WASM_FILENAME);
  });

  it.each(['top', 'nested', 'sibling'] as const)('支持 %s 安装形态', (layout) => {
    const root = makeTempProject();
    try {
      const wasm = installFakePhoton(root, layout);
      expect(resolvePhotonWasm(root)).toBe(wasm);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('依赖缺失时返回 null（不抛错）', () => {
    const root = makeTempProject();
    try {
      mkdirSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent'), {
        recursive: true
      });
      expect(resolvePhotonWasm(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('photonWasmPlugin', () => {
  it('把 wasm 拷到产物目录（dist-electron 旁）', () => {
    const root = makeTempProject();
    try {
      const wasm = installFakePhoton(root, 'nested');
      const outDir = path.join(root, 'dist-electron');
      const warnings = runWriteBundle(photonWasmPlugin(root), outDir);

      const copied = path.join(outDir, PHOTON_WASM_FILENAME);
      expect(warnings).toEqual([]);
      expect(existsSync(copied)).toBe(true);
      expect(readFileSync(copied).equals(readFileSync(wasm))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('产物目录不存在时自动创建', () => {
    const root = makeTempProject();
    try {
      installFakePhoton(root, 'top');
      const outDir = path.join(root, 'nested/out/dir');
      runWriteBundle(photonWasmPlugin(root), outDir);
      expect(existsSync(path.join(outDir, PHOTON_WASM_FILENAME))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('找不到依赖时只告警，不阻断构建', () => {
    const root = makeTempProject();
    try {
      const outDir = path.join(root, 'dist-electron');
      const warnings = runWriteBundle(photonWasmPlugin(root), outDir);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(PHOTON_WASM_FILENAME);
      expect(existsSync(path.join(outDir, PHOTON_WASM_FILENAME))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
