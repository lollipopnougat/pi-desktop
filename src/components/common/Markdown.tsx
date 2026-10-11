import { useMemo, useRef, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { copyToClipboard } from '../../utils/clipboard';
import { usePiStore } from '../../store/pi-store';

// 配置 marked：GFM、换行转 <br>
marked.setOptions({
  gfm: true,
  breaks: true
});

/**
 * 自定义 renderer：代码块用 highlight.js 做语法高亮
 */
const renderer = new marked.Renderer();
renderer.code = (token: any) => {
  const lang = (token.lang || '').trim();
  const code = token.text || '';
  let highlighted: string;
  let displayLang = lang || 'text';
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } else {
      // 自动检测语言
      const auto = hljs.highlightAuto(code);
      highlighted = auto.value;
      if (auto.language) displayLang = auto.language;
    }
  } catch {
    highlighted = escapeHtml(code);
  }
  return `<pre class="md-code-block hljs" data-lang="${escapeAttr(displayLang)}"><code class="hljs language-${escapeAttr(lang || displayLang)}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export default function Markdown({
  content,
  openLinksInBrowser = false
}: {
  content: string;
  openLinksInBrowser?: boolean;
}) {
  const html = useMemo(() => {
    const raw = marked.parse(content || '', { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-lang', 'class']
    });
  }, [content]);

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
