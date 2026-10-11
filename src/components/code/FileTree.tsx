import { useState, useEffect, useCallback } from 'react';
import Icon from '../common/Icon';
import type { IconName } from '../common/icons';

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  expanded?: boolean;
}

interface FileTreeProps {
  cwd: string;
  onFileOpen: (path: string) => void;
  /** 按文件/目录名过滤（不区分大小写），仅作用于已加载节点 */
  filter?: string;
  /** 挂载时级联展开到该路径的所在目录（项目内为相对 cwd，项目外为绝对路径） */
  expandToPath?: string;
  /** 高亮的文件路径（当前打开的文件） */
  activePath?: string;
  /** 树根目录：'' 或未传表示项目根（cwd），绝对路径表示项目外目录（技能等） */
  rootPath?: string;
}

export default function FileTree({
  cwd,
  onFileOpen,
  filter,
  expandToPath,
  activePath,
  rootPath
}: FileTreeProps) {
  const treeRoot = rootPath ?? '';
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});

  const loadDir = useCallback(async (dirPath: string): Promise<FileTreeNode[]> => {
    const entries = await window.pi.listFiles(dirPath || undefined);
    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      const node: FileTreeNode = {
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory
      };
      nodes.push(node);
    }
    // Sort: directories first, then alphabetically
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const root = await loadDir(treeRoot);
      if (cancelled) return;
      // 级联展开到目标路径所在目录（treeRoot 为绝对路径时按绝对路径逐级拼接）
      const rel = resolveRelative(expandToPath, treeRoot);
      if (rel) {
        const segs = rel.split(/[/\\]/).filter(Boolean);
        let acc = treeRoot;
        let current = root;
        const expandMap: Record<string, boolean> = {};
        for (let i = 0; i < segs.length; i++) {
          acc = acc ? acc + '/' + segs[i] : segs[i];
          const node = current.find((n) => n.path === acc);
          if (!node || !node.isDirectory) break;
          expandMap[node.path] = true;
          const children = await loadDir(node.path);
          if (cancelled) return;
          node.children = children;
          current = children;
        }
        setExpandedDirs((prev) => ({ ...prev, ...expandMap }));
      }
      if (!cancelled) setTree([...root]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, expandToPath, treeRoot]);

  const toggleDir = async (node: FileTreeNode) => {
    const isExpanded = !expandedDirs[node.path];
    setExpandedDirs((prev) => ({ ...prev, [node.path]: isExpanded }));

    if (isExpanded && !node.children) {
      const children = await loadDir(node.path);
      // Update tree with children
      setTree((prev) => updateTreeChildren(prev, node.path, children));
    }
  };

  const updateTreeChildren = (
    nodes: FileTreeNode[],
    targetPath: string,
    children: FileTreeNode[]
  ): FileTreeNode[] => {
    return nodes.map((n) => {
      if (n.path === targetPath) {
        return { ...n, children };
      }
      if (n.children) {
        return { ...n, children: updateTreeChildren(n.children, targetPath, children) };
      }
      return n;
    });
  };

  const kw = filter?.trim().toLowerCase() || '';
  // 过滤：目录名匹配、或其已加载子孙有匹配时保留该目录；文件按名称匹配
  const matchNode = useCallback(
    (node: FileTreeNode): boolean => {
      if (!kw) return true;
      if (node.name.toLowerCase().includes(kw)) return true;
      if (node.isDirectory && node.children) return node.children.some(matchNode);
      return false;
    },
    [kw]
  );

  const renderNode = (node: FileTreeNode, depth: number): React.ReactNode => {
    if (kw && !matchNode(node)) return null;
    // 过滤激活时自动展开匹配的目录，方便看到命中的子项
    const isExpanded = expandedDirs[node.path] || (kw && node.isDirectory && !!node.children);
    const padding = `${depth * 12 + 8}px`;

    if (node.isDirectory) {
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node)}
            className="flex w-full items-center gap-1 py-0.5 text-xs text-od-text hover:bg-od-bg-hover"
            style={{ paddingLeft: padding }}
          >
            <Icon
              name={isExpanded ? 'chevronDown' : 'chevronRight'}
              className="w-3 text-od-text-dim"
            />
            <Icon name="folder" className="w-3 text-od-text-dim" />
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded && node.children && (
            <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
          )}
        </div>
      );
    }
    const isActive = activePath === node.path;
    return (
      <button
        key={node.path}
        onClick={() => onFileOpen(node.path)}
        className={`flex w-full items-center gap-1 py-0.5 text-xs hover:bg-od-bg-hover hover:text-od-text-bright ${
          isActive ? 'bg-od-bg-hover text-od-text-bright' : 'text-od-text-dim'
        }`}
        style={{ paddingLeft: `${depth * 12 + 22}px` }}
      >
        <Icon name={getFileIcon(node.name)} className="w-3" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  return (
    <div className="overflow-y-auto py-1">
      {tree.length === 0 && <div className="px-3 py-2 text-xs text-od-text-dim">Loading...</div>}
      {tree.map((node) => renderNode(node, 0))}
    </div>
  );
}

/** expandToPath 相对 treeRoot 的剩余部分（treeRoot 为空时原样返回；等于 treeRoot 时返回空） */
function resolveRelative(expandToPath: string | undefined, treeRoot: string): string {
  if (!expandToPath) return '';
  if (!treeRoot) return expandToPath;
  if (expandToPath === treeRoot) return '';
  return expandToPath.startsWith(`${treeRoot}/`) || expandToPath.startsWith(`${treeRoot}\\`)
    ? expandToPath.slice(treeRoot.length).replace(/^[/\\]+/, '')
    : expandToPath;
}

function getFileIcon(_name: string): IconName {
  // 所有文件类型统一用 file 图标，简化展示
  return 'file';
}
