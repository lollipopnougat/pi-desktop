import { DiffEditor } from '@monaco-editor/react';
import { parsePatch, applyPatch } from 'diff';
import { detectLanguage } from '../../hooks/useMonaco';
import { useMonacoEditor } from '../../hooks/useMonacoEditor';

interface DiffViewerProps {
  filePath: string;
  patch?: string;
  beforeContent?: string;
  originalContent?: string;
  modifiedContent?: string;
}

/**
 * 从 unified patch 的 hunk 重建 original/modified 片段。
 * 上下文行（空格前缀）进两侧；删除行（-）只进 original；新增行（+）只进 modified。
 * 返回的是改动区域附近的片段（含 context 行），非完整文件。
 */
function reconstructFromPatch(patch: string): { original: string; modified: string } {
  const parsed = parsePatch(patch);
  if (parsed.length === 0) return { original: '', modified: '' };
  const origLines: string[] = [];
  const modLines: string[] = [];
  for (const file of parsed) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const prefix = line[0];
        const content = line.slice(1);
        if (prefix === ' ') {
          origLines.push(content);
          modLines.push(content);
        } else if (prefix === '-') {
          origLines.push(content);
        } else if (prefix === '+') {
          modLines.push(content);
        }
      }
    }
  }
  return { original: origLines.join('\n'), modified: modLines.join('\n') };
}

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
