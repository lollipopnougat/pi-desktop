import { useMemo, useRef, useEffect } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { copyToClipboard } from '../../utils/clipboard';
import { usePiStore } from '../../store/pi-store';
import { splitMarkdownBlocks } from '../../utils/markdown-blocks';

/**
 * 代码块渲染器工厂。highlight=false 时只转义不高亮：流式输出里正在增长的那个代码块
 * 每帧都重跑一遍 highlightAuto 是渲染端最贵的一步（毫秒级 × 每秒几十帧）。
 * 闭合后的块会以 highlight=true 再渲一次（见 buildHtml），因此只是延后、不会缺失。
 */

/**
 * highlightAuto 的候选语言子集。实测（对全量历史会话跑一遍 hljs）：431 个代码块里
 * 只有 10 个没有语言标注，却占掉 86% 的高亮耗时——最坏的一个 239 字符的目录树花了 187ms，
 * 一个 14 字符的中文片段花了 27ms，因为 highlightAuto 会拿全部 ~190 种语言逐个试。
 * 限制成常用子集后最坏用例降到几毫秒（未命中的按纯文本渲染，不影响正确性）。
 */
const AUTO_LANGS = [
  'bash',
  'shell',
  'javascript',
  'typescript',
  'json',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'xml',
  'css',
  'scss',
  'sql',
  'yaml',
  'toml',
  'ini',
  'diff',
  'dockerfile',
  'markdown'
];

/** 超大代码块不做高亮：hljs 在这种规模上可能要几百毫秒，而颜色收益很小 */
const MAX_HIGHLIGHT_CHARS = 30_000;

function createCodeRenderer(highlight: boolean) {
  return {
    code(token: any) {
      const lang = (token.lang || '').trim();
      const code = token.text || '';
      let body: string;
      let displayLang = lang || 'text';
      if (!highlight || code.length > MAX_HIGHLIGHT_CHARS) {
        body = escapeHtml(code);
      } else {
        try {
          if (lang && hljs.getLanguage(lang)) {
            body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } else {
            // 自动检测语言（限定候选子集，见 AUTO_LANGS）
            const auto = hljs.highlightAuto(code, AUTO_LANGS);
            body = auto.value;
            if (auto.language) displayLang = auto.language;
          }
        } catch {
          body = escapeHtml(code);
        }
      }
      return `<pre class="md-code-block hljs" data-lang="${escapeAttr(displayLang)}"><code class="hljs language-${escapeAttr(lang || displayLang)}">${body}</code></pre>`;
    }
  };
}

/** 两个独立实例：marked 的 renderer 挂在实例默认值上，不能按调用切换 */
const markedHighlight = new Marked();
markedHighlight.setOptions({ gfm: true, breaks: true });
markedHighlight.use({ renderer: createCodeRenderer(true) });

const markedPlain = new Marked();
markedPlain.setOptions({ gfm: true, breaks: true });
markedPlain.use({ renderer: createCodeRenderer(false) });

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderMarkdownHtml(content: string, highlight: boolean): string {
  const renderer = highlight ? markedHighlight : markedPlain;
  const raw = renderer.parse(content || '', { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['data-lang', 'class']
  });
}

// 参考式链接定义（`[label]: url`）是文档级作用域，分块解析会解析不到 → 退化为整篇解析
const REFERENCE_DEF_RE = /^\s{0,3}\[[^\]\n]+\]:\s*\S/m;

// 分块渲染结果缓存：流式期间每个已闭合的块只解析一次；上限内不淘汰（只服务当前流式回合）
const RENDER_CACHE = new Map<string, string>();
const RENDER_CACHE_MAX = 500;

function cachedRenderBlock(block: string, highlight: boolean): string {
  const key = `${highlight ? 'h' : 'p'}\u0000${block}`;
  const hit = RENDER_CACHE.get(key);
  if (hit !== undefined) return hit;
  if (RENDER_CACHE.size >= RENDER_CACHE_MAX) RENDER_CACHE.clear();
  const html = renderMarkdownHtml(block, highlight);
  RENDER_CACHE.set(key, html);
  return html;
}

/**
 * 流式内容走分块解析 + 块级缓存，每帧只重解析还在增长的最后一块；
 * 非流式（历史消息、导出、预览）仍整篇解析，语义与改造前完全一致。
 */
function buildHtml(content: string, streaming: boolean): string {
  if (!streaming) return renderMarkdownHtml(content, true);
  if (REFERENCE_DEF_RE.test(content)) return renderMarkdownHtml(content, false);
  const blocks = splitMarkdownBlocks(content);
  // 单块且在增长：直接不高亮（多块时前面的块已闭合，照常高亮并进缓存）
  if (blocks.length <= 1) return renderMarkdownHtml(content, false);
  const last = blocks.length - 1;
  return blocks.map((block, index) => cachedRenderBlock(block, index < last)).join('');
}

export default function Markdown({
  content,
  openLinksInBrowser = false,
  streaming = false
}: {
  content: string;
  openLinksInBrowser?: boolean;
  /** 该内容仍在流式生成中：分块解析 + 延迟语法高亮（见 buildHtml） */
  streaming?: boolean;
}) {
  const html = useMemo(() => buildHtml(content || '', streaming), [content, streaming]);

  const containerRef = useRef<HTMLDivElement>(null);

  // 拦截 markdown 链接点击：转给系统默认浏览器打开。
  // 不拦截的话，Electron BrowserWindow 会直接导航到外部网页，
  // 整个 React 界面被卸载替换且无“后退”无法返回（主进程也有 will-navigate 兑底）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      // 仅处理 http(s) 链接；锚点（#xxx）保留页面内滚动行为
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      const state = usePiStore.getState();
      if (openLinksInBrowser && state.browserEnabled) {
        state.setRightPanelOpen(true);
        window.pi.browser.open(href).catch(() => window.pi.openExternal(href));
      } else {
        window.pi.openExternal(href);
      }
    };
    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [openLinksInBrowser]);

  // 为每个代码块注入复制按钮（因用 dangerouslySetInnerHTML，无法直接绑 React 事件）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const blocks = container.querySelectorAll<HTMLPreElement>('pre.md-code-block');
    const cleanups: Array<() => void> = [];
    blocks.forEach((pre) => {
      // 避免重复注入
      if (pre.querySelector('.md-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'md-copy-btn';
      btn.title = '复制代码';
      btn.innerHTML = COPY_ICON_SVG;
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code');
        const text = code?.textContent || '';
        const ok = await copyToClipboard(text);
        if (ok) {
          btn.classList.add('copied');
          btn.innerHTML = CHECK_ICON_SVG;
          setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = COPY_ICON_SVG;
          }, 1500);
        }
      });
      pre.appendChild(btn);
      cleanups.push(() => btn.removeEventListener('click', () => {}));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="md-body prose prose-sm max-w-none text-od-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// FontAwesome 图标 SVG path（faCopy / faCheck 的官方数据）
const COPY_ICON_SVG =
  '<svg viewBox="0 0 448 512" class="svg-inline--fa fa-copy md-btn-icon" fill="currentColor"><path d="M288 64C252.7 64 224 92.7 224 128L224 384C224 419.3 252.7 448 288 448L480 448C515.3 448 544 419.3 544 384L544 183.4C544 166 536.9 149.3 524.3 137.2L466.6 81.8C454.7 70.4 438.8 64 422.3 64L288 64zM160 192C124.7 192 96 220.7 96 256L96 512C96 547.3 124.7 576 160 576L352 576C387.3 576 416 547.3 416 512L416 496L352 496L352 512L160 512L160 256L176 256L176 192L160 192z"/></svg>';
const CHECK_ICON_SVG =
  '<svg viewBox="0 0 448 512" class="svg-inline--fa fa-check md-btn-icon" fill="currentColor"><path d="M530.8 134.1C545.1 144.5 548.3 164.5 537.9 178.8L281.9 530.8C276.4 538.4 267.9 543.1 258.5 543.9C249.1 544.7 240 541.2 233.4 534.6L105.4 406.6C92.9 394.1 92.9 373.8 105.4 361.3C117.9 348.8 138.2 348.8 150.7 361.3L252.2 462.8L486.2 141.1C496.6 126.8 516.6 123.6 530.9 134z"/></svg>';
