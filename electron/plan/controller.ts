/**
 * PlanController:plan 模式主进程侧状态机 + 渲染进程推送 + 提案等待桥。
 *
 * 三阶段:idle → planning(只读探索+提案) → executing(实现,恢复全工具)
 * planning 下被驳回 → 留在 planning,模型据反馈修订方案再调 propose_plan
 * 批准 → executing + 工具恢复全量 + 置 needsContinue 旗标
 *         (扩展 agent_end 钩子轮询 ctx.isIdle() 后投递续跑消息,
 *          复刻 plannotator 验证过的 continueWhenIdle 模式)
 *
 * 提案等待复用 ask-tool 的 round-trip:
 *   tool execute → startProposal() 建 pending promise + 通知渲染进程(pi:planProposal)
 *   渲染进程 PlanReviewPanel → pi:planSubmitResponse → resolveProposal() 解 promise
 *
 * 持久化:plan-state custom entry 落到 session 分支,跟随重载/分叉/压缩。
 *
 * 与 goal 的关系:互斥。createGoal 会调 piBridge.setPlanMode(false) → 本控制器 exitToIdle。
 * 进 plan 暂停 active goal(ChatInput 已处理)。
 */
import type { PiBridge } from '../pi-bridge';
import type { SessionHost } from '../session-slot';
import { t } from '../../src/i18n/zh';
import {
  type PlanPhase,
  type PlanStateData,
  PLAN_STATE_ENTRY_TYPE,
  loadPlanStateFromEntries
} from './persistence';

/** 用户审批决策(从渲染进程回灌) */
export interface PlanDecision {
  approved: boolean;
  /** 编译好的反馈串(驳回时带原文锚点 / 批准附注时为全局 notes) */
  feedback?: string;
}

/** 推送给渲染进程的提案(挂起待审批) */
export interface PendingProposal {
  id: string;
  content: string;
  variant: number;
  summary?: string;
  createdAt: number;
}

export interface PlanSnapshot {
  phase: PlanPhase;
  /** 当前挂起待审批的提案(渲染进程据此弹 PlanReviewPanel) */
  pendingProposal: PendingProposal | null;
  /** 最近一次已批准的方案内容(executing 阶段供 UI 参考) */
  lastApprovedPlan: string | null;
}

/** planning 阶段允许的只读工具白名单 */
const PLAN_PLANNING_TOOLS = ['read', 'grep', 'find', 'ls', 'ask', 'propose_plan'];

/** 仅在 plan 模式可见的工具,标准模式需从激活集移除 */
const PLAN_ONLY_TOOL = 'propose_plan';

export class PlanController {
  private piBridge: PiBridge;
  /** 所服务的会话（Stage 0 = 焦点槽；多会话阶段按槽注入） */
  private host: SessionHost;
  private phase: PlanPhase = 'idle';
  /** 进入 planning 前保存的活跃工具列表,退出时恢复 */
  private previousToolNames: string[] | null = null;

  /** 当前挂起的提案 + 其 resolver(propose_plan 工具在 await 这个 promise) */
  private pending: { proposal: PendingProposal; resolve: (d: PlanDecision) => void } | null = null;
  /** 已批准的方案内容(executing 阶段保留,供 UI / 续跑提示) */
  private lastApprovedPlan: string | null = null;
  /** 提案版本号(每次 startProposal 递增,供 Plan Diff 用) */
  private variantCounter = 0;
  /** 续跑旗标:批准后置 true,扩展 agent_end 钩子消费后清零 */
  private needsContinueFlag = false;

  constructor(piBridge: PiBridge, host: SessionHost) {
    this.piBridge = piBridge;
    this.host = host;
  }

  get currentPhase(): PlanPhase {
    return this.phase;
  }

  get isPlanning(): boolean {
    return this.phase === 'planning';
  }

  get isExecuting(): boolean {
    return this.phase === 'executing';
  }

  // ─── 阶段切换 ───

  /** 进入 planning:裁剪工具集为只读白名单。由 setPlanMode(true) 调。 */
  enterPlanning(): void {
    // 已在 planning:幂等
    if (this.phase === 'planning') return;
    // 处于 executing(会话恢复/续跑中):不回退,避免把已批准的实现阶段打回规划
    if (this.phase === 'executing') return;
    // 若有 pending 提案,先取消(切走即放弃当前审批)
    this.cancelPending({ approved: false, feedback: '已退出规划模式' });
    try {
      const session = this.host.current();
      if (!session) return;
      // 仅首次进入保存,避免保存被裁剪后的白名单;排除 propose_plan 本身
      // 防止退出时把它又带回标准模式激活集(它是 plan 专用)
      if (this.previousToolNames === null) {
        this.previousToolNames = (session.getActiveToolNames() as string[]).filter(
          (n) => n !== PLAN_ONLY_TOOL
        );
      }
      session.setActiveToolsByName(PLAN_PLANNING_TOOLS);
    } catch {}
    this.phase = 'planning';
    this.lastApprovedPlan = null;
    this.variantCounter = 0;
    this.persistAndEmit();
  }

  /** 退回 idle:恢复工具,丢弃 pending。由 setPlanMode(false) / 批准方案后调。 */
  exitToIdle(): void {
    if (this.phase === 'idle') return;
    this.cancelPending({ approved: false, feedback: '已退出规划模式' });
    try {
      const session = this.host.current();
      if (session) {
        const restore = this.previousToolNames ?? session.getAllTools().map((t: any) => t.name);
        session.setActiveToolsByName(restore);
      }
    } catch {}
    this.previousToolNames = null;
    this.phase = 'idle';
    this.lastApprovedPlan = null;
    this.variantCounter = 0;
    this.needsContinueFlag = false;
    this.persistAndEmit();
  }

  // ─── 提案 round-trip(propose_plan 工具用) ───

  /**
   * 工具 execute 调:登记 pending proposal,通知渲染进程弹 PlanReviewPanel,
   * 返回一个永不自动 resolve 的 Promise(把 agent 循环钉在等待用户决策)。
   */
  startProposal(content: string, summary?: string): Promise<PlanDecision> {
    this.variantCounter += 1;
    const proposal: PendingProposal = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      variant: this.variantCounter,
      summary,
      createdAt: Date.now()
    };
    return new Promise<PlanDecision>((resolve) => {
      this.pending = { proposal, resolve };
      this.emit();
      // 通知渲染进程展示评审面板
      if (!this.host.sendSessionEvent('pi:planProposal', proposal)) {
        this.cancelPending({ approved: false, feedback: t.sessionSwitchCancelled });
      }
    });
  }

  /** 渲染进程审批后调(pi:planSubmitResponse handler)。 */
  resolveProposal(id: string, decision: PlanDecision): void {
    if (!this.pending) return;
    if (this.pending.proposal.id !== id) return;
    const proposalContent = this.pending.proposal.content;
    const resolve = this.pending.resolve;
    this.pending = null;
    if (decision.approved) {
      this.lastApprovedPlan = proposalContent;
    }
    resolve(decision);
    // 批准 → 退出 plan 模式回标准模式实现(不进 executing 阶段) + 续跑旗标。
    // execiting 阶段注入提示不再使用,模型以标准 agent 行为按方案实现。
    if (decision.approved) {
      // 恢复全工具 + 清会话持久为 idle + 发 pi:planUpdate 让渲染端切回 standard
      this.exitToIdle();
      this.needsContinueFlag = true;
    } else {
      // 驳回:留在 planning,模型据 feedback 修订再提交。仅 emit 更新 pending=null
      this.emit();
    }
  }

  /** 取消当前 pending 提案(切会话/退出 plan 时用) */
  cancelPending(decision: PlanDecision): void {
    if (this.pending) {
      const resolve = this.pending.resolve;
      this.pending = null;
      try {
        resolve(decision);
      } catch {}
      this.emit();
    }
  }

  /** 扩展 agent_end 钩子消费:返回是否需要续跑(批准后),消费后清零 */
  consumeContinue(): boolean {
    const v = this.needsContinueFlag;
    this.needsContinueFlag = false;
    return v;
  }

  // ─── 持久化与恢复 ───

  private persistAndEmit(): void {
    this.persist();
    this.emit();
  }

  private persist(): void {
    try {
      const session = this.host.current();
      const sm = session?.sessionManager;
      if (!sm || typeof sm.appendCustomEntry !== 'function') return;
      const data: PlanStateData = { phase: this.phase };
      sm.appendCustomEntry(PLAN_STATE_ENTRY_TYPE, data);
    } catch {}
  }

  private emit(): void {
    this.host.sendSessionEvent('pi:planUpdate', this.getSnapshot());
  }

  getSnapshot(): PlanSnapshot {
    return {
      phase: this.phase,
      pendingProposal: this.pending?.proposal ?? null,
      lastApprovedPlan: this.lastApprovedPlan
    };
  }

  /** 会话切换时恢复 phase(由 session_start 钩子 + pi-bridge.syncSession 调) */
  onSessionSwitch(): void {
    this.cancelPending({ approved: false, feedback: '已切换会话' });
    this.lastApprovedPlan = null;
    this.variantCounter = 0;
    this.needsContinueFlag = false;
    this.previousToolNames = null;
    let restored: PlanPhase = 'idle';
    try {
      const sm = this.host.current()?.sessionManager;
      const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
      restored = loadPlanStateFromEntries(entries);
    } catch {}
    this.phase = restored;
    // 恢复 phase 对应的工具集
    // planning → 激活白名单(含 propose_plan)
    // executing/idle → 确保从激活集移除 propose_plan(避免污染标准模式 systemPrompt + 会话属性工具列表)
    //   propose_plan 经 pi.registerTool 注册后默认会进激活集;这里显式过滤,
    //   setActiveToolsByName 会重建 _baseSystemPrompt,propose_plan 文档退出 systemPrompt
    try {
      const session = this.host.current();
      if (session) {
        if (restored === 'planning') {
          // 排除 propose_plan 以免退出时又带回 standard
          this.previousToolNames = (session.getActiveToolNames() as string[]).filter(
            (n) => n !== PLAN_ONLY_TOOL
          );
          session.setActiveToolsByName(PLAN_PLANNING_TOOLS);
        } else {
          const active = session.getActiveToolNames() as string[];
          if (active.includes(PLAN_ONLY_TOOL)) {
            session.setActiveToolsByName(active.filter((n) => n !== PLAN_ONLY_TOOL));
          }
        }
      }
    } catch {}
    this.emit();
  }
}
