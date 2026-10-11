import Editor from '@monaco-editor/react';
import { t } from '../../i18n/zh';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 编辑器高度（px 或 CSS 值），默认 280（约等于原来的 rows=14） */
  height?: number | string;
  readOnly?: boolean;
  /** 供屏幕阅读器识别的字段名（Monaco 内部会渲染到 textarea 的 aria-label） */
  ariaLabel?: string;
}

/**
 * 小型 JSON 编辑器（Monaco）：给设置页里需要手写 JSON 的输入框用。
 *
 * 为什么要包一层而不是直接用 `<textarea>`：JSON 语法高亮 + 括号配对 + 实时校验
 * （非法 JSON 直接画红色波浪线），比在提交时才报「第 N 行解析失败」直观得多。
 *
 * 注意事项：
 * - Monaco 的加载依赖 `useMonacoSetup()`（App 根节点调用）先执行 loader.config，
 *   因此在 App 之外的入口挂载本组件会退化成从 CDN 加载；设置页由 App 渲染，安全。
 * - 不给 `path`：@monaco-editor/react 在无 path 时用 `createModel(value, lang, undefined)`
 *   建独立 model，多个实例不会互相串内容（有 path 时才是按 path 复用 model）。
 * - `fixedOverflowWidgets`：设置页是 `overflow-y-auto` 的浮层，不开启的话补全/悬浮提示
 *   会被容器裁掉；`alwaysConsumeMouseWheel: false` 让滚轮到编辑器边界后继续滚外层页面。
 * - 字体/字号/连字/主题等外观项来自设置页「编辑器」section（useMonacoEditor），
 *   这里只保留 JSON 输入框特有的选项。
 */
export default function JsonEditor({
  value,
  onChange,
  height = 280,
  readOnly = false,
  ariaLabel
}: JsonEditorProps) {
  const { theme: monacoTheme, options: monacoOptions } = useMonacoEditor();

  return (
    <div className="overflow-hidden rounded border border-od-border focus-within:border-od-accent">
      <Editor
        height={typeof height === 'number' ? `${height}px` : height}
        width="100%"
        language="json"
        theme={monacoTheme}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        loading={<span className="text-xs text-od-text-dim">{t.loading}</span>}
        options={{
          ...monacoOptions,
          readOnly,
          ariaLabel,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          scrollbar: { alwaysConsumeMouseWheel: false },
          padding: { top: 8, bottom: 8 },
          // 设置页里空间紧凑：不需要的装饰一律关掉，避免挤压行内容
          folding: false,
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          scrollBeyondLastColumn: 1
        }}
      />
    </div>
  );
}
