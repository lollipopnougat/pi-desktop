import { Fragment, useRef, useState } from 'react';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * 排队消息区（streaming 期间待投递的消息）。
 *
 * 分区：引导消息（steering）与排队消息（followUp）是两个**独立分区**，各自有标题、各自排序，
 * 不混排在同一条流里 —— 两者的投递时机不同（引导在下次模型调用前注入，排队在本轮结束后依次发送）。
 *
 * 拖拽排序：
 * - 同分区内拖拽 = 排序，落到第 i 条左侧即插入到第 i 条之前（落到空白处 = 队尾）；
 * - 拖到另一分区 = 改用另一种投递方式（复用 switchQueuedMessage，追加到目标分区末尾）；
 * - 落点判定：onDragOver 写在整行上，用 insertIndexFromPoint 按「先垂直行、后水平中点」算插入点，
 *   这样换行（flex-wrap）时不会算错行；芯片间隙等非芯片区域也会落到最近的插入点而非一律队尾。
 * - 拖放事件会在行→分区两层冒泡，两层都挂了 onDrop，所以行内必须 stopPropagation，
 *   再加一个 dropping ref 兜底，避免一次松手执行两次（否则会多移一格 / 多切一次类型）。
 * - 把手（grip）是可聚焦元素，键盘 ← / → 可把该条移动一格，拖拽不是唯一入口。
 *
 * 单条操作都走 IPC（clearQueue 取快照 → 重排 → 其余按新顺序重新入队），
 * 完成后队列由 queue_update 事件同步，所以这里不做本地乐观更新。
 */

type QueueKind = 'steering' | 'followUp';

interface QueueChipsProps {
  steering: string[];
  followUp: string[];
  /** ✏ 撤回：把该条文本（及随消息发出的图片）放回输入框，由父组件负责 setText/附件/聚焦 */
  onRevokeText: (text: string, images?: QueuedImage[]) => void;
}

/** 排队消息携带的图片（结构等同 pi-ai 的 ImageContent，只用于撤回时回填，不在这里渲染） */
type QueuedImage = { type: 'image'; data: string; mimeType: string };

interface DragState {
  kind: QueueKind;
  index: number;
}

interface DropState {
  kind: QueueKind;
  /** 插入点：插到该分区第 index 条之前（index === items.length 表示队尾） */
  index: number;
}

interface SectionMeta {
  title: string;
  hint: string;
  icon: 'bolt' | 'clock';
  /** 分区左侧竖条 */
  rail: string;
  /** 跨区拖拽悬停时的高亮 */
  highlight: string;
  chip: string;
  /** 分区标题与插入指示条颜色 */
  accent: string;
}

const SECTIONS: Record<QueueKind, SectionMeta> = {
  steering: {
    title: t.queueSectionSteer,
    hint: t.queueSectionSteerHint,
    icon: 'bolt',
    rail: 'border-od-accent/50',
    highlight: 'ring-1 ring-od-accent/40 bg-od-accent/5',
    chip: 'bg-od-accent/20 text-od-accent',
    accent: 'bg-od-accent text-od-accent'
  },
  followUp: {
    title: t.queueSectionFollowUp,
    hint: t.queueSectionFollowUpHint,
    icon: 'clock',
    rail: 'border-od-purple/50',
    highlight: 'ring-1 ring-od-purple/40 bg-od-purple/5',
    chip: 'bg-od-purple/20 text-od-purple',
    accent: 'bg-od-purple text-od-purple'
  }
};

/** 分区标题/指示条只要颜色不同：accent 里前半是 bg-*，后半是 text-* */
const accentBg = (meta: SectionMeta) => meta.accent.split(' ')[0];
const accentText = (meta: SectionMeta) => meta.accent.split(' ')[1];

/**
 * 按指针位置算插入点。
 * 先用垂直距离挑出「最近的一行」（换行布局下必须以行为准），再在该行按水平中点决定插到左还是右。
 * 垂直误差权重 ×4，保证水平略偏也不会跨行取错。
 */
function insertIndexFromPoint(row: HTMLElement, x: number, y: number): number {
  const chips = Array.from(row.querySelectorAll<HTMLElement>('[data-queue-chip]'));
  if (chips.length === 0) return 0;
  let best = Number.POSITIVE_INFINITY;
  let index = chips.length;
  for (const el of chips) {
    const rect = el.getBoundingClientRect();
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dist = dy * 4 + dx;
    if (dist < best) {
      best = dist;
      const i = Number(el.dataset.queueChip);
      index = x < rect.left + rect.width / 2 ? i : i + 1;
    }
  }
  return index;
}

export default function QueueChips({ steering, followUp, onRevokeText }: QueueChipsProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  /** 跨区拖拽时悬停的目标分区 */
  const [hoverKind, setHoverKind] = useState<QueueKind | null>(null);
  /** 一次拖放只处理一次（行与分区都挂了 onDrop，事件冒泡会进来两趟） */
  const dropping = useRef(false);

  const total = steering.length + followUp.length;
  if (total === 0) return null;

  const endDrag = () => {
    setDrag(null);
    setDrop(null);
    setHoverKind(null);
  };

  const applyDrop = async () => {
    if (dropping.current) return;
    const from = drag;
    const target = drop;
    const hover = hoverKind;
    endDrag();
    if (!from) return;
    dropping.current = true;
    try {
      if (hover && hover !== from.kind) {
        // 跨分区：改为另一种投递方式（追加到目标分区末尾）
        await window.pi.switchQueuedMessage(from.kind, from.index);
        return;
      }
      if (!target || target.kind !== from.kind) return;
      // 落点在自身两侧 = 顺序不变，无需请求
      if (target.index === from.index || target.index === from.index + 1) return;
      await window.pi.reorderQueuedMessage(from.kind, from.index, target.index);
    } finally {
      dropping.current = false;
    }
  };

  /** 键盘排序：把第 index 条向左/右挪一格（插入点语义与拖拽一致） */
  const moveByKeyboard = (kind: QueueKind, index: number, delta: -1 | 1) => {
    const to = delta === -1 ? index - 1 : index + 2;
    void window.pi.reorderQueuedMessage(kind, index, to);
  };

  const renderSection = (kind: QueueKind, items: string[]) => {
    const meta = SECTIONS[kind];
    const isHighlighted = hoverKind === kind && drag !== null && drag.kind !== kind;
    return (
      <div
        key={kind}
        data-section={kind}
        className={`rounded border-l-2 py-1 pl-1.5 pr-1 transition-colors ${meta.rail} ${
          isHighlighted ? meta.highlight : ''
        }`}
        onDragOver={(e) => {
          if (drag && drag.kind !== kind) {
            e.preventDefault();
            setHoverKind(kind);
          }
        }}
        onDragLeave={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const outside =
            e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
          if (outside) setHoverKind((k) => (k === kind ? null : k));
        }}
        onDrop={(e) => {
          e.preventDefault();
          void applyDrop();
        }}
      >
        <div className="flex items-center gap-1 text-[0.7rem]" title={meta.hint}>
          <Icon name={meta.icon} className={`w-2.5 ${accentText(meta)}`} />
          <span className={accentText(meta)}>{meta.title}</span>
          <span className="text-od-text-dim">{items.length}</span>
        </div>
        <div
          className="mt-1 flex min-h-[1.4rem] flex-wrap items-center gap-1"
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            e.stopPropagation(); // 同一行的 dragover 别在分区上再算一次
            if (drag.kind !== kind) {
              setHoverKind(kind);
              return;
            }
            setDrop({ kind, index: insertIndexFromPoint(e.currentTarget, e.clientX, e.clientY) });
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void applyDrop();
          }}
        >
          {items.map((text, i) => {
            const dragging = drag?.kind === kind && drag.index === i;
            return (
              <Fragment key={`${kind}-${i}`}>
                {drop?.kind === kind && drop.index === i && (
                  <span className={`h-4 w-0.5 shrink-0 rounded-full ${accentBg(meta)}`} />
                )}
                <span
                  data-queue-chip={i}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    // Chromium 需要 setData 才认为是一次有效的拖拽
                    e.dataTransfer.setData('text/plain', text);
                    setDrag({ kind, index: i });
                  }}
                  onDragEnd={endDrag}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${meta.chip} ${
                    dragging ? 'opacity-40' : ''
                  }`}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={t.dragToReorder}
                    title={t.dragToReorder}
                    data-queue-grip={i}
                    onClick={() => {}}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft' && i > 0) {
                        e.preventDefault();
                        moveByKeyboard(kind, i, -1);
                      } else if (e.key === 'ArrowRight' && i < items.length - 1) {
                        e.preventDefault();
                        moveByKeyboard(kind, i, 1);
                      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault(); // 避免方向键把焦点移出队列区
                      }
                    }}
                    className="shrink-0 cursor-grab opacity-60 hover:opacity-100"
                  >
                    <Icon name="gripVertical" size="xs" />
                  </span>
                  <span className="max-w-xs truncate">{text}</span>
                  <button
                    onClick={async () => {
                      const r = await window.pi.revokeQueuedMessage(kind, i);
                      if (r?.revoked) onRevokeText(r.revoked, r.images);
                    }}
                    className="shrink-0 opacity-70 hover:opacity-100"
                    title={t.editQueuedMsg}
                  >
                    <Icon name="edit" size="xs" />
                  </button>
                  <button
                    onClick={() => window.pi.switchQueuedMessage(kind, i)}
                    className={`shrink-0 rounded px-1 opacity-70 hover:opacity-100 ${
                      kind === 'steering' ? 'hover:bg-od-accent/20' : 'hover:bg-od-purple/20'
                    }`}
                    title={kind === 'steering' ? t.switchQueuedToFollowUp : t.switchQueuedToSteer}
                  >
                    {kind === 'steering' ? t.switchQueuedToFollowUp : t.switchQueuedToSteer}
                  </button>
                  <button
                    onClick={() => window.pi.removeQueuedMessage(kind, i)}
                    className="shrink-0 opacity-70 hover:text-od-red hover:opacity-100"
                    title={t.removeQueuedMsg}
                  >
                    <Icon name="close" size="xs" />
                  </button>
                </span>
              </Fragment>
            );
          })}
          {drop?.kind === kind && drop.index === items.length && (
            <span className={`h-4 w-0.5 shrink-0 rounded-full ${accentBg(meta)}`} />
          )}
          {/* 尾部留白：整行都可作为拖放区域；它专门表示「落到队尾」——
              换行布局下这块留白可能自己被挤到新的一行，靠最近的芯片反推会算成列表中间 */}
          <span
            data-queue-tail
            className="min-w-[1.5rem] flex-1 self-stretch"
            onDragOver={(e) => {
              if (!drag || drag.kind !== kind) return; // 跨区时让分区自己去高亮
              e.preventDefault();
              e.stopPropagation();
              setDrop({ kind, index: items.length });
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="mb-2 rounded-lg border border-od-border-light bg-od-bg-alt/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div
          className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-od-text-dim"
          title={t.queueDragHint}
        >
          <Icon name="clock" className="w-2.5" />
          <span>{t.queueBlockTitle}</span>
          <span className="rounded bg-od-bg-hover px-1 text-od-text-dim">{total}</span>
        </div>
        <button
          onClick={() => window.pi.clearQueue()}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-od-text-dim hover:bg-od-bg-hover hover:text-od-red"
          title={t.clearQueue}
        >
          {t.clearQueue}
        </button>
      </div>
      <div className="mt-1 space-y-1">
        {steering.length > 0 && renderSection('steering', steering)}
        {followUp.length > 0 && renderSection('followUp', followUp)}
      </div>
    </div>
  );
}
