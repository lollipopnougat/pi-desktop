import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { usePiStore, type AgentMode, type PermissionPolicy } from '../../store/pi-store';
import { useShallow } from 'zustand/react/shallow';
import ModelSelector from './ModelSelector';
import ContextIndicator from './ContextIndicator';
import AskUserPanel from './AskUserPanel';
import PermissionApprovalPanel from './PermissionApprovalPanel';
import PlanReviewPanel from '../plan/PlanReviewPanel';
import MentionDropdown from './MentionDropdown';
import QueueChips from './QueueChips';
import Icon from '../common/Icon';
import GitBranchButton from '../GitBranchButton';
import GoalBar from '../goal/GoalBar';
import { useMention } from '../../hooks/useMention';
import { transitionSession } from '../../hooks/loadSession';
import { confirmStopRunning } from '../../lib/stopRunningConfirm';
import { CHAT_INPUT_DOM_ID } from '../../lib/app-commands';
import { t } from '../../i18n/zh';

function isSessionReady(): boolean {
  const state = usePiStore.getState();
  return !state.isSessionLoading && state.sessionRevision !== null;
}

/** 项目路径比较：忽略结尾斜杠；Windows 下路径大小写不敏感 */
function sameProject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const strip = (p: string) => p.replace(/[/\\]+$/, '');
  const left = strip(a);
  const right = strip(b);
  const platform = typeof window !== 'undefined' ? window.pi?.platform : undefined;
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export default function ChatInput() {
  const [text, setText] = useState('');
  const sessionId = usePiStore((s) => s.sessionId);
  const warnSameProjectBusy = usePiStore((s) => s.sameProjectBusyWarn);
  // 同一项目里已经有别的会话在跑时的“提醒-放行”状态：
  // busyKey 标识当前这一批在跑的其他会话；放行只对「本次会话访问」有效——
  // 切走再切回来（sessionId 变化）要重新提醒，见下面的渲染期重置。
  const busyKey = usePiStore((s) =>
    s.sessionSlots
      .filter(
        (slot) => slot.running && slot.sessionId !== s.sessionId && sameProject(slot.cwd, s.cwd)
      )
      .map((slot) => slot.key)
      .sort()
      .join(',')
  );
  const [acknowledgedBusyKey, setAcknowledgedBusyKey] = useState<string | null>(null);
  const [seenSessionId, setSeenSessionId] = useState(sessionId);
  // 渲染期同步重置（React 官方的「props/state 变化时调整 state」写法）：避免用 effect 多跑一轮
  if (seenSessionId !== sessionId) {
    setSeenSessionId(sessionId);
    setAcknowledgedBusyKey(null);
  }
  // useShallow：逐字段比较。过去全量订阅 store，流式期间每个 token 都会重渲染输入框，
  // 打字明显发涩（见 ChatInput 的 send 逻辑依赖的多个字段都是低频变化）。
  const {
    isStreaming,
    isSessionLoading,
    sessionRevision,
    queue,
    streamingSendMode,
    mode,
    setMode,
    commands,
    askQuestions,
    goalSnapshot,
    model,
    availableModels,
    setRightPanelOpen,
    setPendingFile,
    pendingChatInput,
    setPendingChatInput,
    planPendingProposal
  } = usePiStore(
    useShallow((s) => ({
      isStreaming: s.isStreaming,
      isSessionLoading: s.isSessionLoading,
      sessionRevision: s.sessionRevision,
      queue: s.queue,
      streamingSendMode: s.streamingSendMode,
      mode: s.mode,
      setMode: s.setMode,
      commands: s.commands,
      askQuestions: s.askQuestions,
      goalSnapshot: s.goalSnapshot,
      model: s.model,
      availableModels: s.availableModels,
      setRightPanelOpen: s.setRightPanelOpen,
      setPendingFile: s.setPendingFile,
      pendingChatInput: s.pendingChatInput,
      setPendingChatInput: s.setPendingChatInput,
      planPendingProposal: s.planPendingProposal
    }))
  );
  const hasMessages = usePiStore((s) => s.messages.length > 0);
  // 本会话空闲、但同项目已有其他会话在跑：先拦一道，用户点“仍然继续”才放行。
  // 本会话自己正在跑时不拦（那时输入框是用来引导/排队的，拦了反而妨碍）。
  const busyBlocked =
    warnSameProjectBusy && busyKey !== '' && !isStreaming && acknowledgedBusyKey !== busyKey;
  const [modeOpen, setModeOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // 模式映射辅助（避免散落的 mode === 'plan' ? ... : ... 三元）
  const modeIcon = (m: AgentMode): 'bolt' | 'clipboardList' | 'target' =>
    m === 'plan' ? 'clipboardList' : m === 'goal' ? 'target' : 'bolt';
  const modeLabel = (m: AgentMode): string =>
    m === 'plan' ? t.modePlan : m === 'goal' ? t.modeGoal : t.modeStandard;
  const modeDesc = (m: AgentMode): string =>
    m === 'plan' ? t.modePlanDesc : m === 'goal' ? t.modeGoalDesc : t.modeStandardDesc;
  const modeColor = (m: AgentMode): string =>
    m === 'plan' ? 'text-od-purple' : m === 'goal' ? 'text-od-orange' : 'text-od-yellow';

  // 权限策略映射（与 mode 下拉同构）
  const permissionPolicy = usePiStore((s) => s.permissionPolicy);
  const setPermissionPolicy = usePiStore((s) => s.setPermissionPolicy);
  const permIcon = (p: PermissionPolicy): 'hand' | 'shield' | 'unlock' | 'classifier' =>
    p === 'ask-all'
      ? 'hand'
      : p === 'auto-safe'
        ? 'shield'
        : p === 'classifier-auto'
          ? 'classifier'
          : 'unlock';
  const permLabel = (p: PermissionPolicy): string =>
    p === 'ask-all'
      ? t.permissionAskAll
      : p === 'auto-safe'
        ? t.permissionAutoSafe
        : p === 'classifier-auto'
          ? t.permissionClassifierAuto
          : t.permissionAllowAll;
  const permDesc = (p: PermissionPolicy): string =>
    p === 'ask-all'
      ? t.permissionAskAllDesc
      : p === 'auto-safe'
        ? t.permissionAutoSafeDesc
        : p === 'classifier-auto'
          ? t.permissionClassifierAutoDesc
          : t.permissionAllowAllDesc;
  const permColor = (p: PermissionPolicy): string =>
    p === 'ask-all'
      ? 'text-od-orange'
      : p === 'auto-safe'
        ? 'text-od-accent'
        : p === 'classifier-auto'
          ? 'text-od-purple'
          : 'text-od-green';

  // 统一处理模式切换（setMode 内部已处理 plan 工具裁剪）
  const applyMode = (m: AgentMode) => {
    setMode(m);
    if (m === 'plan') {
      // 进入 plan：与 goal 互斥，暂停当前 goal（不 clear，保留状态）
      if (goalSnapshot?.goal && goalSnapshot.goal.status === 'active') {
        window.pi.goal.pause();
      }
    } else if (m === 'goal') {
      // 进入 goal：不弹窗，输入框发送即创建目标
      // 若已有 active goal，恢复；否则等用户输入目标文本后发送创建
      if (goalSnapshot?.goal && goalSnapshot.goal.status !== 'complete') {
        window.pi.goal.resume();
      }
    }
    // standard：setMode 内部已恢复工具集，goal 不自动 clear，后台保留
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 面板宽度不足时进入紧凑模式（隐藏 token 用量文字）
  const [compact, setCompact] = useState(false);
  const [pendingImages, setPendingImages] = useState<
    Array<{ data: string; mediaType: string; name: string }>
  >([]);
  const [cwd, setCwd] = useState('');
  const storeCwd = usePiStore((s) => s.cwd);

  // Load cwd on mount + 同步 store cwd 变化（切换会话/项目目录时）
  useEffect(() => {
    window.pi.getCwd().then(setCwd);
  }, []);
  // 消费设置页注入的待输入文本（如“创建技能”按钮注入 $skill:skill-creator）
  useEffect(() => {
    if (pendingChatInput) {
      setText(pendingChatInput);
      setPendingChatInput(null);
      // 聚焦输入框并光标置末
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          const pos = ta.value.length;
          ta.setSelectionRange(pos, pos);
        }
      }, 0);
    }
  }, [pendingChatInput, setPendingChatInput]);
  useEffect(() => {
    if (storeCwd) setCwd(storeCwd);
  }, [storeCwd]);

  // textarea 随内容纵向自增长，超过最大高度后出现滚动条
  const MAX_TEXTAREA_HEIGHT = 240;
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  // 监测输入区宽度，不足阈值时进入紧凑模式（隐藏 token 用量文字）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < 380);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleSelectDir = async () => {
    const dir = await window.pi.selectDirectory();
    if (!dir) return;
    // 切换项目目录会重建 runtime（中止当前轮），运行中先确认
    if (!(await confirmStopRunning(t.stopRunningActionCwd))) return;
    await transitionSession(() => window.pi.setCwd(dir));
  };

  // Mention 自动补全：state/effect/键盘导航/插入都在 hook 里
  const mention = useMention(text, setText, textareaRef);

  // 纯文本文件大小上限 2MB
  const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;

  /**
   * 判断是否为可读入输入框的纯文本文件：
   * - 图片一律拒（另有图片上传通道）
   * - 明确的文本类 MIME 或常见文本扩展名直接放行
   * - 有明确非文本 MIME（如 application/pdf、video/*）则拒
   * - MIME 未知（type 为空，常见于 Makefile、Dockerfile 等）：读前 4KB 嗅探，含 NUL 字节视为二进制
   */
  const isTextFile = async (file: File): Promise<boolean> => {
    const TEXT_MIME_PREFIXES = [
      'text/',
      'application/json',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      'application/javascript',
      'application/typescript',
      'application/toml',
      'application/x-sh'
    ];
    const TEXT_EXTENSIONS = [
      '.txt',
      '.md',
      '.markdown',
      '.json',
      '.jsonc',
      '.json5',
      '.xml',
      '.yml',
      '.yaml',
      '.toml',
      '.ini',
      '.cfg',
      '.conf',
      '.env',
      '.properties',
      '.csv',
      '.tsv',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.ts',
      '.tsx',
      '.css',
      '.scss',
      '.sass',
      '.less',
      '.html',
      '.htm',
      '.vue',
      '.svelte',
      '.py',
      '.rb',
      '.go',
      '.rs',
      '.java',
      '.kt',
      '.kts',
      '.c',
      '.h',
      '.cpp',
      '.hpp',
      '.cc',
      '.hh',
      '.cs',
      '.swift',
      '.m',
      '.mm',
      '.php',
      '.pl',
      '.lua',
      '.r',
      '.jl',
      '.dart',
      '.sql',
      '.sh',
      '.bash',
      '.zsh',
      '.fish',
      '.ps1',
      '.bat',
      '.cmd',
      '.cmake',
      '.gradle',
      '.editorconfig',
      '.gitignore',
      '.gitattributes',
      '.npmrc',
      '.nvmrc',
      '.log',
      '.diff',
      '.patch'
    ];

    const mime = (file.type || '').toLowerCase();
    if (mime.startsWith('image/')) return false;
    if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
    const lowerName = (file.name || '').toLowerCase();
    if (
      lowerName === 'makefile' ||
      lowerName === 'dockerfile' ||
      lowerName === 'rakefile' ||
      lowerName === 'gemfile'
    )
      return true;
    if (TEXT_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) return true;
    if (mime) return false; // 有明确非文本 MIME，拒

    // MIME 未知（type 为空）：嗅探内容，含 NUL 字节 → 二进制
    return new Promise((resolve) => {
      const blob = file.slice(0, 4096);
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        resolve(!bytes.includes(0));
      };
      reader.onerror = () => resolve(false);
      reader.readAsArrayBuffer(blob);
    });
  };

  // Handle file upload button (images or text files)
  const handleFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          setPendingImages((prev) => [
            ...prev,
            { data: base64, mediaType: file.type, name: file.name }
          ]);
        };
        reader.readAsDataURL(file);
      } else {
        // Text file: read content and append as context to the message
        const appendFile = async () => {
          try {
            if (file.size > MAX_TEXT_FILE_SIZE) {
              usePiStore
                .getState()
                .showToast(t.textFileTooLarge(file.name), { variant: 'warning' });
              return;
            }
            if (!(await isTextFile(file))) {
              usePiStore.getState().showToast(t.textFileNotText(file.name), { variant: 'warning' });
              return;
            }
            setSendError(null);
            const content = await file.text();
            const fileRef = `\n\n--- ${file.name} ---\n${content}\n--- end ${file.name} ---`;
            setText((prev) => prev + (prev ? '\n' : '') + fileRef);
          } catch {
            usePiStore.getState().showToast(t.textFileReadFail(file.name), { variant: 'error' });
          }
        };
        void appendFile();
      }
    }
    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  // 模型回复期间的默认投递方式（设置页「待发送消息」）：Enter / 发送按钮走默认，Alt+Enter 走另一种
  const primarySendLabel = streamingSendMode === 'steer' ? t.steerSend : t.followUpSend;
  const secondarySendLabel = streamingSendMode === 'steer' ? t.followUpSend : t.steerSend;
  const sendWhileStreaming = (value: string) => {
    if (streamingSendMode === 'steer') window.pi.steer(value);
    else window.pi.followUp(value);
  };
  const sendOtherWhileStreaming = (value: string) => {
    if (streamingSendMode === 'steer') window.pi.followUp(value);
    else window.pi.steer(value);
  };

  const handleSend = useCallback(async () => {
    const raw = text.trim();
    if (!raw || usePiStore.getState().isStreaming || !isSessionReady()) return;
    // 同项目其他会话在跑时的提醒蒙层未放行：不允许发送
    if (busyBlocked) return;
    // 自动补全插入的 $skill:<name> 归一化为 SDK 识别的 /skill:<name>，
    // 否则 SDK 的 _expandSkillCommand 不会展开（只认 /skill: 开头）。
    const trimmed = raw.startsWith('$skill:') ? raw.replace(/^\$skill:/, '/skill:') : raw;

    // 无可用模型时不允许发送
    if (availableModels.length === 0) {
      setSendError(t.noModelsConfigured);
      return;
    }
    setSendError(null);

    // /mcp 命令：打开 MCP 状态弹窗
    if (trimmed === '/mcp' || trimmed === '/mcp ') {
      setText('');
      usePiStore.getState().setMcpStatusOpen(true);
      return;
    }

    setText('');

    // goal 模式：若当前无 active goal，发送内容即作为目标创建并启动自治循环
    // 但 / 开头的命令优先走 prompt(让 SDK 处理 /goal 等命令)
    const curMode = usePiStore.getState().mode;
    const curGoal = usePiStore.getState().goalSnapshot?.goal;
    if (
      curMode === 'goal' &&
      (!curGoal || curGoal.status === 'complete') &&
      !trimmed.startsWith('/')
    ) {
      const created = await window.pi.goal.create(trimmed);
      if (created?.queued) {
        usePiStore.getState().showToast(t.promptQueued, { variant: 'info' });
      }
      return;
    }

    let result: { queued: boolean } | undefined;
    try {
      // Send with images if any
      if (pendingImages.length > 0) {
        const images = pendingImages.map((img) => ({
          type: 'image' as const,
          data: img.data,
          mimeType: img.mediaType
        }));
        setPendingImages([]);
        result = await window.pi.prompt(trimmed, { images });
      } else {
        result = await window.pi.prompt(trimmed);
      }
      // 并发上限（同时 3 个会话）：主进程已把这一轮排队，给用户一个明确提示
      if (result?.queued) {
        usePiStore.getState().showToast(t.promptQueued, { variant: 'info' });
      }
    } catch (e: any) {
      setSendError(e?.message || t.sendFailed);
    }
  }, [text, pendingImages, availableModels, busyBlocked]);

  // Handle image paste
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          setPendingImages((prev) => [
            ...prev,
            { data: base64, mediaType: file.type, name: file.name || `image-${Date.now()}.png` }
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  // Handle image drag-drop
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          setPendingImages((prev) => [
            ...prev,
            { data: base64, mediaType: file.type, name: file.name }
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  /**
   * 从输入框文本中解析出所有 $skill:<name> 引用，用于在输入框上方展示为可点击 chip。
   * 匹配 $skill:name（name 为小写字母/数字/连字符），去重保序。
   */
  const referencedSkills = useMemo(() => {
    const matches = text.match(/\$skill:([a-z0-9][a-z0-9-]*)/g) || [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const m of matches) {
      const name = m.slice(7); // strip '$skill:'
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }, [text]);

  /** 点击技能 chip：在右侧代码边栏打开对应 SKILL.md */
  const handleOpenSkill = useCallback(
    async (skillName: string) => {
      try {
        const res = await window.pi.readSkillFile(skillName);
        setRightPanelOpen(true);
        setPendingFile({ path: res.path, mode: 'file' });
      } catch (e: any) {
        setSendError(e?.message || t.skillOpenFail);
      }
    },
    [setRightPanelOpen, setPendingFile]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention 导航：交给 hook，若已消费则不再走后续逻辑
    if (mention.onKeyDown(e)) return;

    // Shift+Tab: cycle thinking level
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (!isSessionReady()) return;
      window.pi.cycleThinkingLevel();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!isSessionReady()) return;
      if (usePiStore.getState().isStreaming) {
        const raw = text.trim();
        const trimmed = raw.startsWith('$skill:') ? raw.replace(/^\$skill:/, '/skill:') : raw;
        if (trimmed) {
          // /goal 命令在 streaming 时直接走 IPC(扩展命令不能 steer)
          if (trimmed.toLowerCase() === '/goal pause') {
            window.pi.goal.pause();
            setText('');
          } else if (trimmed.toLowerCase() === '/goal resume') {
            window.pi.goal.resume();
            setText('');
          } else if (trimmed.toLowerCase() === '/goal clear') {
            window.pi.goal.clear();
            setText('');
          } else {
            sendWhileStreaming(trimmed);
            setText('');
          }
        }
      } else {
        handleSend();
      }
    }
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      if (!isSessionReady()) return;
      // 空闲时等同普通发送，避免消息只入队却没人触发下一轮
      if (!usePiStore.getState().isStreaming) {
        handleSend();
        return;
      }
      const raw = text.trim();
      const trimmed = raw.startsWith('$skill:') ? raw.replace(/^\$skill:/, '/skill:') : raw;
      if (trimmed) {
        sendOtherWhileStreaming(trimmed);
        setText('');
      }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);
    // Mention 触发检测交给 hook
    mention.detect(newText, e.target.selectionStart);
  };

  return (
    <div
      ref={rootRef}
      className="px-4 pb-4 pt-2"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Ask 用户提问面板（展示时隐藏目录切换按钮） */}
      {askQuestions && <AskUserPanel />}

      {/* 权限审批面板（与 ask 面板同位点，优先级仅次于 ask） */}
      {!askQuestions && <PermissionApprovalPanel />}

      {/* Plan 方案审批面板（展示时同样隐藏目录切换按钮） */}
      {planPendingProposal && !askQuestions && <PlanReviewPanel />}

      {/* Project directory selector + Git 分支（与目录并列，不占满整行） */}
      {!askQuestions && !planPendingProposal && (
        <div className="mb-2 flex items-center gap-1">
          <button
            onClick={hasMessages ? undefined : handleSelectDir}
            disabled={hasMessages}
            className={`flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs transition-colors ${
              hasMessages
                ? 'cursor-not-allowed text-od-text-dim/50'
                : 'text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright'
            }`}
            title={
              hasMessages
                ? cwd
                  ? `${cwd}（已有对话，不可切换目录）`
                  : t.selectDir
                : cwd
                  ? `${cwd}（点击切换目录）`
                  : t.selectDir
            }
          >
            <Icon name="folder" className="w-3 shrink-0" />
            <span className="max-w-[420px] truncate text-left">{cwd || t.noProject}</span>
          </button>
          {/* Git 分支：与目录并列（跟随会话 cwd） */}
          <GitBranchButton cwd={cwd} />
        </div>
      )}

      {/* Pending images */}
      {pendingImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingImages.map((img, i) => (
            <div key={`img-${i}`} className="relative">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="h-16 w-16 rounded border border-od-border-light object-contain"
              />
              <button
                onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -right-1 -top-1 rounded-full bg-od-red w-4 h-4 flex items-center justify-center text-white"
              >
                <Icon name="close" size="xs" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* 待发送消息：引导 / 排队两个独立分区，可拖拽排序（详见 QueueChips） */}
      <QueueChips
        steering={queue.steering}
        followUp={queue.followUp}
        onRevokeText={(text) => {
          setText(text);
          textareaRef.current?.focus();
        }}
      />

      {/* 已引用的技能 chip（点击在代码边栏预览 SKILL.md） */}
      {referencedSkills.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          {referencedSkills.map((name) => (
            <button
              key={name}
              onClick={() => handleOpenSkill(name)}
              className="flex items-center gap-1 rounded bg-od-accent/15 px-2 py-0.5 text-xs text-od-accent transition-colors hover:bg-od-accent/25"
              title={t.skillOpenInPanel(name)}
            >
              <Icon name="cube" className="w-3" />
              <span>{name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Goal 状态条（流式时隐藏） */}
      <GoalBar />

      {/* Input area - unified rounded container */}
      <div
        className={`relative rounded-2xl border border-od-border-light bg-od-bg-alt transition-colors ${
          mode === 'plan'
            ? 'focus-within:border-od-purple/90'
            : mode === 'goal'
              ? 'focus-within:border-od-orange/90'
              : 'focus-within:border-od-accent/90'
        }`}
      >
        <div className="relative">
          <textarea
            ref={textareaRef}
            id={CHAT_INPUT_DOM_ID}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            readOnly={busyBlocked}
            placeholder={
              isStreaming
                ? t.streamingHint(primarySendLabel, secondarySendLabel)
                : mode === 'goal' && !goalSnapshot?.goal
                  ? t.goal.createPlaceholder
                  : t.inputPlaceholder
            }
            rows={2}
            className="chat-textarea w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3 pb-1 text-sm text-od-text-bright placeholder:text-od-text-dim focus:outline-none focus:shadow-none"
            style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
          />
          {/* 发送错误提示 */}
          {sendError && (
            <div className="mx-4 mb-1 rounded border border-od-red/30 bg-od-red/10 px-3 py-1.5 text-xs text-od-red">
              {sendError}
            </div>
          )}
          {/* Mention 下拉列表 */}
          <MentionDropdown
            active={mention.mentionActive}
            items={mention.mentionItems}
            index={mention.mentionIndex}
            type={mention.mentionType}
            listRef={mention.listRef}
            onSelect={mention.insert}
          />
        </div>

        {/* Bottom toolbar: mode/upload (left) + model/send (right) */}
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex shrink-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.sh,.yml,.yaml,.xml,.sql,.css,.scss,.html,.toml,.ini,.csv,.log"
              onChange={handleFileInputChange}
              className="hidden"
            />
            <button
              onClick={handleFileUpload}
              disabled={isStreaming}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
              title="上传图片或文本文件"
            >
              <Icon name="upload" />
            </button>
            {/* Mode selector */}
            <div className="relative">
              <button
                onClick={() => {
                  setModeOpen(!modeOpen);
                  setPermOpen(false);
                }}
                className="flex items-center gap-1 rounded-lg px-1.5 h-7 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                title={`${t.modeLabel}: ${modeLabel(mode)}`}
              >
                <Icon name={modeIcon(mode)} className={modeColor(mode)} />
                <Icon name="chevronDown" size="xs" />
                {/* <span className="text-od-text-dim">▾</span> */}
              </button>
              {modeOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => {
                      setModeOpen(false);
                      setPermOpen(false);
                    }}
                  />
                  <div className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl z-20 py-1">
                    {(['standard', 'plan', 'goal'] as AgentMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          applyMode(m);
                          setModeOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-od-bg-hover ${
                          mode === m ? 'text-od-accent' : 'text-od-text-bright'
                        }`}
                      >
                        <Icon name={modeIcon(m)} className={`w-3 ${modeColor(m)}`} />
                        <div className="flex flex-col">
                          <span className="text-xs">{modeLabel(m)}</span>
                          <span className="text-xs text-od-text-dim">{modeDesc(m)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Permission policy selector（模式切换右侧） */}
            <div className="relative">
              <button
                onClick={() => {
                  setPermOpen(!permOpen);
                  setModeOpen(false);
                }}
                className="flex items-center gap-1 rounded-lg px-1.5 h-7 text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright"
                title={`${t.permissionLabel}: ${permLabel(permissionPolicy)}`}
              >
                <Icon name={permIcon(permissionPolicy)} className={permColor(permissionPolicy)} />
                <Icon name="chevronDown" size="xs" />
              </button>
              {permOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => {
                      setPermOpen(false);
                      setModeOpen(false);
                    }}
                  />
                  <div className="absolute bottom-full left-0 mb-1 w-56 rounded-lg border border-od-border-light bg-od-bg-alt shadow-xl z-20 py-1">
                    {(
                      ['ask-all', 'auto-safe', 'classifier-auto', 'allow-all'] as PermissionPolicy[]
                    ).map((p) => (
                      <button
                        key={p}
                        onClick={() => {
                          setPermissionPolicy(p);
                          setPermOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-od-bg-hover ${
                          permissionPolicy === p ? 'text-od-accent' : 'text-od-text-bright'
                        }`}
                      >
                        <Icon name={permIcon(p)} className={`w-3 ${permColor(p)}`} />
                        <div className="flex flex-col">
                          <span className="text-xs">{permLabel(p)}</span>
                          <span className="text-xs text-od-text-dim">{permDesc(p)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {!compact && <ContextIndicator />}
            <div className="min-w-0 flex-shrink">
              <ModelSelector />
            </div>
            {/* 发送/停止合一按钮：
                - idle：发送
                - streaming + 输入框有内容：同一位置变为发送样式（点击入队 steer，不再并排渲染停止按钮）
                - streaming + 无内容：停止按钮 */}
            {!isStreaming ? (
              <button
                onClick={handleSend}
                disabled={
                  isSessionLoading ||
                  sessionRevision === null ||
                  !text.trim() ||
                  availableModels.length === 0
                }
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:opacity-80 active:opacity-70 disabled:opacity-30 ${
                  mode === 'plan'
                    ? 'bg-od-purple'
                    : mode === 'goal'
                      ? 'bg-od-orange'
                      : 'bg-od-accent'
                }`}
                title={availableModels.length === 0 ? t.noModelsConfigured : t.send}
              >
                <Icon name="send" className="w-3" />
              </button>
            ) : text.trim() ? (
              <button
                onClick={() => {
                  if (!isSessionReady()) return;
                  const raw = text.trim();
                  const trimmed = raw.startsWith('$skill:')
                    ? raw.replace(/^\$skill:/, '/skill:')
                    : raw;
                  if (trimmed) {
                    sendWhileStreaming(trimmed);
                    setText('');
                  }
                }}
                disabled={isSessionLoading || sessionRevision === null}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:opacity-80 active:opacity-70 disabled:opacity-30 ${
                  mode === 'plan'
                    ? 'bg-od-purple'
                    : mode === 'goal'
                      ? 'bg-od-orange'
                      : 'bg-od-accent'
                }`}
                title={primarySendLabel}
              >
                <Icon name="send" className="w-3" />
              </button>
            ) : (
              <button
                onClick={() => {
                  if (!isSessionReady()) return;
                  // goal 模式运行中:停止按钮改为暂停目标
                  if (mode === 'goal' && goalSnapshot?.goal?.status === 'active') {
                    window.pi.goal.pause();
                  } else {
                    window.pi.abort();
                  }
                }}
                disabled={isSessionLoading || sessionRevision === null}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-od-red text-white transition-colors hover:bg-od-red/80 active:bg-od-red/65 disabled:opacity-30"
                title={t.abort}
              >
                <Icon name="abort" className="w-3" />
              </button>
            )}
          </div>
        </div>

        {/* 同项目已有其他会话在跑：输入框上盖一层模糊蒙层，点“仍然继续”才放行 */}
        {busyBlocked && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border border-od-border-light bg-od-bg-alt/70 px-4 text-center backdrop-blur-sm">
            <div className="max-w-[420px] text-xs leading-relaxed text-od-text">
              {t.sameProjectBusyNotice}
            </div>
            <button
              type="button"
              onClick={() => {
                setAcknowledgedBusyKey(busyKey);
                textareaRef.current?.focus();
              }}
              className="rounded-md border border-od-border-light bg-od-bg px-3 py-1 text-xs text-od-text-bright transition-colors hover:bg-od-bg-hover"
            >
              {t.sameProjectBusyContinue}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
