import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
// os is used via require() inside vi.hoisted, not as an import

// Use vi.hoisted to create temp dir before vi.mock calls are hoisted
// Cannot use `path`/`os` inside vi.hoisted (they're hoisted imports), so use require
const { tmpDir, mcpConfigPath } = vi.hoisted(() => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const dir = join(
    tmpdir(),
    `pi-desktop-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  return { tmpDir: dir, mcpConfigPath: join(dir, 'mcp.json') };
});

// Mock dependencies — must be at top level, vi.hoisted ensures tmpDir exists
// Mock config-dir so provider-config uses temp dir
vi.mock('../../electron/config-dir', () => ({
  DESKTOP_AGENT_DIR: tmpDir
}));

// Mock provider-config: mcp/config.ts imports getAgentDir from it at module load
vi.mock('../../electron/provider-config', () => ({
  getAgentDir: () => tmpDir
}));

import {
  loadMcpConfig,
  saveMcpConfig,
  upsertMcpServer,
  deleteMcpServer,
  getMcpConfigPath,
  getProjectMcpConfigPath,
  type McpConfig
} from '../../electron/mcp/config';

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('MCP config — loadMcpConfig', () => {
  it('returns empty config when no file exists', () => {
    const config = loadMcpConfig();
    expect(config.mcpServers).toEqual({});
  });

  it('returns empty config when file is corrupted', () => {
    fs.writeFileSync(mcpConfigPath, 'not valid json', 'utf-8');
    const config = loadMcpConfig();
    expect(config.mcpServers).toEqual({});
  });

  it('returns empty config when mcpServers is missing', () => {
    fs.writeFileSync(mcpConfigPath, JSON.stringify({}), 'utf-8');
    const config = loadMcpConfig();
    expect(config.mcpServers).toEqual({});
  });

  it('loads global config correctly', () => {
    const config: McpConfig = {
      mcpServers: {
        'global-server': {
          command: 'npx',
          args: ['-y', '@some/server']
        }
      }
    };
    saveMcpConfig(config);
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers['global-server']).toBeDefined();
    expect(loaded.mcpServers['global-server'].command).toBe('npx');
  });

  it('filters the reserved pi-browser service name from persisted config', () => {
    saveMcpConfig({
      mcpServers: {
        'pi-browser': { command: 'node', args: ['fake-browser.js'] },
        allowed: { command: 'node', args: ['allowed.js'] }
      }
    });
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers['pi-browser']).toBeUndefined();
    expect(loaded.mcpServers.allowed).toBeDefined();
  });
});

describe('MCP config — project-level override', () => {
  it('project-level config overrides global with same server name', () => {
    saveMcpConfig({
      mcpServers: {
        'shared-server': {
          command: 'npx',
          args: ['-y', '@global/server']
        },
        'global-only': {
          command: 'node',
          args: ['server.js']
        }
      }
    });

    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'shared-server': {
            command: 'npx',
            args: ['-y', '@project/server']
          },
          'project-only': {
            url: 'https://example.com/mcp'
          }
        }
      }),
      'utf-8'
    );

    const loaded = loadMcpConfig(projectDir);
    expect(loaded.mcpServers['shared-server'].args).toEqual(['-y', '@project/server']);
    expect(loaded.mcpServers['global-only']).toBeDefined();
    expect(loaded.mcpServers['project-only']).toBeDefined();
    expect(loaded.mcpServers['project-only'].url).toBe('https://example.com/mcp');
  });

  it('returns global config when project has no .mcp.json', () => {
    saveMcpConfig({
      mcpServers: {
        'global-server': { command: 'npx', args: ['-y', '@global/server'] }
      }
    });
    const projectDir = path.join(tmpDir, 'empty-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const loaded = loadMcpConfig(projectDir);
    expect(loaded.mcpServers['global-server']).toBeDefined();
    expect(Object.keys(loaded.mcpServers)).toHaveLength(1);
  });

  it('returns global config when project .mcp.json is empty', () => {
    saveMcpConfig({
      mcpServers: {
        'global-server': { command: 'npx', args: ['-y', '@global/server'] }
      }
    });
    const projectDir = path.join(tmpDir, 'empty-mcp-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: {} }),
      'utf-8'
    );

    const loaded = loadMcpConfig(projectDir);
    expect(loaded.mcpServers['global-server']).toBeDefined();
  });
});

describe('MCP config — upsert / delete', () => {
  it('upsertMcpServer adds a new server', () => {
    upsertMcpServer('new-server', {
      command: 'npx',
      args: ['-y', '@new/server']
    });
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers['new-server']).toBeDefined();
    expect(loaded.mcpServers['new-server'].command).toBe('npx');
  });

  it('upsertMcpServer updates an existing server', () => {
    upsertMcpServer('server', { command: 'node', args: ['v1.js'] });
    upsertMcpServer('server', { command: 'node', args: ['v2.js'] });
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers['server'].args).toEqual(['v2.js']);
  });

  it('deleteMcpServer removes a server', () => {
    upsertMcpServer('to-delete', { command: 'node', args: ['server.js'] });
    deleteMcpServer('to-delete');
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers['to-delete']).toBeUndefined();
  });

  it('deleteMcpServer is a no-op for non-existent server', () => {
    deleteMcpServer('nonexistent');
    const loaded = loadMcpConfig();
    expect(loaded.mcpServers).toEqual({});
  });
});

describe('MCP config — path helpers', () => {
  it('getMcpConfigPath returns the global config path', () => {
    expect(getMcpConfigPath()).toBe(mcpConfigPath);
  });

  it('getProjectMcpConfigPath returns <cwd>/.mcp.json', () => {
    expect(getProjectMcpConfigPath('/some/project')).toBe(path.join('/some/project', '.mcp.json'));
  });
});
