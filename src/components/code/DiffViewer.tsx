import { DiffEditor } from '@monaco-editor/react';
import { applyPatch } from 'diff';
import { detectLanguage } from '../../hooks/useMonaco';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';
import { reconstructFromPatch } from '../../lib/patch-utils';

interface DiffViewerProps {
  filePath: string;
  patch?: string;
  beforeContent?: string;
  originalContent?: string;
  modifiedContent?: string;
}

/**
 * 渲染 unified patch 或完整前后内容（Monaco DiffEditor）。
 * 有 originalContent/modifiedContent 时直接用整份文件（右侧审核面板 / 本轮改动精确定位），
 * 只有 patch 时：有 beforeContent 就正向应用 patch，否则从 hunk 重建改动区域片段。
 */
export default function DiffViewer({
  filePath,
  patch,
  beforeContent,
  originalContent,
  modifiedContent
}: DiffViewerProps) {
  const language = detectLanguage(filePath);
  const { theme: monacoTheme, options: monacoOptions } = useMonacoEditor();

  let original = originalContent || beforeContent || '';
  let modified = modifiedContent || '';

  if (originalContent != null || modifiedContent != null) {
    // 直接提供了 original/modified，直接使用
  } else if (patch) {
    try {
      if (beforeContent) {
        // 有完整修改前内容 + patch → 正向应用 patch 得到完整修改后内容
        const result = applyPatch(beforeContent, patch);
        modified = typeof result === 'string' ? result : '';
      } else {
        // 没有 beforeContent（历史会话典型场景）：从 hunk 重建改动区域片段。
        // patch 自带 context 行，能准确呈现两侧差异，无需读取磁盘文件。
        const reconstructed = reconstructFromPatch(patch);
        original = reconstructed.original;
        modified = reconstructed.modified;
      }
    } catch {
      original = '(unable to parse patch)';
      modified = patch;
    }
  }

  return (
    <div className="h-full w-full">
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme={monacoTheme}
        options={{
          ...monacoOptions,
          readOnly: true,
          renderSideBySide: true,
          scrollBeyondLastLine: false
        }}
      />
    </div>
  );
}
