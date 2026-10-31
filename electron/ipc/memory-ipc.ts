/**
 * Memory IPC handler：配置读写 / 文件读写 / 触发提取合并 / 状态查询。
 *
 * 三处同步之一：本文件注册 handler，preload.ts 暴露，pi.d.ts 声明类型。
 * 渲染进程经 window.pi.memory.* 调用；进度经 pi:memoryProgress 事件推送。
 */
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type { PiBridge } from '../pi-bridge';
import { getMemoryDir, memoryFilePath, type MemoryFileId } from '../memory/config';
import { readMemorySnapshot, writeMemoryFile, readMemoryEntry } from '../memory/store';
import { revisionOf } from '../memory/persistence';
import { reviewCandidate, proposeRollback, proposeLegacyMigration } from '../memory/review';
import type { MemoryController } from '../memory/controller';

/** UI 可编辑的记忆文件白名单（project 经 projectName 参数访问） */
const EDITABLE_FILES = new Set(['USER.md', 'MEMORY.md', 'LESSONS.md', 'STANDING.md']);

export function registerMemoryIpc(piBridge: PiBridge) {
  const controller = piBridge.memoryController!;

  // === 配置 ===
  ipcMain.handle('pi:memory:getConfig', async () => {
    return controller.getConfig();
  });

  ipcMain.handle('pi:memory:setConfig', async (_e, patch: Record<string, unknown>) => {
    // 只放行已知字段（enabled / extractModel / consolidateThreshold / userProfileCharLimit）
    const allowed: Record<string, unknown> = {};
    if (typeof patch?.enabled === 'boolean') allowed.enabled = patch.enabled;
    if (['automatic', 'review', 'explicit'].includes(String(patch?.writePolicy)))
      allowed.writePolicy = patch.writePolicy;
    if (patch?.extractModel === null) allowed.extractModel = null;
    else {
      const em = patch?.extractModel as { provider?: unknown; modelId?: unknown } | undefined;
      if (
        em &&
        typeof em === 'object' &&
        typeof em.provider === 'string' &&
        typeof em.modelId === 'string'
      ) {
        allowed.extractModel = { provider: em.provider, modelId: em.modelId };
      }
    }
    if (typeof patch?.consolidateThreshold === 'number' && patch.consolidateThreshold > 0) {
      allowed.consolidateThreshold = Math.floor(patch.consolidateThreshold);
    }
    if (typeof patch?.userProfileCharLimit === 'number' && patch.userProfileCharLimit >= 0) {
      allowed.userProfileCharLimit = Math.floor(patch.userProfileCharLimit);
    }
    const next = controller.setConfig(allowed);
    // 开关切换后刷新快照（下次会话生效；enabled 关闭时快照立即清空）
    if (typeof allowed.enabled === 'boolean') {
      if (!next.enabled) controller.clearSnapshot();
      else controller.freezeSnapshot();
    }
    return next;
  });

  // === 记忆文件读写（MemoryTab 编辑器） ===
  ipcMain.handle('pi:memory:readFile', async (_e, fileId: string, projectName?: string) => {
    if (!EDITABLE_FILES.has(fileId) && fileId !== 'project') {
      throw new Error(`不可读的记忆文件: ${fileId}`);
    }
    return {
      ...readMemorySnapshot(fileId as MemoryFileId, projectIdOf(fileId, projectName, controller)),
      projectId: controller.getProjectId()
    };
  });

  ipcMain.handle(
    'pi:memory:writeFile',
    async (
      _e,
      fileId: string,
      content: string,
      projectName: string | undefined,
      baseRevision: string
    ) => {
      if (!EDITABLE_FILES.has(fileId) && fileId !== 'project') {
        throw new Error(`不可写的记忆文件: ${fileId}`);
      }
      if (typeof content !== 'string') throw new Error('content must be string');
      if (typeof baseRevision !== 'string') throw new Error('请先读取记忆文件再保存');
      const final = writeMemoryFile(fileId as MemoryFileId, content, {
        baseRevision,
        source: 'manual',
        projectName: projectIdOf(fileId, projectName, controller)
      });
      return { ok: true, content: final, revision: revisionOf(final) };
    }
  );

  // === 记忆目录定位（"在文件夹中显示"用） ===
  ipcMain.handle('pi:memory:getDir', async () => {
    return getMemoryDir();
  });

  ipcMain.handle('pi:memory:getFilePath', async (_e, fileId: string, projectName?: string) => {
    if (!EDITABLE_FILES.has(fileId) && fileId !== 'project') {
      throw new Error(`未知的记忆文件: ${fileId}`);
    }
    return memoryFilePath(fileId as MemoryFileId, projectIdOf(fileId, projectName, controller));
  });

  // === 管道触发 ===
  ipcMain.handle('pi:memory:extract', async () => {
    return controller.triggerExtraction();
  });

  ipcMain.handle('pi:memory:consolidate', async () => {
    return controller.triggerConsolidation();
  });

  ipcMain.handle('pi:memory:cancel', () => controller.cancel());
  ipcMain.handle(
    'pi:memory:review',
    (_e, id: string, projectId: string, accept: boolean, edits?: Record<string, string>) => {
      if (!controller.isEnabled()) throw new Error('记忆系统已禁用');
      if (projectId !== controller.getProjectId()) throw new Error('项目已切换，请刷新记忆面板');
      if (
        typeof accept !== 'boolean' ||
        (edits && Object.values(edits).some((v) => typeof v !== 'string'))
      )
        throw new Error('无效的审核参数');
      reviewCandidate(id, projectId, accept, edits);
    }
  );
  ipcMain.handle('pi:memory:rollback', (_e, id: string, projectId: string) => {
    if (!controller.isEnabled() || projectId !== controller.getProjectId())
      throw new Error('记忆已关闭或项目已切换');
    return proposeRollback(id, projectId);
  });
  ipcMain.handle('pi:memory:migrateLegacy', (_e, name: string, projectId: string) => {
    if (!controller.isEnabled() || projectId !== controller.getProjectId())
      throw new Error('记忆已关闭或项目已切换');
    return proposeLegacyMigration(name, controller.getProject());
  });
  ipcMain.handle('pi:memory:readEntry', (_e, id: string) => {
    if (typeof id !== 'string') throw new Error('无效记忆条目');
    return readMemoryEntry(id, controller.getProjectId());
  });

  // === 状态 ===
  ipcMain.handle('pi:memory:getStatus', async () => {
    return controller.getStatus();
  });

  ipcMain.handle('pi:memory:search', async (_e, query: string) => {
    if (typeof query !== 'string') return [];
    return controller.search(query);
  });

  // 待审核候选数（记忆按钮角标；只数文件，不读索引）
  ipcMain.handle('pi:memory:pendingReviews', async () => {
    return controller.getPendingReviewCount();
  });

  // === 检索引擎状态（FTS5 索引） ===
  ipcMain.handle('pi:memory:indexStatus', async () => {
    return controller.getIndexStats();
  });

  ipcMain.handle('pi:memory:reindex', async () => {
    if (!controller.isEnabled()) throw new Error('记忆系统已禁用');
    return controller.rebuildIndexes();
  });

  // === extraction 原文查看（审计用） ===
  ipcMain.handle('pi:memory:readExtraction', async (_e, fileName: string) => {
    // 防路径穿越：只允许 extractions 目录下的纯文件名
    const safe = path.basename(fileName);
    if (!safe.endsWith('.md') || safe !== fileName) {
      throw new Error('invalid extraction file name');
    }
    const full = path.join(getMemoryDir(), 'extractions', safe);
    if (!fs.existsSync(full)) throw new Error(`extraction not found: ${safe}`);
    return fs.readFileSync(full, 'utf-8');
  });
}

function projectIdOf(
  fileId: string,
  projectName: string | undefined,
  controller: MemoryController
): string | undefined {
  if (fileId !== 'project') return undefined;
  if (projectName && projectName !== controller.getProjectId())
    throw new Error('项目已切换，请重新读取记忆');
  return controller.getProjectId();
}
