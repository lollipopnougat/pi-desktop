/**
 * 终端面板：聊天区下方的底部面板。
 *
 * 使用 xterm.js + node-pty（经 IPC）实现真实伪终端。
 * - 支持多标签（每个标签一个独立 pty 实例）
 * - 字体/字号从 store 读取，实时跟随设置页配置
 * - 可拖拽调整高度
 * - 面板首次展开时自动创建一个终端（避免空白）
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { usePiStore } from '../../store/pi-store';
import { terminalThemeFor } from '../../theme/applyTheme';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

interface TermTab {
  id: string; // pty id
  label: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  disposed: boolean;
  cleanups: Array<() => void>;
}

let tabIndex = 0;

export default function TerminalPanel() {
  const open = usePiStore((s) => s.terminalPanelOpen);
  const height = usePiStore((s) => s.terminalPanelHeight);
  const setHeight = usePiStore((s) => s.setTerminalPanelHeight);
  const setOpen = usePiStore((s) => s.setTerminalPanelOpen);
  const fontFamily = usePiStore((s) => s.terminalFontFamily);
  const fontSize = usePiStore((s) => s.terminalFontSize);
  const terminalShell = usePiStore((s) => s.terminalShell);
  const cwd = usePiStore((s) => s.cwd);

  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  // 防止并发重复创建终端（自动创建 + 手动点击可能叠加）
  const creatingRef = useRef(false);

  const activeTab = tabs.find((x) => x.id === activeId) || null;

  // 创建一个新终端实例
  const createTerminal = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setError(null);
    // 用一个合理的默认尺寸，真正尺寸由 fit() 校正
    const result = await window.pi.terminalCreate({
      cwd,
      cols: 80,
      rows: 24,
      shell: terminalShell || undefined
    });
    if (!result.id || result.error) {
      const msg = result.error || '创建终端失败';
      console.error('[terminal] create failed:', msg);
      setError(msg);
      creatingRef.current = false;
      return;
    }
    const id = result.id;
    const term = new Terminal({
      fontFamily,
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalThemeFor(usePiStore.getState().themeFamily, usePiStore.getState().colorMode)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const div = document.createElement('div');
    div.style.width = '100%';
    div.style.height = '100%';
    containerRef.current?.appendChild(div);
    term.open(div);
    try {
      fit.fit();
    } catch {}

    const cleanups: Array<() => void> = [];

    // pty -> 终端：用闭包标志位避免 disposed 后写入
    let disposed = false;
    // 异步拿 iTerm2 官方 16 色 ANSI 配色覆盖近似适配（disposed 后用闭包包保安全）
    void (async () => {
      const { themeFamily, colorMode } = usePiStore.getState();
      const variantId =
        colorMode === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : colorMode;
      try {
        const t = await window.pi.terminalTheme(`${themeFamily}-${variantId}`);
        if (t && !disposed) term.options.theme = t;
      } catch {}
    })();
    const offData = window.pi.onTerminalData(id, (data) => {
      if (!disposed) term.write(data);
    });
    const offExit = window.pi.onTerminalExit(id, () => {
      if (!disposed) term.write('\r\n\x1b[33m[进程已退出]\x1b[0m\r\n');
    });
    cleanups.push(offData, offExit);

    // 用户输入 -> pty
    const inputDisp = term.onData((data) => {
      window.pi.terminalWrite(id, data);
    });
    // 尺寸变化 -> pty
    const resizeDisp = term.onResize(({ cols, rows }) => {
      window.pi.terminalResize(id, cols, rows);
    });
    // 标题变化（shell 通过 OSC 0/1/2 转义序列上报）-> 更新 tab label
    const titleDisp = term.onTitleChange((title) => {
      const trimmed = title?.trim();
      if (!trimmed) return;
      setTabs((prev) => prev.map((p) => (p.id === id ? { ...p, label: trimmed } : p)));
    });
    cleanups.push(inputDisp.dispose, resizeDisp.dispose, titleDisp.dispose);

    const label = result.shell
      ? `${await window.pi.baseName(result.shell)} #${++tabIndex}`
      : t.terminalTab(++tabIndex);
    const tab: TermTab = {
      id,
      label,
      term,
      fit,
      container: div,
      disposed: false,
      cleanups
    };
    // 把 disposed 标志绑定到 tab 上，供 closeTab 翻转
    (tab as any)._setDisposed = () => {
      disposed = true;
    };

    setTabs((prev) => {
      // 隐藏其它终端 DOM
      prev.forEach((p) => {
        p.container.style.display = 'none';
      });
      return [...prev, tab];
    });
    setActiveId(id);
    creatingRef.current = false;
  }, [cwd, terminalShell, fontFamily, fontSize]);

  // 面板打开时若无终端则自动创建一个（首次及手动关闭全部 tab 后均适用）
  useEffect(() => {
    if (open && tabs.length === 0) {
      createTerminal();
    }
  }, [open, tabs.length, createTerminal]);

  // 主题切换：热更新所有存活终端实例配色（applyTheme 派发 pi-theme-change）
  useEffect(() => {
    const handler = (e: Event) => {
      const { familyId, mode } = (
        e as CustomEvent<{ familyId: string; mode: 'system' | 'dark' | 'light' }>
      ).detail;
      const variantId =
        mode === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : mode;
      const key = `${familyId}-${variantId}`;
      setTabs((prev) => {
        prev.forEach((tab) => {
          if (!tab.disposed) {
            void window.pi.terminalTheme(key).then((t) => {
              if (t) tab.term.options.theme = t;
            });
          }
        });
        return prev;
      });
    };
    window.addEventListener('pi-theme-change', handler);
    return () => window.removeEventListener('pi-theme-change', handler);
  }, []);

  // 切换标签：显示对应 DOM，隐藏其它
  useEffect(() => {
    tabs.forEach((tab) => {
      tab.container.style.display = tab.id === activeId ? 'block' : 'none';
      if (tab.id === activeId && !tab.disposed) {
        try {
          tab.fit.fit();
          tab.term.focus();
        } catch {}
      }
    });
  }, [activeId, tabs]);

  // 字体/字号变化时应用到所有终端并重新 fit
  useEffect(() => {
    tabs.forEach((tab) => {
      if (tab.disposed) return;
      try {
        tab.term.options.fontFamily = fontFamily;
        tab.term.options.fontSize = fontSize;
        tab.fit.fit();
        const cols = tab.term.cols;
        const rows = tab.term.rows;
        window.pi.terminalResize(tab.id, cols, rows);
      } catch {}
    });
  }, [fontFamily, fontSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // 容器尺寸变化时重新 fit 活动终端（窗口缩放 / 左右面板拖拽 / 终端面板高度调整 统一处理）
  useEffect(() => {
    if (!open || !activeTab) return;
    const el = containerRef.current;
    if (!el) return;

    // 立即同步一次，处理打开瞬间的初始尺寸
    try {
      activeTab.fit.fit();
      window.pi.terminalResize(activeTab.id, activeTab.term.cols, activeTab.term.rows);
    } catch {}

    // 监听后续尺寸变化（拖拽左右面板、缩放窗口等）
    const ro = new ResizeObserver(() => {
      if (!activeTab || activeTab.disposed) return;
      try {
        activeTab.fit.fit();
        window.pi.terminalResize(activeTab.id, activeTab.term.cols, activeTab.term.rows);
      } catch {}
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, activeTab]);

  // 关闭单个标签
  const closeTab = useCallback(
    (id: string) => {
      window.pi.terminalKill(id);
      setTabs((prev) => {
        const target = prev.find((x) => x.id === id);
        if (target) {
          target.disposed = true;
          (target as any)._setDisposed?.();
          try {
            target.term.dispose();
          } catch {}
          target.container.remove();
          target.cleanups.forEach((fn) => {
            try {
              fn();
            } catch {}
          });
        }
        const next = prev.filter((x) => x.id !== id);
        if (activeId === id) {
          setActiveId(next.length ? next[next.length - 1].id : null);
        }
        // 关闭最后一个 tab 时自动隐藏面板
        if (next.length === 0) {
          setOpen(false);
        }
        return next;
      });
    },
    [activeId]
  );

  // 关闭面板时只隐藏，不销毁终端
  const handleClose = () => setOpen(false);

  // 清空当前终端
  const handleClear = () => {
    if (activeTab) activeTab.term.clear();
  };

  // 拖拽调整高度
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = startH - (ev.clientY - startY);
      setHeight(next);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 卸载时清理所有终端
  useEffect(() => {
    return () => {
      tabs.forEach((tab) => {
        if (tab.disposed) return;
        window.pi.terminalKill(tab.id);
        (tab as any)._setDisposed?.();
        try {
          tab.term.dispose();
        } catch {}
        tab.cleanups.forEach((fn) => {
          try {
            fn();
          } catch {}
        });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 始终渲染完整结构，仅用 CSS 控制可见性，避免卸载 xterm DOM 导致终端内容丢失。
  // 隐藏时高度为 0 且不占布局，展示时恢复设定高度。
  return (
    <div
      className={`flex shrink-0 flex-col border-t border-od-border bg-od-bg-alt ${
        open ? '' : 'hidden'
      }`}
      style={{ height: open ? height : 0 }}
    >
      {/* 拖拽分隔条（顶部） */}
      <div
        onMouseDown={startResize}
        className={`absolute h-1 w-full cursor-row-resize transition-colors hover:bg-od-accent/50 ${
          resizing ? 'bg-od-accent/60' : ''
        }`}
        style={{ marginTop: '-2px' }}
        title="拖拽调整高度"
      />

      {/* 终端标签栏 */}
      <div className="flex items-center gap-1 border-b border-od-border bg-od-bg-dark px-2 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 rounded-t px-2 py-1 text-xs transition-colors ${
                tab.id === activeId
                  ? 'bg-od-bg-alt text-od-text-bright'
                  : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text'
              }`}
            >
              <button
                onClick={() => setActiveId(tab.id)}
                className="flex items-center gap-1"
                title={tab.label}
              >
                <Icon name="terminal" className="w-3" />
                <span>{tab.label}</span>
              </button>
              <button
                onClick={() => closeTab(tab.id)}
                className="opacity-0 transition-opacity hover:text-od-text-bright group-hover:opacity-100"
                title={t.terminalKill}
              >
                <Icon name="close" className="w-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={createTerminal}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.terminalNew}
          >
            <Icon name="plus" className="w-3" />
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.terminalClear}
          >
            <Icon name="rotate" className="w-3" />
          </button>
          <button
            onClick={handleClose}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
            title={t.toggleTerminal}
          >
            <Icon name="chevronDown" className="w-3" />
          </button>
        </div>
      </div>

      {/* 终端渲染区 */}
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden p-1">
        {error && (
          <div className="flex h-full items-center justify-center">
            <div className="text-xs text-od-orange">{t.terminalCreateFail(error)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
