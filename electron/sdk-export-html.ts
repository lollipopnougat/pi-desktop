/**
 * SDK 的 HTML 导出 API 包装层。
 *
 * SDK 的 package.json `exports` 只开放 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，
 * 而 `exportSessionToHtml` / `exportFromFile` 没有从包根导出 → 裸包深路径 import 会被 exports
 * 地图拒绝（Vite/rollup 构建期即报错）。这里通过 vite alias（`@pi-export-html`，见 vite.config.ts）
 * 指到 dist 里的真实文件，让它随主进程一起 bundle 进 dist-electron：
 * ① 打包后不依赖运行时动态 import（asar 内文件的 ESM 互操作有风险）；
 * ② 该模块的传递依赖（session-manager、theme 等）也一并进 bundle。
 *
 * 注意：导出用的 HTML 模板是**运行时读盘**的（`getExportTemplateDir()` →
 * `dist/core/export-html/template.{html,css,js}` + `vendor/*.min.js`），所以
 * `asarUnpack` 必须继续覆盖 `dist/core/export-html/**`（见 AGENTS.md）。
 *
 * SDK 升级后若该路径变化，构建期会直接报错（比运行时才发现好）。
 */
export { exportFromFile, exportSessionToHtml } from '@pi-export-html';
export type { ExportOptions, ToolHtmlRenderer } from '@pi-export-html';
