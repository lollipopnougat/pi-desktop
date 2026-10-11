import { describe, expect, it } from 'vitest';
import { getTodoProgress } from '../../src/utils/todo-progress';

describe('getTodoProgress', () => {
  it('flattens phases and reports the active task position', () => {
    const result = getTodoProgress([
      {
        name: '准备',
        tasks: [
          { id: '1', content: '分析需求', status: 'completed' },
          { id: '2', content: '设计方案', status: 'completed' }
        ]
      },
      {
        name: '实现',
        tasks: [
          { id: '3', content: '编写组件', status: 'in_progress' },
          { id: '4', content: '补充测试', status: 'pending' }
        ]
      }
    ]);

    expect(result).toMatchObject({
      currentStep: 3,
      totalSteps: 4,
      completedSteps: 2,
      progress: 0.5
    });
    expect(result?.currentTask.content).toBe('编写组件');
  });

  it('falls back to the first pending task and ignores abandoned steps', () => {
    const result = getTodoProgress([
      {
        name: '实现',
        tasks: [
          { id: '1', content: '旧方案', status: 'abandoned' },
          { id: '2', content: '已完成', status: 'completed' },
          { id: '3', content: '等待处理', status: 'pending' }
        ]
      }
    ]);

    expect(result).toMatchObject({ currentStep: 2, totalSteps: 2, completedSteps: 1 });
    expect(result?.currentTask.content).toBe('等待处理');
  });

  it('returns null after every effective task is completed', () => {
    expect(
      getTodoProgress([
        {
          name: '完成',
          tasks: [
            { id: '1', content: '完成项', status: 'completed' },
            { id: '2', content: '放弃项', status: 'abandoned' }
          ]
        }
      ])
    ).toBeNull();
  });
});
