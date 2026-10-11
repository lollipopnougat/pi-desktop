import type { TodoPhase, TodoItem } from '../store/pi-store';

export interface TodoProgressSummary {
  currentTask: TodoItem;
  currentStep: number;
  totalSteps: number;
  completedSteps: number;
  progress: number;
}

/** 生成聊天区任务胶囊摘要；已放弃任务不计入有效步骤。 */
export function getTodoProgress(phases: TodoPhase[]): TodoProgressSummary | null {
  const tasks = phases
    .flatMap((phase) => phase.tasks)
    .filter((task) => task.status !== 'abandoned');
  if (tasks.length === 0) return null;

  const currentIndex = tasks.findIndex((task) => task.status === 'in_progress');
  const fallbackIndex = tasks.findIndex((task) => task.status === 'pending');
  const activeIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
  if (activeIndex < 0) return null;

  const completedSteps = tasks.filter((task) => task.status === 'completed').length;
  return {
    currentTask: tasks[activeIndex],
    currentStep: activeIndex + 1,
    totalSteps: tasks.length,
    completedSteps,
    progress: completedSteps / tasks.length
  };
}
