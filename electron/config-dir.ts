/**
 * pi-desktop 独立配置目录
 *
 * 所有桌面端配置与数据都在这里，与 pi CLI 的 ~/.pi/agent 完全隔离。
 * 通过设置 PI_CODING_AGENT_DIR 环境变量将 SDK 内部所有默认路径
 * （getAgentDir / getSessionsDir / getSettingsPath 等）重定向到 ~/.pi-desktop。
 * 该变量只在当前 Electron 进程生效，不影响 pi CLI。
 *
 *   ~/.pi-desktop/
 *   ├── ui-config.json      # UI 偏好（字体大小/面板宽度/模式等，渲染进程经 IPC 读写）
 *   ├── settings.json     # SDK 配置（上下文压缩 compaction 等）
 *   ├── models.json       # 自定义 provider 配置
 *   ├── auth.json         # 内置供应商 API Key（权限 0600）
 *   ├── mcp.json          # MCP 服务器配置
 *   ├── git-ai.json       # git-ai 改动溯源配置（启用/路径/上报范围）
 *   ├── web-search.json   # 内置网络搜索配置（开关/搜索源/条数/SearXNG 地址）
 *   ├── hooks.json        # 生命周期钩子（PreToolUse/PostToolUse/SessionStart/Stop）
 *   ├── models-store.json # SDK 模型清单缓存
 *   ├── trust.json        # 项目信任状态
 *   ├── sessions/         # 会话 JSONL（按 cwd 编码子目录）
 *   ├── skills/           # 技能
 *   ├── prompts/          # prompt 模板
 *   └── themes/           # 主题
 */
import os from 'os';
import path from 'path';

/** pi-desktop 专属配置目录 */
export const DESKTOP_AGENT_DIR = path.join(os.homedir(), '.pi-desktop');

/**
 * 重定向 SDK 内部所有默认路径到 ~/.pi-desktop。
 * 必须在任何 SDK 模块被 require 之前设置，因此本模块必须在 main.ts 中最先导入。
 * 这使得 SessionManager.listAll() 等不显式传参的 SDK 调用也能正确定位目录。
 * 同时项目代码对关键 SDK 调用仍显式传参（双保险）。
 */
process.env.PI_CODING_AGENT_DIR = DESKTOP_AGENT_DIR;
