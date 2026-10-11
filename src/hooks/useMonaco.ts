import { useEffect } from 'react';
import { loader } from '@monaco-editor/react';

/**
 * Configure Monaco Editor environment for Electron.
 * Must be called before any Monaco editor is mounted.
 *
 * 离线方案：不走 CDN，从本地打包的 monaco-editor/min/vs 加载。
 * - @monaco-editor/loader 默认从 cdn.jsdelivr.net 加载，这里通过 loader.config
 *   把 paths.vs 指向本地 min/vs 目录（基于 import.meta.url 构造绝对 file:// URL，
 *   避免 renderer 相对路径解析到错误的目录）。
 * - worker：min/vs/base/worker/workerMain.js 是 monaco 内置的通用 worker，
 *   由 MonacoEnvironment.getWorkerUrl 返回，避免引用 esm 下的 worker 文件
 *   （esm 目录已在打包时排除，可省 ~22MB）。
 */
export function useMonacoSetup() {
  useEffect(() => {
    // import.meta.url 在生产环境形如
    //   file:///.../app.asar/dist/assets/index-xxxx.js
    // monaco-editor 在 asar 根的 node_modules 下，从 dist/assets/ 上两级即到 asar 根
    // 用变量拼接路径，避免 Vite 静态分析把 workerMain.js 当资产打包
    const base = import.meta.url;
    const vsPath = new URL('../../node_modules/monaco-editor/min/vs', base).href;
    const workerPath = new URL(
      '../../node_modules/monaco-editor/min/vs/base/worker/workerMain.js',
      base
    ).href;

    // 配置 @monaco-editor/loader 从本地加载，不走 CDN
    loader.config({
      paths: {
        vs: vsPath
      }
    });

    (window as any).MonacoEnvironment = {
      getWorkerUrl(_workerId: string, _label: string) {
        // 使用 monaco 内置的通用 worker
        return workerPath;
      }
    };
  }, []);
}

/**
 * Language detection from file extension
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    dockerfile: 'dockerfile',
    toml: 'ini',
    ini: 'ini'
  };
  return map[ext || ''] || 'plaintext';
}
