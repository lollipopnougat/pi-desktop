/**
 * 集中管理所有 FontAwesome 图标
 * 统一从 free-solid-svg-icons 导入，避免各组件重复声明
 */
import {
  faCalendarDays, // 日期选择
  faChartLine, // 数据统计
  faSun, // 界面
  faFileLines, // 📄 read
  faPen, // ✏ edit
  faFilePen, // 📝 write
  faTerminal, // ▶ bash
  faMagnifyingGlass, // 🔍 grep
  faFolderOpen, // 📁 ls / 目录
  faFolderTree, // 🌳 会话树
  faGear, // ⚙ 设置
  faXmark, // ✕ 关闭/删除
  faCircle, // ● 状态点
  faChevronDown, // ▼ ▾ 展开
  faChevronRight, // ▸ ▶ 折叠/右箭头
  faChevronLeft, // ◀ 左箭头(图片查看上一张)
  faCheck, // ✓ 成功
  faXmark as faCross, // ✗ 错误（复用 xmark）
  faCircleNotch, // ⟳ ↻ 重试/旋转
  faDownload, // ⤓ 提取（下载到记忆）
  faArrowLeft, // ◀ 关闭面板
  faArrowRight, // -> 关闭面板
  faArrowUp, // ↑ 发送（上箭头）
  faPaperclip, // 📎 附件上传
  faWrench, // 🔧 通用工具
  faCode, // </> 代码
  faCodePullRequest, // 🔀 diff
  faBrain, // 🧠 思考
  faLightbulb, // 💡 思考(灯泡)
  faServer, // 🗄 provider/服务器
  faUsers, // 👥 子 agent 群组
  faMemory, // 💾 记忆系统
  faRobot, // 🤖 助手
  faPlay, // ▶ 发送/运行
  faStop, // 中止
  faArrowRightFromBracket, // 发送
  faPaperPlane, // 纸飞机发送
  faFloppyDisk, // 💾 保存
  faPlus, // + 新增
  faMinus, // − 减少
  faPenToSquare, // 编辑
  faTrash, // 删除
  faShieldHalved, // 沙箱
  faUnlock, // 权限：允许所有
  faHand, // 权限：逐条审批
  faSpinner, // 加载中
  faCircleInfo, // ℹ 信息
  faTriangleExclamation, // ⚠ 警告
  faFile, // 通用文件
  faImage, // 图片
  faUser, // 用户
  faCodeBranch, // 分支
  faTag, // 书签/标签
  faHeading, // 标题
  faCube, // custom 数据
  faCompress, // 压缩
  faRotate, // 模型变更/重试
  faReply, // 工具结果回填
  faCopy, // 复制
  faEye, // 眼睛 显示密码
  faEyeSlash, // 眼睛划线 隐藏密码
  faClipboardList, // 计划模式
  faComment, // 💬 批注
  faPencil, // ✏️ 选中后加批注
  faBolt, // 标准模式
  faListCheck, // todo 清单
  faBullseye, // 目标模式
  faPause, // 暂停(goal)
  faCircleCheck, // 完成(goal)
  faCircleExclamation, // 阻塞/警告(goal)
  faSort, // 排序
  faGripVertical, // 拖拽排序把手（排队消息）
  faClock, // 时钟(创建时间排序)
  faArrowDownAZ, // 名称排序
  faEllipsisVertical, // ⋮ 三点菜单(项目操作)
  faAnchor, // ⚓ 生命周期钩子
  faBarsProgress, // 后台任务
  faSearch, // 搜索
  faGlobe, // 浏览器
  faArrowRotateRight, // 刷新
  faArrowUpRightFromSquare, // 外部打开
  faHouse, // 主页/空白页
  faExpand, // 右侧工作区最大化
  faDownLeftAndUpRightToCenter, // 退出右侧工作区最大化
  faScaleBalanced, // 决策模型（classifier）
  faScroll // 日志
} from '@fortawesome/free-solid-svg-icons';

export const icons = {
  calendar: faCalendarDays,
  // 工具图标
  read: faFileLines,
  edit: faPen,
  write: faFilePen,
  bash: faTerminal,
  grep: faMagnifyingGlass,
  find: faMagnifyingGlass,
  ls: faFolderOpen,
  tool: faWrench,

  // UI 操作
  back: faArrowLeft,
  settings: faGear,
  sun: faSun,
  statistics: faChartLine,
  close: faXmark,
  delete: faTrash,
  edit2: faPenToSquare,
  plus: faPlus,
  minus: faMinus,
  save: faFloppyDisk,
  send: faArrowUp,
  abort: faStop,
  upload: faPaperclip,
  tree: faFolderTree,
  folder: faFolderOpen,
  file: faFile,
  image: faImage,
  user: faUser,
  terminal: faTerminal,
  branch: faCodeBranch,
  tag: faTag,
  heading: faHeading,
  cube: faCube,
  compress: faCompress,
  rotate: faRotate,
  reply: faReply,
  copy: faCopy,
  eye: faEye,
  eyeSlash: faEyeSlash,
  code: faCode,
  diff: faCodePullRequest,
  foldingPanel: faArrowRight,
  clipboardList: faClipboardList,
  comment: faComment,
  pencil: faPencil,
  bolt: faBolt,
  todo: faListCheck,
  target: faBullseye,
  continue: faPlay,
  pause: faPause,
  circleCheck: faCircleCheck,
  circleExclamation: faCircleExclamation,
  sort: faSort,
  gripVertical: faGripVertical,
  clock: faClock,
  sortAlpha: faArrowDownAZ,

  // 状态
  chevronDown: faChevronDown,
  chevronRight: faChevronRight,
  chevronLeft: faChevronLeft,
  check: faCheck,
  cross: faCross,
  circle: faCircle,
  spinner: faCircleNotch,
  retry: faCircleNotch,
  memory: faMemory,
  download: faDownload,
  brain: faBrain,
  lightbulb: faLightbulb,
  robot: faRobot,
  shield: faShieldHalved,
  unlock: faUnlock,
  hand: faHand,
  info: faCircleInfo,
  warning: faTriangleExclamation,
  ellipsisVertical: faEllipsisVertical,
  server: faServer,
  agents: faUsers,
  backgroundTasks: faBarsProgress,
  stop: faStop,
  hook: faAnchor,
  search: faSearch,
  browser: faGlobe,
  refresh: faArrowRotateRight,
  external: faArrowUpRightFromSquare,
  home: faHouse,
  forward: faArrowRight,
  expand: faExpand,
  restore: faDownLeftAndUpRightToCenter,
  classifier: faScaleBalanced,
  logs: faScroll
};

export type IconName = keyof typeof icons;
