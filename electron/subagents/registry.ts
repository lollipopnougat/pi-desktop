/**
 * Agent 定义发现与合并(纯逻辑,可单测)。
 *
 * 发现顺序(builtin < user < project,同名高优先级覆盖):
 * 1. builtin:resources/agents/*.md(随安装包 extraResources 发布)
 * 2. user:~/.pi-desktop/agents/*.md
 * 3. project:<cwd>/.pi-desktop/agents/*.md
 *
 * 格式:Markdown + YAML frontmatter(--- 包围),正文为角色系统提示。
 * 高优先级定义解析失败时返回诊断并阻止静默回退(参考 pi-subagents)。
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition, AgentDefinitionSource } from './types';

/** frontmatter 字段约束 */
const VALID_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface RegistryDiagnostic {
  file: string;
  error: string;
}

export interface RegistryResult {
  agents: AgentDefinition[];
  diagnostics: RegistryDiagnostic[];
}

/** 解析单个 agent 定义文件;解析失败返回 null + 诊断 */
export function parseAgentDefinition(
  content: string,
  source: AgentDefinitionSource,
  filePath: string
): { agent: AgentDefinition | null; error?: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { agent: null, error: '缺少 frontmatter(需以 --- 开头)' };
  }
  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx < 0) {
    return { agent: null, error: 'frontmatter 未闭合(缺少结尾 ---)' };
  }
  const frontmatter = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();
  if (!body) {
    return { agent: null, error: '缺少角色系统提示(正文为空)' };
  }

  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(frontmatter) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { agent: null, error: `YAML 解析失败: ${(e as Error).message}` };
  }

  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    return { agent: null, error: 'name 必须为小写字母开头的小写字母/数字/-/_ 组合' };
  }
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) {
    return { agent: null, error: 'description 不能为空' };
  }

  let model: string | undefined;
  if (meta.model != null) {
    if (typeof meta.model !== 'string' || !meta.model.includes('/')) {
      return { agent: null, error: 'model 必须为 "provider/modelId" 格式' };
    }
    model = meta.model.trim();
  }

  let thinkingLevel: AgentDefinition['thinkingLevel'];
  if (meta.thinkingLevel != null) {
    if (typeof meta.thinkingLevel !== 'string' || !VALID_THINKING.includes(meta.thinkingLevel)) {
      return { agent: null, error: `thinkingLevel 必须为 ${VALID_THINKING.join('/')}` };
    }
    thinkingLevel = meta.thinkingLevel as AgentDefinition['thinkingLevel'];
  }

  let tools: string[] | undefined;
  if (meta.tools != null) {
    if (typeof meta.tools !== 'string') {
      return { agent: null, error: 'tools 必须为逗号分隔字符串' };
    }
    tools = meta.tools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tools.length === 0) {
      return { agent: null, error: 'tools 为空串时应省略该字段' };
    }
  }

  let spawns = '';
  if (meta.spawns != null) {
    if (typeof meta.spawns !== 'string') {
      return { agent: null, error: 'spawns 必须为字符串("" | "*" | 逗号分隔名单)' };
    }
    spawns = meta.spawns.trim();
  }

  return {
    agent: {
      name,
      description,
      source,
      filePath,
      model,
      thinkingLevel,
      tools,
      spawns,
      systemPrompt: body
    }
  };
}

/** 解析失效但曾占位的高优先级名字 → 阻止低优先级回退 */
interface OccludedName {
  name: string;
  source: AgentDefinitionSource;
}

function sourcePriority(s: AgentDefinitionSource): number {
  return s === 'project' ? 3 : s === 'user' ? 2 : 1;
}

/** 从多个来源收集并合并(高优先级覆盖同名;低优先级同名被 occluded 时不回退) */
export function mergeDefinitions(
  layers: Array<{ source: AgentDefinitionSource; agents: AgentDefinition[]; failedNames: string[] }>
): RegistryResult {
  const byName = new Map<string, AgentDefinition>();
  const occluded: OccludedName[] = [];
  const diagnostics: RegistryDiagnostic[] = [];

  // 按优先级从低到高叠加
  const sorted = [...layers].sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  for (const layer of sorted) {
    for (const failed of layer.failedNames) {
      occluded.push({ name: failed, source: layer.source });
    }
    for (const agent of layer.agents) {
      const prev = byName.get(agent.name);
      if (prev && sourcePriority(prev.source) > sourcePriority(agent.source)) continue;
      byName.set(agent.name, agent);
    }
  }

  // 高优先级解析失败的同名定义,阻止低优先级版本被使用
  for (const [name, agent] of byName) {
    const blocker = occluded.find(
      (o) => o.name === name && sourcePriority(o.source) > sourcePriority(agent.source)
    );
    if (blocker) {
      byName.delete(name);
      diagnostics.push({
        file: agent.filePath,
        error: `高优先级(${blocker.source})的 ${name} 定义解析失败,已禁用同名低优先级版本`
      });
    }
  }

  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { agents, diagnostics };
}

/** 扫描单个目录下的 *.md(递归一层子目录,兼容分类文件夹) */
export function scanAgentDir(
  dir: string,
  source: AgentDefinitionSource
): { agents: AgentDefinition[]; failedNames: string[]; diagnostics: RegistryDiagnostic[] } {
  const agents: AgentDefinition[] = [];
  const failedNames: string[] = [];
  const diagnostics: RegistryDiagnostic[] = [];
  if (!fs.existsSync(dir)) return { agents, failedNames, diagnostics };

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    else if (entry.isDirectory()) {
      for (const sub of fs.readdirSync(dir)) {
        const subPath = path.join(full, sub);
        if (sub.endsWith('.md') && fs.statSync(subPath).isFile()) files.push(subPath);
      }
    }
  }

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      diagnostics.push({ file, error: `读取失败: ${(e as Error).message}` });
      continue;
    }
    const { agent, error } = parseAgentDefinition(content, source, file);
    if (agent) {
      agents.push(agent);
    } else {
      // 从文件名猜测失败占位名(stem)
      failedNames.push(path.basename(file, '.md').toLowerCase());
      diagnostics.push({ file, error: error ?? '解析失败' });
    }
  }
  return { agents, failedNames, diagnostics };
}

/**
 * 收集全部 agent 定义。
 * @param builtinDir 内置目录(resources/agents;打包后 process.resourcesPath/agents)
 * @param agentDir 用户目录(~/.pi-desktop/agents)
 * @param cwd 当前项目目录(读 <cwd>/.pi-desktop/agents)
 */
export function discoverAgents(builtinDir: string, agentDir: string, cwd: string): RegistryResult {
  const layers = [
    { source: 'builtin' as const, ...scanAgentDir(builtinDir, 'builtin') },
    { source: 'user' as const, ...scanAgentDir(path.join(agentDir, 'agents'), 'user') },
    {
      source: 'project' as const,
      ...scanAgentDir(path.join(cwd, '.pi-desktop', 'agents'), 'project')
    }
  ];
  const result = mergeDefinitions(layers);
  result.diagnostics.unshift(...layers.flatMap((l) => l.diagnostics));
  return result;
}

/** 解析 spawns 白名单: '*' = 任意;'' = 不可派生;否则为名单 */
export function resolveSpawnList(spawns: string): 'none' | 'any' | string[] {
  if (!spawns) return 'none';
  if (spawns === '*') return 'any';
  return spawns
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
