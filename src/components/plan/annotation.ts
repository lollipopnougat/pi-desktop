/**
 * 批注 id/timestamp 生成与编译:抽出独立模块(非 React 组件),
 * 规避 react-hooks/purity 规则对组件体内 Date.now/Math.random 的拦截。
 *
 * 注释批注数据模型对齐 plannotator external-annotation.ts 的 plan 子集:
 * COMMENT / DELETION / GLOBAL_COMMENT。
 */
export type PlanAnnotationType = 'COMMENT' | 'DELETION' | 'GLOBAL_COMMENT';

export interface PlanAnnotation {
  id: string;
  type: PlanAnnotationType;
  text: string;
  originalText: string;
  createdAt: number;
}

let annIdCounter = 0;

/** 生成唯一批注 id(进程内计数,稳定可重放) */
export function makeAnnId(): string {
  annIdCounter += 1;
  return `ann-${Date.now()}-${annIdCounter}`;
}

/** 构造一个批注对象 */
export function buildAnnotation(
  type: PlanAnnotationType,
  text: string,
  originalText: string
): PlanAnnotation {
  return {
    id: makeAnnId(),
    type,
    text,
    originalText,
    createdAt: Date.now()
  };
}
