/**
 * 浏览器「标记元素」的页面内运行时。
 *
 * 工作方式：`buildPickerScript()` 把 `pickerRuntime` 序列化成字符串，经
 * `webContents.executeJavaScript()` 在页面主世界执行，返回一个 Promise——
 * 用户点击元素时 resolve 元素信息，按 Esc（或再次点按钮）resolve `null`。
 *
 * 三条设计约束：
 * 1. **不依赖 devtools 开关**：元素点选是普通 UI 交互，不该要求用户先打开「允许执行任意 JS」
 *    （那条开关给的是任意代码执行与 CDP 抓包，风险等级完全不同）。
 * 2. **不引用模块作用域变量**：函数体被 toString() 后单独执行，任何外部引用都会变成
 *    undefined。所有常量都写在函数内部。
 * 3. 拦截用捕获阶段 + `stopImmediatePropagation`：点击要落到页面元素上判定，不能让页面
 *    自己的 click 处理器（导航、提交表单）先跑。
 */

/** 页面内被点选元素的结构化信息（主进程再补截图） */
export interface PickedElement {
  tagName: string;
  selector: string;
  text: string;
  html: string;
  /** 元素在视口中的位置（CSS 像素，相对页面视口左上角） */
  rect: { x: number; y: number; width: number; height: number };
  /** rect 与视口求交后的区域：截图只能截可见部分 */
  clip: { x: number; y: number; width: number; height: number };
  styles: { color: string; background: string; font: string; fontSize: string };
  url: string;
  title: string;
  viewport: { width: number; height: number };
}

/**
 * 注入页面的选择器（会被 toString() 后执行，**不能引用本模块任何变量**）。
 * 返回 null 表示用户取消。
 */
function pickerRuntime(): Promise<unknown> {
  const KEY = '__piPicker';
  const previous = (window as unknown as Record<string, { cancel?: () => void }>)[KEY];
  if (previous?.cancel) {
    try {
      previous.cancel();
    } catch {
      /* 上一轮已经清理过 */
    }
  }

  return new Promise((resolve) => {
    const doc = document;
    const pickerId = String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8);

    const box = doc.createElement('div');
    box.setAttribute('data-pi-picker', 'box');
    box.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'pointer-events:none',
      'border:2px solid #4c9aff',
      'background:rgba(76,154,255,0.14)',
      'border-radius:2px',
      'box-sizing:border-box',
      'display:none'
    ].join(';');

    const card = doc.createElement('div');
    card.setAttribute('data-pi-picker', 'card');
    card.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'pointer-events:none',
      'max-width:320px',
      'padding:8px 10px',
      'border-radius:8px',
      'background:#1b1d23',
      'color:#e6e8ec',
      'border:1px solid #3a3f4b',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'font:12px/1.5 -apple-system,"PingFang SC",monospace',
      'white-space:pre-wrap',
      'display:none'
    ].join(';');

    doc.documentElement.appendChild(box);
    doc.documentElement.appendChild(card);

    let target: Element | null = null;
    let done = false;

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        let part = node.tagName.toLowerCase();
        const id = node.getAttribute('id');
        if (id) {
          parts.unshift(part + '#' + id);
          break;
        }
        const className = node.getAttribute('class') || '';
        const classes = className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (classes.length > 0) part += '.' + classes.join('.');
        const parent: Element | null = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (child) => child.tagName === node!.tagName
          );
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
        depth += 1;
      }
      return parts.join(' > ');
    };

    const clipOf = (rect: { left: number; top: number; right: number; bottom: number }) => {
      const vw = window.innerWidth || doc.documentElement.clientWidth;
      const vh = window.innerHeight || doc.documentElement.clientHeight;
      const left = Math.max(0, Math.min(rect.left, vw));
      const top = Math.max(0, Math.min(rect.top, vh));
      const right = Math.max(left, Math.min(rect.right, vw));
      const bottom = Math.max(top, Math.min(rect.bottom, vh));
      return { x: left, y: top, width: right - left, height: bottom - top };
    };

    const collect = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const text = ((el as HTMLElement).innerText || el.textContent || '').trim();
      return {
        tagName: el.tagName.toLowerCase(),
        selector: cssPath(el),
        text: text.replace(/\s+/g, ' ').slice(0, 300),
        html: el.outerHTML.slice(0, 2000),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        clip: clipOf(rect),
        styles: {
          color: style.color || '',
          background: style.backgroundColor || '',
          font: style.fontFamily || '',
          fontSize: style.fontSize || ''
        },
        url: location.href,
        title: doc.title || '',
        viewport: {
          width: window.innerWidth || doc.documentElement.clientWidth,
          height: window.innerHeight || doc.documentElement.clientHeight
        }
      };
    };

    const describe = (el: Element): string => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const lines = [
        el.tagName.toLowerCase() +
          (el.getAttribute('class')
            ? '.' + (el.getAttribute('class') || '').trim().split(/\s+/)[0]
            : ''),
        Math.round(rect.width) + '×' + Math.round(rect.height),
        '颜色 ' + (style.color || '-'),
        '字体 ' + (style.fontSize || '') + ' ' + (style.fontFamily || '')
      ];
      return lines.join('\n');
    };

    const place = (el: Element) => {
      const rect = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = Math.max(0, rect.width) + 'px';
      box.style.height = Math.max(0, rect.height) + 'px';

      card.textContent = describe(el);
      card.style.display = 'block';
      // 先放到元素左下方，量到真实尺寸后再翻到上方 / 收进视口
      card.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 340)) + 'px';
      card.style.top = rect.bottom + 8 + 'px';
      const cardRect = card.getBoundingClientRect();
      if (cardRect.bottom > window.innerHeight - 4) {
        card.style.top = Math.max(4, rect.top - cardRect.height - 8) + 'px';
      }
    };

    const cleanup = () => {
      done = true;
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      box.remove();
      card.remove();
      const current = (window as unknown as Record<string, { id?: string }>)[KEY];
      if (current?.id === pickerId) delete (window as unknown as Record<string, unknown>)[KEY];
    };

    const finish = (value: unknown) => {
      if (done) return;
      cleanup();
      resolve(value);
    };

    function onMove(event: MouseEvent) {
      const el = doc.elementFromPoint(event.clientX, event.clientY);
      // 不把浮层自己当成目标（虽然是 pointer-events:none，保险起见）
      if (!el || (el as HTMLElement).hasAttribute?.('data-pi-picker')) return;
      target = el;
      place(el);
    }

    function onClick(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const el = target || doc.elementFromPoint(event.clientX, event.clientY);
      finish(el ? collect(el) : null);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    }

    function onScroll() {
      if (target) place(target);
    }

    (window as unknown as Record<string, unknown>)[KEY] = {
      id: pickerId,
      cancel: () => finish(null)
    };

    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
  });
}

/** 生成注入页面执行的脚本（点击/resolve 元素信息，Esc/resolve null） */
export function buildPickerScript(): string {
  return `(${pickerRuntime.toString()})()`;
}

/** 让正在等待的 picker 立即结束（切换标签 / 用户再次点按钮时用） */
export function buildCancelScript(): string {
  return `(() => {
    const current = window.__piPicker;
    if (current && typeof current.cancel === 'function') { current.cancel(); return true; }
    return false;
  })()`;
}
