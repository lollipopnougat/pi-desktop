import { transitionSession, captureSessionGuard } from '../../hooks/loadSession';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import { confirmStopRunning } from '../../lib/stopRunningConfirm';
import Icon from '../common/Icon';
import type { IconName } from '../common/icons';
import { t } from '../../i18n/zh';
import type { TreeNode } from '../../types/shared';

interface TreeViewProps {
  onClose: () => void;
}

interface SkeletonNode {
  id: string;
  parentId: string | null;
  type: string;
  label?: string;
  tag: string;
  text: string;
}

interface FlatTreeResult {
  nodes: SkeletonNode[];
  rootId: string | null;
  leafId: string | null;
}

function getNodeMeta(node: SkeletonNode): { icon: IconName; color: string; tag: string } {
  const tag = node.tag;
  switch (tag) {
    case 'user':
      return { icon: 'user', color: 'text-od-accent', tag: 'user' };
    case 'assistant':
      return { icon: 'robot', color: 'text-od-text-bright', tag: 'assistant' };
    case 'toolResult':
      return { icon: 'reply', color: 'text-od-text-dim', tag: 'result' };
    case 'bash':
      return { icon: 'terminal', color: 'text-od-text-dim', tag: 'bash' };
    case 'branch':
      return { icon: 'branch', color: 'text-od-yellow', tag: 'branch' };
    case 'plan':
      return { icon: 'clipboardList', color: 'text-od-purple', tag: 'plan' };
    case 'goal':
      return { icon: 'target', color: 'text-od-orange', tag: 'goal' };
    case 'subagent':
      return { icon: 'agents', color: 'text-od-accent', tag: 'subagent' };
    case 'compaction':
      return { icon: 'compress', color: 'text-od-yellow', tag: 'compaction' };
    case 'model':
      return { icon: 'rotate', color: 'text-od-text-dim', tag: 'model' };
    case 'thinking':
      return { icon: 'brain', color: 'text-od-yellow', tag: 'thinking' };
    case 'system':
      // SDK 0.86：system prompt/工具变更声明消息
      return { icon: 'info', color: 'text-od-text-dim', tag: 'system' };
    case 'custom':
      return { icon: 'cube', color: 'text-od-purple', tag: 'custom' };
    default:
      return { icon: 'tool', color: 'text-od-text-dim', tag: tag || 'node' };
  }
}

export default function TreeView(props: TreeViewProps) {
  const sessionLoadVersion = usePiStore((s) => s.sessionLoadVersion);
  return <SessionTreeView key={sessionLoadVersion} {...props} />;
}

function SessionTreeView({ onClose }: TreeViewProps) {
  const isMac = window.pi?.platform === 'darwin';
  const sessionVersion = usePiStore((s) => s.sessionVersion);
  const isSessionLoading = usePiStore((s) => s.isSessionLoading);
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  // 确认弹窗：非 null 表示待跳转的目标节点 id
  const [confirmTargetId, setConfirmTargetId] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  const loadTree = useCallback(async (current: () => boolean) => {
    try {
      const result: FlatTreeResult | null = await window.pi.getTree();
      if (!result || !current()) return;
      // 从扁平 nodes 重建树（双指针：id→node map + 按 parentId 连接）
      // 用 visited 防止同 id 被重复挂载（SDK 可能返回孤儿节点同时作为 root + child）
      const nodeMap = new Map<string, TreeNode>();
      const parentMap = new Map<string, string | null>();
      for (const n of result.nodes) {
        nodeMap.set(n.id, { entry: n as any, label: n.label, children: [] });
        parentMap.set(n.id, n.parentId);
      }
      const roots: TreeNode[] = [];
      const attached = new Set<string>();
      for (const n of result.nodes) {
        // 重复 id 说明该节点已被挂过一次，跳过
        if (attached.has(n.id)) continue;
        const node = nodeMap.get(n.id)!;
        if (n.parentId) {
          const parent = nodeMap.get(n.parentId);
          if (parent) {
            parent.children!.push(node);
            attached.add(n.id);
          } else {
            roots.push(node);
            attached.add(n.id);
          }
        } else {
          roots.push(node);
          attached.add(n.id);
        }
      }
      setTree(roots);
      setLeafId(result.leafId);

      // 只展开 leaf → root 路径上的节点，避免长会话一次性渲染几千个 DOM 导致 renderer OOM
      const expand: Record<string, boolean> = {};
      let cur: string | null = result.leafId;
      while (cur) {
        expand[cur] = true;
        cur = parentMap.get(cur) ?? null;
      }
      setExpandedNodes(expand);

      // 滚动到 leaf 节点（下一帧等 DOM 渲染完）
      if (result.leafId) {
        requestAnimationFrame(() => {
          if (!current()) return;
          document
            .querySelector(`[data-node-id="${result.leafId}"]`)
            ?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        });
      }
    } catch (e) {
      console.error('Failed to load tree', e);
    }
  }, []);

  useEffect(() => {
    if (isSessionLoading) return;
    let cancelled = false;
    const current = captureSessionGuard();
    void loadTree(() => !cancelled && current());
    return () => {
      cancelled = true;
    };
  }, [sessionVersion, isSessionLoading, loadTree]);

  // 执行跳转。summarize=true 时 SDK 会先生成被离弃分支的总结（branch_summary）
  // 再切 leaf（模仿 pi TUI /tree 的总结离开分支行为）。
  const doNavigate = async (id: string, summarize: boolean) => {
    const state = usePiStore.getState();
    if (state.isSessionLoading || state.sessionRevision === null) return;
    const current = captureSessionGuard();
    // SDK 在流式中会直接拒绝 navigateTree（"Wait for the current response to finish..."），
    // 所以运行中先确认「停止本轮执行」，确认后 abort 并等待落盘再切节点。
    if (!(await confirmStopRunning(t.stopRunningActionFork))) return;
    if (!current()) return;
    setNavigating(true);
    try {
      if (await transitionSession(() => window.pi.navigateTree(id, summarize))) onClose();
      else setNavigating(false);
    } catch (e) {
      console.error('Failed to navigate tree', e);
      setNavigating(false);
      setConfirmTargetId(null);
    }
  };

  // 底部「跳转到此处」：弹窗询问是否总结被离弃分支
  const handleJump = () => {
    if (!selectedId) return;
    setConfirmTargetId(selectedId);
  };

  // 计算可见节点（按展开状态拍平），避免递归渲染爆调用栈
  // 每个可见节点是独立行，indent 控制 padding
  const visibleRows = useMemo(() => {
    if (!tree) return [];
    const rows: { node: TreeNode; indent: number }[] = [];
    // 手动 DFS 迭代（避免递归爆栈）
    const stack: { node: TreeNode; indent: number }[] = [];
    // 后进先出：对 roots 逆序压栈，最后弹出的是正序第一个
    for (let i = tree.length - 1; i >= 0; i--) {
      stack.push({ node: tree[i], indent: 0 });
    }
    while (stack.length > 0) {
      const { node, indent } = stack.pop()!;
      rows.push({ node, indent });
      const skelId = (node.entry as any).id;
      const isExpanded = expandedNodes[skelId];
      const children = node.children ?? [];
      if (isExpanded && children.length > 0) {
        // 逆序压栈，弹出时保持原顺序
        const nextIndent = children.length > 1 ? indent + 1 : indent;
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ node: children[i], indent: nextIndent });
        }
      }
    }
    return rows;
  }, [tree, expandedNodes]);

  const renderRow = (node: TreeNode, indent: number): React.ReactNode => {
    const skel = node.entry as unknown as SkeletonNode;
    const isLeaf = skel.id === leafId;
    const isSelected = skel.id === selectedId;
    const isExpanded = expandedNodes[skel.id];
    const hasChildren = node.children && node.children.length > 0;
    const meta = getNodeMeta(skel);
    const padding = `${indent * 16 + 8}px`;

    return (
      <div
        key={skel.id}
        data-node-id={skel.id}
        className={`flex w-max items-center gap-1.5 py-0.5 text-xs cursor-pointer rounded-sm ${
          isSelected ? 'bg-od-accent/20' : 'hover:bg-od-bg-hover'
        }`}
        style={{ paddingLeft: padding, paddingRight: 16 }}
        onClick={() => setSelectedId(skel.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpandedNodes((p) => ({ ...p, [skel.id]: !p[skel.id] }));
            }}
            className="text-od-text-dim hover:text-od-text"
          >
            <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} className="w-3" />
          </button>
        ) : (
          <span className="inline-block w-3" />
        )}
        <Icon name={meta.icon} className={`w-3 shrink-0 ${meta.color}`} />
        <span className={`shrink-0 font-medium ${meta.color}`}>{meta.tag}:</span>
        <span className="whitespace-nowrap text-od-text">{skel.text}</span>
        {isLeaf && (
          <span className="ml-1 shrink-0 text-od-accent" title="当前节点">
            <Icon name="circle" className="w-2" />
          </span>
        )}
        {node.label && (
          <span className="ml-1 shrink-0 text-od-yellow" title={node.label}>
            <Icon name="tag" className="w-3" />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ paddingTop: isMac ? 38 : 32 }}>
      {/* 顶部 paddingTop 区域保持透明：露出原生标题栏毛玻璃（背景只从内容区铺） */}
      <div className="flex min-h-0 flex-1 flex-col bg-od-bg">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-od-border px-4 py-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
              <Icon name="tree" className="w-3.5 text-od-accent" />
              {t.treeView}
            </h2>
            <button onClick={onClose} className="text-od-text-dim hover:text-od-text-bright">
              <Icon name="close" size="sm" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto overflow-x-auto p-2">
            {tree ? (
              <div className="inline-block min-w-full">
                {visibleRows.map(({ node, indent }) => renderRow(node, indent))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-od-text-dim">
                <Icon name="spinner" spin className="w-3 mr-1" />
                {t.loadingDots}
              </div>
            )}
          </div>

          {/* 底部操作栏：选中节点后可跳转（弹窗确认是否总结被离弃分支） */}
          <div className="flex items-center justify-between gap-2 border-t border-od-border px-4 py-2.5">
            <div className="truncate text-xs text-od-text-dim">
              {!selectedId
                ? t.treeJumpNeedSelect
                : selectedId === leafId
                  ? t.treeJumpCurrent
                  : t.treeHint}
            </div>
            <button
              disabled={!selectedId || selectedId === leafId || navigating}
              onClick={handleJump}
              className="flex shrink-0 items-center gap-1.5 rounded border border-od-accent/40 bg-od-accent/20 px-3 py-1 text-xs text-od-text-bright transition-colors hover:bg-od-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {navigating ? (
                <Icon name="spinner" spin className="w-3" />
              ) : (
                <Icon name="branch" className="w-3 text-od-yellow" />
              )}
              {t.navigateHere}
            </button>
          </div>
        </div>
      </div>

      {/* 跳转确认弹窗：是否总结被离弃分支（模仿 pi 原版 /tree 行为） */}
      {confirmTargetId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => !navigating && setConfirmTargetId(null)}
        >
          <div
            className="w-[26rem] rounded-lg border border-od-border-light bg-od-bg-alt p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-od-text-bright">
              <Icon name="branch" className="w-3.5 text-od-yellow" />
              {t.treeJumpTitle}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-od-text-dim">{t.treeJumpBody}</p>
            {navigating && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-od-accent">
                <Icon name="spinner" spin className="w-3" />
                {t.loadingDots}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                disabled={navigating}
                onClick={() => setConfirmTargetId(null)}
                className="rounded border border-od-border px-3 py-1.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text"
              >
                {t.treeJumpCancel}
              </button>
              <button
                disabled={navigating}
                onClick={() => doNavigate(confirmTargetId, false)}
                className="rounded border border-od-border px-3 py-1.5 text-xs text-od-text transition-colors hover:bg-od-bg-hover"
              >
                {t.treeJumpDirect}
              </button>
              <button
                disabled={navigating}
                onClick={() => doNavigate(confirmTargetId, true)}
                className="flex items-center gap-1.5 rounded bg-od-accent px-3 py-1.5 text-xs text-white transition-colors hover:opacity-90 disabled:opacity-50"
              >
                <Icon name="compress" className="w-3" />
                {t.treeJumpSummarize}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
