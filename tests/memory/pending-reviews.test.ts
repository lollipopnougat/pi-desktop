/**
 * MemoryController.getPendingReviewCount：记忆按钮角标用的轻量计数。
 *
 * 只数「本项目 + status=pending」的候选文件，不读索引、不碰水位线，
 * 所以即使索引不可用或记忆被禁用也必须能安全返回。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mem-badge-'));
process.env.PI_MEMORY_DIR = tmpMemory;

const { MemoryController } = await import('../../electron/memory/controller');
const { writeMemoryConfig } = await import('../../electron/memory/config');
const { createCandidate } = await import('../../electron/memory/review');

const PROJECT = '/tmp/badge-project';
const bridgeStub = { cwd: PROJECT, win: null, modelRuntime: null } as never;
const hostStub = {
  current: () => null,
  cwd: () => PROJECT,
  sendSessionEvent: () => true
};

function newController() {
  return new MemoryController(bridgeStub, hostStub);
}

/** 注意：createCandidate 会把 extractionIds 有交集的旧候选标记为 superseded，这里必须给不同的 id */
function seedCandidate(projectId: string, extractionId: string) {
  createCandidate(
    projectId,
    [{ file: 'MEMORY.md', before: '', after: `- 新增一条偏好 ${extractionId}\n` }],
    [extractionId],
    'consolidation'
  );
}

afterAll(() => {
  fs.rmSync(tmpMemory, { recursive: true, force: true });
});

describe('getPendingReviewCount', () => {
  beforeEach(() => {
    writeMemoryConfig({ enabled: true });
    fs.rmSync(path.join(tmpMemory, 'candidates'), { recursive: true, force: true });
  });

  it('没有候选时返回 0', () => {
    expect(newController().getPendingReviewCount()).toBe(0);
  });

  it('只统计本项目的待审核候选', () => {
    const controller = newController();
    const projectId = controller.getProjectId();
    seedCandidate(projectId, 'extraction-a');
    seedCandidate(projectId, 'extraction-b');
    seedCandidate('p-other-project', 'extraction-c');
    expect(controller.getPendingReviewCount()).toBe(2);
  });

  it('记忆系统关闭时返回 0（即使磁盘上还有候选）', () => {
    const controller = newController();
    seedCandidate(controller.getProjectId(), 'extraction-a');
    writeMemoryConfig({ enabled: false });
    expect(controller.getPendingReviewCount()).toBe(0);
  });
});
