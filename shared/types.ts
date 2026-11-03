import type { SshConnectOptions, SshHop, SshHopInput } from './ssh-options'

export type ForwardType = 'local' | 'remote'

/**
 * 一条端口映射规则。local 对应 ssh -L，remote 对应 ssh -R。
 * IP 不写死进配置：监听和另一头都固定 127.0.0.1，用户只填端口。
 */
export interface ForwardRule {
  type: ForwardType
  listenPort: number
  targetPort: number
}

/** 会话配置：一条正向 SSH 连接（secret 不落盘在本结构里，单独加密存储）。密码登录，或用本机密钥。 */
export interface SessionConfig {
  id: string
  /** 助手用来查找的编号，conn- 开头。改名不换。 */
  publicId: string
  name: string
  /** 分组名（侧边栏文件夹），空字符串表示未分组 */
  group: string
  host: string
  port: number
  username: string
  remark?: string
  /** 是否已保存加密凭据（密码） */
  hasSecret: boolean
  /** 按系统 ssh 的默认私钥登录，不需要密码 */
  useKey?: boolean
  /** 按本机到目标主机的顺序排列的跳板；空表示直接连接。 */
  jumps?: SshHop[]
  /** 命令里带的超时、算法、ProxyCommand。 */
  sshOptions?: SshConnectOptions
  /** 端口映射规则，连接建立后挂在共享 SSH 连接上 */
  forwards?: ForwardRule[]
  /** 探测到的对端系统/发行版（如 debian、windows），用于连接列表图标。 */
  os?: string
  createdAt: number
  updatedAt: number
}

/** 创建/更新会话时的输入，secret 为明文，仅在 IPC 调用内存中短暂存在 */
export interface SessionInput {
  name: string
  group: string
  host: string
  port: number
  username: string
  remark?: string
  /** 明文密码；undefined 表示不修改 */
  secret?: string
  /** 是否改用本机密钥。undefined 表示不修改 */
  useKey?: boolean
  /** 按本机到目标主机的顺序排列的跳板。undefined 表示不修改，空数组表示清掉。 */
  jumps?: SshHopInput[]
  /** 连接选项。undefined 表示不修改，null 表示清掉。 */
  sshOptions?: SshConnectOptions | null
  /** 端口映射。undefined 表示不修改，否则整体替换（空数组表示清掉）。 */
  forwards?: ForwardRule[]
}

export type SessionStatus = 'disconnected' | 'connecting' | 'connected'

export type TabKind = 'ssh' | 'local'

/** 标签页左图标的操作系统种类。unknown 是还没探测完或认不出。 */
export type OsKind = 'windows' | 'linux' | 'macos' | 'unknown'

/** 对端系统探测结果。distro 是 /etc/os-release 的 ID 小写（如 debian、rhel），认不出就省略。 */
export interface OsInfo {
  os: OsKind
  distro?: string
}

/** 运维面板的一次动态采集快照，字段与 Go 端 sshx.ServerMetrics 一一对应。 */
export interface ServerMetrics {
  uptimeSec: number
  cores: number
  cpuPercent: number
  load1: number
  load5: number
  load15: number
  /** 字节 */
  memTotal: number
  /** 字节 */
  memAvail: number
  disks: DiskUsage[]
  procs: ProcInfo[]
  /** 本机正在监听的端口（TCP LISTEN 与 UDP），按端口升序 */
  ports: PortInfo[]
  /** 真实网卡合计的收发速度，字节/秒。不含回环和容器、虚拟机的虚拟网卡 */
  netRxBps: number
  netTxBps: number
  /** 毫秒时间戳 */
  collectedAt: number
}

/** 服务器的静态身份，与 Go 端 sshx.ServerInfo 对应。外网 IP 拿不到时是空串。 */
export interface ServerInfo {
  hostname: string
  osPretty: string
  kernel: string
  lanIps: string[]
  wanIp: string
}

/** 一次 Docker 采集，与 Go 端 sshx.DockerInfo 对应。available 为假表示没装 docker。 */
export interface DockerInfo {
  available: boolean
  /** 装了不等于在跑：daemon 活着（docker info 能通）才是 true */
  running: boolean
  containers: DockerContainer[]
  images: DockerImage[]
  volumes: DockerVolume[]
  networks: DockerNetwork[]
  /** /etc/docker/daemon.json 原文；没装 docker 或文件不存在时是空串 */
  daemonJson: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  /** running / exited 等原始状态 */
  state: string
  /** 人读格式：Up 2 hours / Exited (0) 3 days ago */
  status: string
  ports: string
}

export interface DockerImage {
  repository: string
  tag: string
  id: string
  /** 人读格式：187MB */
  size: string
  /** 人读格式：2 weeks ago */
  created: string
}

export interface DockerVolume {
  name: string
  driver: string
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
  /** local / swarm / global */
  scope: string
}

/** 一次网站服务采集，与 Go 端 sshx.WebInfo 对应。网站服务一律容器化（固定容器名
    nginx/caddy），宿主机直装的不管。dockerAvailable 为假表示服务器没装 docker。 */
export interface WebInfo {
  dockerAvailable: boolean
  nginx: WebServiceInfo
  caddy: WebServiceInfo
  /** 各域名证书的剩余有效天数（nginx 的；caddy 自动续不跟踪）。负数 = 已过期 */
  certs: Record<string, number>
}

export interface WebServiceInfo {
  /** 容器状态：running / exited 等；空串 = 还没装 */
  state: string
  /** 配置文件列表（路径 + 原文）；空 = 一个配置文件都没有 */
  files: WebConfFile[]
}

export interface WebConfFile {
  path: string
  /** 空串 = 文件存在但内容是空的 */
  content: string
}

/** 一条 crontab 条目，与 Go 端 sshx.CronEntry 对应。ours=true 是面板建的（行尾有标记），
    可以删；其余是用户自己手写的，只展示。 */
export interface CronEntry {
  /** 面板建的才有（标记里的 id），原有条目为空串 */
  id: string
  /** 面板建的带脚本名（标记里的名字），空串则显示 command 原文 */
  name: string
  /** 五段表达式原文或 @daily 这类关键字 */
  schedule: string
  command: string
  ours: boolean
}

/** 一个挂载点的用量，字节数 */
export interface DiskUsage {
  mount: string
  total: number
  used: number
  usePercent: number
}

/** 一条进程。rss 是字节数；name 是命令首词的 basename，cmd 是完整命令行。 */
export interface ProcInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  rss: number
  name: string
  cmd: string
}

/** 一个监听端口。非 root 采集时其他进程的 pid / name 可能拿不到，分别为 0 和空串。
    cmd 是完整命令行、exe 是可执行文件路径，用来区分同名程序，读不到时为空串。 */
export interface PortInfo {
  /** tcp / udp */
  proto: string
  /** 监听地址：0.0.0.0、127.0.0.1、[::] 等 */
  addr: string
  port: number
  pid: number
  name: string
  /** /proc/<pid>/cmdline 完整命令行 */
  cmd: string
  /** readlink /proc/<pid>/exe 可执行文件路径 */
  exe: string
}

export interface Tab {
  id: string
  /** ssh 标签对应会话 id；本地终端为 null */
  sessionId: string | null
  kind: TabKind
  /** 标签上的标题，例如「PowerShell (1)」「web (2)」。用户改过名则是改过的那句。 */
  title: string
  /** 助手写的备注，帮助以后认出这扇窗口在做什么。 */
  remark?: string
  /** 对端操作系统，决定标签左边的图标。本机终端按本机系统，SSH 连接后探测一次。 */
  os?: OsKind
  /** kind = local 时的壳类型，决定标签名字和图标 */
  shell?: LocalShell
  /** 发行版 id（如 debian），优先于 os 决定标签图标。 */
  distro?: string
}

/** 创建终端的请求（renderer → main） */
/** 本机终端的壳类型。 */
export type LocalShell = 'powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl'

/** 探测到的一个本机壳。 */
export interface LocalShellInfo {
  id: LocalShell
  label: string
  exe: string
}

export interface TermCreateOptions {
  /** 终端 id，与标签页 id 一致 */
  termId: string
  kind: TabKind
  /** kind = ssh 时必填 */
  sessionId?: string
  /** 标签标题，例如「PowerShell (1)」「web (2)」 */
  title?: string
  /** kind = local 时的壳类型，缺省 powershell */
  shell?: LocalShell
  /** 本机终端的起始目录。空则用用户主目录 */
  cwd?: string
  cols: number
  rows: number
}

/** 终端标题或备注变了（main → renderer） */
export interface TermMetaEvent {
  termId: string
  title: string
  remark: string
}

/** 终端状态推送（main → renderer） */
export interface TermStatusEvent {
  termId: string
  sessionId: string | null
  status: SessionStatus | 'error'
  error?: string
}

/** 终端数据推送（main → renderer） */
export interface TermDataEvent {
  termId: string
  data: Uint8Array
}

/** SFTP 目录项 */
export interface RemoteFile {
  name: string
  path: string
  kind: 'dir' | 'file' | 'link'
  size: number
  mtime: number
}

/** 远程安装 SFTP 时推给界面的进度 */
export interface SftpInstallEvent {
  sessionId: string
  phase: 'start' | 'log' | 'done' | 'error'
  text: string
}

/** 文件上传/下载的传输进度（main → renderer）。done 后界面留几秒再移除。 */
export interface SftpTransferEvent {
  id: string
  sessionId: string
  direction: 'up' | 'down'
  name: string
  transferred: number
  total: number
  done: boolean
  error?: string
}

/** MCP 只监听本机回环，不允许改成其他地址 */
export const MCP_HOST = '127.0.0.1'
export const MCP_DEFAULT_PORT = 3927

/** 已保存的 MCP 服务端配置。token 要给用户复制到 Codex / Kimi Code，所以设置页能读到明文。 */
export interface McpSettings {
  enabled: boolean
  host: typeof MCP_HOST
  port: number
  token: string
  /** 危险操作先弹窗，等人确认后再执行 */
  confirmDangerous: boolean
}

/** 监听进程的当前状态，不写入数据库 */
export interface McpRuntime {
  running: boolean
  port: number
  clients: number
  error?: string
}

/** Agent 打开终端标签。本地终端没有 sessionId */
export interface McpOpenTab {
  termId: string
  sessionId: string | null
  title: string
  kind: 'ssh' | 'local'
}

export interface McpAuditEntry {
  at: number
  tool: string
  ok: boolean
  detail: string
}

/** 危险命令确认 */
export interface McpConfirmRequest {
  id: string
  command: string
}

/** 页面里终端视图的矩形，单位是 CSS 像素 */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureRun {
  id: string
  termId: string
  mode: 'viewport' | 'scrollback'
  /** 缓冲行号，含首含尾。0 是最旧的一行。 */
  startLine?: number
  endLine?: number
  /** 只要裁好的那一段，不附带整屏原图 */
  cropOnly?: boolean
}

export interface TermLinesRun {
  id: string
  termId: string
  startLine?: number
  endLine?: number
}

export interface TermLinesReply {
  id: string
  error?: string
  length?: number
  viewportY?: number
  rows?: number
  lines?: { n: number; text: string }[]
}

export interface TermModeRun {
  id: string
  termId: string
}

export interface TermModeReply {
  id: string
  applicationCursor?: boolean
  error?: string
}

export interface CaptureReply {
  id: string
  paths?: string[]
  note?: string
  error?: string
}

export interface McpSettingsInput {
  enabled: boolean
  port: number
  token: string
  confirmDangerous: boolean
}

/** 终端配色。统一主题里引用这里的 id，和主题 id 一一对应。 */
export const TERMINAL_THEMES = [
  'termius-dark',
  'termius-light',
  'flexoki-dark',
  'flexoki-light',
  'kanagawa-wave',
  'kanagawa-dragon',
  'kanagawa-lotus',
  'hacker-blue',
  'hacker-green',
  'hacker-red',
  'everforest-dark',
  'everforest-light',
  'night-owl',
  'light-owl',
  'aura',
  'rose-pine',
  'rose-pine-moon',
  'rose-pine-dawn',
  'cobalt2',
  'octocat-dark',
  'octocat-light',
  'ayu-dark',
  'ayu-light',
  'cyberpunk',
  'cyberpunk-scarlet',
  'romania-night',
  'romania-day',
  'aubergine',
  'peach-fresh',
  '1984-dark',
  '1984-light',
  'winter-night',
  'winter-day',
  'tokyo-night',
  'tokyo-day',
  'catppuccin-latte',
  'catppuccin-mocha',
  'diwali',
  'movember',
  'atom-one-dark',
  'atom-one-light',
  'halloween',
  'dia-de-muertos',
  'gruvbox-dark',
  'gruvbox-light',
  'material-dark',
  'material-light',
  'manhattan',
  'plastic-world',
  'basic',
  'homebrew',
  'grass',
  'man-page',
  'novel',
  'ocean',
  'pro',
  'red-sands',
  'solarized-dark',
  'solarized-light',
  'silver-aerogel',
  'dracula',
  'monokai',
  'nord-light',
  'nord-dark'
] as const
export type TerminalThemeId = (typeof TERMINAL_THEMES)[number]

/**
 * 统一主题：整套界面配色（shadcn CSS 变量）+ 终端配色绑成一项，整个窗口一起换色。
 * ui 的推导原则：底色取终端 background，文字取 foreground，卡片/弹出层比底色亮一档，
 * muted/accent 亮两档，边框用前景色 10–15% 透明度（浅色主题用同色系实色），
 * 强调色用主题标志色，危险色用主题红。
 */
export interface UnifiedTheme {
  id: string
  label: string
  dark: boolean
  terminal: TerminalThemeId
  ui: Record<string, string>
}

export const UNIFIED_THEMES: UnifiedTheme[] = [
  {
    id: 'termius-dark',
    label: 'Termius Dark',
    dark: true,
    terminal: 'termius-dark',
    ui: {
      '--background': '#141729',
      '--foreground': '#21b568',
      '--card': '#1d2032',
      '--card-foreground': '#21b568',
      '--popover': '#1d2032',
      '--popover-foreground': '#21b568',
      '--primary': '#21b568',
      '--primary-foreground': '#141729',
      '--secondary': '#272a3a',
      '--secondary-foreground': '#21b568',
      '--muted': '#272a3a',
      '--muted-foreground': '#8d91a5',
      '--accent': '#2e3141',
      '--accent-foreground': '#21b568',
      '--destructive': '#f24e50',
      '--border': '#21b5681f',
      '--input': '#21b56826',
      '--ring': '#21b568',
      '--sidebar': '#141729',
      '--sidebar-foreground': '#21b568',
      '--sidebar-primary': '#21b568',
      '--sidebar-primary-foreground': '#141729',
      '--sidebar-accent': '#2e3141',
      '--sidebar-accent-foreground': '#21b568',
      '--sidebar-border': '#21b5681f',
      '--sidebar-ring': '#21b568'
    }
  },
  {
    id: 'termius-light',
    label: 'Termius Light',
    dark: false,
    terminal: 'termius-light',
    ui: {
      '--background': '#d5dde0',
      '--foreground': '#32364a',
      '--card': '#ccd4d7',
      '--card-foreground': '#32364a',
      '--popover': '#ccd4d7',
      '--popover-foreground': '#32364a',
      '--primary': '#32364a',
      '--primary-foreground': '#d5dde0',
      '--secondary': '#c4cbce',
      '--secondary-foreground': '#32364a',
      '--muted': '#c4cbce',
      '--muted-foreground': '#6c797e',
      '--accent': '#bec5c7',
      '--accent-foreground': '#32364a',
      '--destructive': '#f24e50',
      '--border': '#32364a1f',
      '--input': '#32364a26',
      '--ring': '#32364a',
      '--sidebar': '#d5dde0',
      '--sidebar-foreground': '#32364a',
      '--sidebar-primary': '#32364a',
      '--sidebar-primary-foreground': '#d5dde0',
      '--sidebar-accent': '#bec5c7',
      '--sidebar-accent-foreground': '#32364a',
      '--sidebar-border': '#32364a1f',
      '--sidebar-ring': '#32364a'
    }
  },
  {
    id: 'flexoki-dark',
    label: 'Flexoki Dark',
    dark: true,
    terminal: 'flexoki-dark',
    ui: {
      '--background': '#100f0f',
      '--foreground': '#cecdc3',
      '--card': '#1a1919',
      '--card-foreground': '#cecdc3',
      '--popover': '#1a1919',
      '--popover-foreground': '#cecdc3',
      '--primary': '#cecdc3',
      '--primary-foreground': '#100f0f',
      '--secondary': '#232222',
      '--secondary-foreground': '#cecdc3',
      '--muted': '#232222',
      '--muted-foreground': '#888781',
      '--accent': '#2a2929',
      '--accent-foreground': '#cecdc3',
      '--destructive': '#af3029',
      '--border': '#cecdc31f',
      '--input': '#cecdc326',
      '--ring': '#cecdc3',
      '--sidebar': '#100f0f',
      '--sidebar-foreground': '#cecdc3',
      '--sidebar-primary': '#cecdc3',
      '--sidebar-primary-foreground': '#100f0f',
      '--sidebar-accent': '#2a2929',
      '--sidebar-accent-foreground': '#cecdc3',
      '--sidebar-border': '#cecdc31f',
      '--sidebar-ring': '#cecdc3'
    }
  },
  {
    id: 'flexoki-light',
    label: 'Flexoki Light',
    dark: false,
    terminal: 'flexoki-light',
    ui: {
      '--background': '#fffcf0',
      '--foreground': '#100f0f',
      '--card': '#f5f2e6',
      '--card-foreground': '#100f0f',
      '--popover': '#f5f2e6',
      '--popover-foreground': '#100f0f',
      '--primary': '#100f0f',
      '--primary-foreground': '#fffcf0',
      '--secondary': '#ebe8dd',
      '--secondary-foreground': '#100f0f',
      '--muted': '#ebe8dd',
      '--muted-foreground': '#878580',
      '--accent': '#e3e0d6',
      '--accent-foreground': '#100f0f',
      '--destructive': '#d14d41',
      '--border': '#100f0f1f',
      '--input': '#100f0f26',
      '--ring': '#100f0f',
      '--sidebar': '#fffcf0',
      '--sidebar-foreground': '#100f0f',
      '--sidebar-primary': '#100f0f',
      '--sidebar-primary-foreground': '#fffcf0',
      '--sidebar-accent': '#e3e0d6',
      '--sidebar-accent-foreground': '#100f0f',
      '--sidebar-border': '#100f0f1f',
      '--sidebar-ring': '#100f0f'
    }
  },
  {
    id: 'kanagawa-wave',
    label: 'Kanagawa Wave',
    dark: true,
    terminal: 'kanagawa-wave',
    ui: {
      '--background': '#1f1f28',
      '--foreground': '#dcd7ba',
      '--card': '#282831',
      '--card-foreground': '#dcd7ba',
      '--popover': '#282831',
      '--popover-foreground': '#dcd7ba',
      '--primary': '#c8c093',
      '--primary-foreground': '#1f1f28',
      '--secondary': '#313139',
      '--secondary-foreground': '#dcd7ba',
      '--muted': '#313139',
      '--muted-foreground': '#88928a',
      '--accent': '#383840',
      '--accent-foreground': '#dcd7ba',
      '--destructive': '#c34043',
      '--border': '#dcd7ba1f',
      '--input': '#dcd7ba26',
      '--ring': '#c8c093',
      '--sidebar': '#1f1f28',
      '--sidebar-foreground': '#dcd7ba',
      '--sidebar-primary': '#c8c093',
      '--sidebar-primary-foreground': '#1f1f28',
      '--sidebar-accent': '#383840',
      '--sidebar-accent-foreground': '#dcd7ba',
      '--sidebar-border': '#dcd7ba1f',
      '--sidebar-ring': '#c8c093'
    }
  },
  {
    id: 'kanagawa-dragon',
    label: 'Kanagawa Dragon',
    dark: true,
    terminal: 'kanagawa-dragon',
    ui: {
      '--background': '#181616',
      '--foreground': '#c5c9c5',
      '--card': '#211f1f',
      '--card-foreground': '#c5c9c5',
      '--popover': '#211f1f',
      '--popover-foreground': '#c5c9c5',
      '--primary': '#c8c093',
      '--primary-foreground': '#181616',
      '--secondary': '#2a2929',
      '--secondary-foreground': '#c5c9c5',
      '--muted': '#2a2929',
      '--muted-foreground': '#88928a',
      '--accent': '#313030',
      '--accent-foreground': '#c5c9c5',
      '--destructive': '#c4746e',
      '--border': '#c5c9c51f',
      '--input': '#c5c9c526',
      '--ring': '#c8c093',
      '--sidebar': '#181616',
      '--sidebar-foreground': '#c5c9c5',
      '--sidebar-primary': '#c8c093',
      '--sidebar-primary-foreground': '#181616',
      '--sidebar-accent': '#313030',
      '--sidebar-accent-foreground': '#c5c9c5',
      '--sidebar-border': '#c5c9c51f',
      '--sidebar-ring': '#c8c093'
    }
  },
  {
    id: 'kanagawa-lotus',
    label: 'Kanagawa Lotus',
    dark: false,
    terminal: 'kanagawa-lotus',
    ui: {
      '--background': '#f2ecbc',
      '--foreground': '#545464',
      '--card': '#e8e3b4',
      '--card-foreground': '#545464',
      '--popover': '#e8e3b4',
      '--popover-foreground': '#545464',
      '--primary': '#43436c',
      '--primary-foreground': '#f2ecbc',
      '--secondary': '#dfd9ad',
      '--secondary-foreground': '#545464',
      '--muted': '#dfd9ad',
      '--muted-foreground': '#88928a',
      '--accent': '#d7d2a7',
      '--accent-foreground': '#545464',
      '--destructive': '#c84053',
      '--border': '#5454641f',
      '--input': '#54546426',
      '--ring': '#43436c',
      '--sidebar': '#f2ecbc',
      '--sidebar-foreground': '#545464',
      '--sidebar-primary': '#43436c',
      '--sidebar-primary-foreground': '#f2ecbc',
      '--sidebar-accent': '#d7d2a7',
      '--sidebar-accent-foreground': '#545464',
      '--sidebar-border': '#5454641f',
      '--sidebar-ring': '#43436c'
    }
  },
  {
    id: 'hacker-blue',
    label: 'Hacker Blue',
    dark: true,
    terminal: 'hacker-blue',
    ui: {
      '--background': '#010515',
      '--foreground': '#11b7ff',
      '--card': '#0b0f1e',
      '--card-foreground': '#11b7ff',
      '--popover': '#0b0f1e',
      '--popover-foreground': '#11b7ff',
      '--primary': '#10b6ff',
      '--primary-foreground': '#010515',
      '--secondary': '#151928',
      '--secondary-foreground': '#11b7ff',
      '--muted': '#151928',
      '--muted-foreground': '#2c71a4',
      '--accent': '#1d212f',
      '--accent-foreground': '#11b7ff',
      '--destructive': '#0d7eaf',
      '--border': '#11b7ff1f',
      '--input': '#11b7ff26',
      '--ring': '#10b6ff',
      '--sidebar': '#010515',
      '--sidebar-foreground': '#11b7ff',
      '--sidebar-primary': '#10b6ff',
      '--sidebar-primary-foreground': '#010515',
      '--sidebar-accent': '#1d212f',
      '--sidebar-accent-foreground': '#11b7ff',
      '--sidebar-border': '#11b7ff1f',
      '--sidebar-ring': '#10b6ff'
    }
  },
  {
    id: 'hacker-green',
    label: 'Hacker Green',
    dark: true,
    terminal: 'hacker-green',
    ui: {
      '--background': '#020f01',
      '--foreground': '#16b10e',
      '--card': '#0c190b',
      '--card-foreground': '#16b10e',
      '--popover': '#0c190b',
      '--popover-foreground': '#16b10e',
      '--primary': '#15d00d',
      '--primary-foreground': '#020f01',
      '--secondary': '#162215',
      '--secondary-foreground': '#16b10e',
      '--muted': '#162215',
      '--muted-foreground': '#2ca43f',
      '--accent': '#1e291d',
      '--accent-foreground': '#16b10e',
      '--destructive': '#14af0d',
      '--border': '#16b10e1f',
      '--input': '#16b10e26',
      '--ring': '#15d00d',
      '--sidebar': '#020f01',
      '--sidebar-foreground': '#16b10e',
      '--sidebar-primary': '#15d00d',
      '--sidebar-primary-foreground': '#020f01',
      '--sidebar-accent': '#1e291d',
      '--sidebar-accent-foreground': '#16b10e',
      '--sidebar-border': '#16b10e1f',
      '--sidebar-ring': '#15d00d'
    }
  },
  {
    id: 'hacker-red',
    label: 'Hacker Red',
    dark: true,
    terminal: 'hacker-red',
    ui: {
      '--background': '#200000',
      '--foreground': '#b10e0e',
      '--card': '#290a0a',
      '--card-foreground': '#b10e0e',
      '--popover': '#290a0a',
      '--popover-foreground': '#b10e0e',
      '--primary': '#b00d0d',
      '--primary-foreground': '#200000',
      '--secondary': '#321414',
      '--secondary-foreground': '#b10e0e',
      '--muted': '#321414',
      '--muted-foreground': '#a42c2c',
      '--accent': '#391c1c',
      '--accent-foreground': '#b10e0e',
      '--destructive': '#b00d0d',
      '--border': '#b10e0e1f',
      '--input': '#b10e0e26',
      '--ring': '#b00d0d',
      '--sidebar': '#200000',
      '--sidebar-foreground': '#b10e0e',
      '--sidebar-primary': '#b00d0d',
      '--sidebar-primary-foreground': '#200000',
      '--sidebar-accent': '#391c1c',
      '--sidebar-accent-foreground': '#b10e0e',
      '--sidebar-border': '#b10e0e1f',
      '--sidebar-ring': '#b00d0d'
    }
  },
  {
    id: 'everforest-dark',
    label: 'Everforest Dark',
    dark: true,
    terminal: 'everforest-dark',
    ui: {
      '--background': '#282e32',
      '--foreground': '#d3c6aa',
      '--card': '#31363a',
      '--card-foreground': '#d3c6aa',
      '--popover': '#31363a',
      '--popover-foreground': '#d3c6aa',
      '--primary': '#d3c6aa',
      '--primary-foreground': '#282e32',
      '--secondary': '#393f42',
      '--secondary-foreground': '#d3c6aa',
      '--muted': '#393f42',
      '--muted-foreground': '#88928a',
      '--accent': '#404549',
      '--accent-foreground': '#d3c6aa',
      '--destructive': '#a1484a',
      '--border': '#d3c6aa1f',
      '--input': '#d3c6aa26',
      '--ring': '#d3c6aa',
      '--sidebar': '#282e32',
      '--sidebar-foreground': '#d3c6aa',
      '--sidebar-primary': '#d3c6aa',
      '--sidebar-primary-foreground': '#282e32',
      '--sidebar-accent': '#404549',
      '--sidebar-accent-foreground': '#d3c6aa',
      '--sidebar-border': '#d3c6aa1f',
      '--sidebar-ring': '#d3c6aa'
    }
  },
  {
    id: 'everforest-light',
    label: 'Everforest Light',
    dark: false,
    terminal: 'everforest-light',
    ui: {
      '--background': '#fefbf1',
      '--foreground': '#5c6a72',
      '--card': '#f4f1e7',
      '--card-foreground': '#5c6a72',
      '--popover': '#f4f1e7',
      '--popover-foreground': '#5c6a72',
      '--primary': '#5c6a72',
      '--primary-foreground': '#fefbf1',
      '--secondary': '#eae7de',
      '--secondary-foreground': '#5c6a72',
      '--muted': '#eae7de',
      '--muted-foreground': '#959f92',
      '--accent': '#e2dfd6',
      '--accent-foreground': '#5c6a72',
      '--destructive': '#d2413e',
      '--border': '#5c6a721f',
      '--input': '#5c6a7226',
      '--ring': '#5c6a72',
      '--sidebar': '#fefbf1',
      '--sidebar-foreground': '#5c6a72',
      '--sidebar-primary': '#5c6a72',
      '--sidebar-primary-foreground': '#fefbf1',
      '--sidebar-accent': '#e2dfd6',
      '--sidebar-accent-foreground': '#5c6a72',
      '--sidebar-border': '#5c6a721f',
      '--sidebar-ring': '#5c6a72'
    }
  },
  {
    id: 'night-owl',
    label: 'Night Owl',
    dark: true,
    terminal: 'night-owl',
    ui: {
      '--background': '#011627',
      '--foreground': '#d6deeb',
      '--card': '#0b1f30',
      '--card-foreground': '#d6deeb',
      '--popover': '#0b1f30',
      '--popover-foreground': '#d6deeb',
      '--primary': '#80a4c2',
      '--primary-foreground': '#011627',
      '--secondary': '#152938',
      '--secondary-foreground': '#d6deeb',
      '--muted': '#152938',
      '--muted-foreground': '#6d90ad',
      '--accent': '#1d303f',
      '--accent-foreground': '#d6deeb',
      '--destructive': '#ef5350',
      '--border': '#d6deeb1f',
      '--input': '#d6deeb26',
      '--ring': '#80a4c2',
      '--sidebar': '#011627',
      '--sidebar-foreground': '#d6deeb',
      '--sidebar-primary': '#80a4c2',
      '--sidebar-primary-foreground': '#011627',
      '--sidebar-accent': '#1d303f',
      '--sidebar-accent-foreground': '#d6deeb',
      '--sidebar-border': '#d6deeb1f',
      '--sidebar-ring': '#80a4c2'
    }
  },
  {
    id: 'light-owl',
    label: 'Light Owl',
    dark: false,
    terminal: 'light-owl',
    ui: {
      '--background': '#fbfbfb',
      '--foreground': '#403f53',
      '--card': '#f1f1f1',
      '--card-foreground': '#403f53',
      '--popover': '#f1f1f1',
      '--popover-foreground': '#403f53',
      '--primary': '#90a7b2',
      '--primary-foreground': '#fbfbfb',
      '--secondary': '#e7e7e7',
      '--secondary-foreground': '#403f53',
      '--muted': '#e7e7e7',
      '--muted-foreground': '#8898a4',
      '--accent': '#dfdfdf',
      '--accent-foreground': '#403f53',
      '--destructive': '#de3d3b',
      '--border': '#403f531f',
      '--input': '#403f5326',
      '--ring': '#90a7b2',
      '--sidebar': '#fbfbfb',
      '--sidebar-foreground': '#403f53',
      '--sidebar-primary': '#90a7b2',
      '--sidebar-primary-foreground': '#fbfbfb',
      '--sidebar-accent': '#dfdfdf',
      '--sidebar-accent-foreground': '#403f53',
      '--sidebar-border': '#403f531f',
      '--sidebar-ring': '#90a7b2'
    }
  },
  {
    id: 'aura',
    label: 'Aura',
    dark: true,
    terminal: 'aura',
    ui: {
      '--background': '#21202e',
      '--foreground': '#edecee',
      '--card': '#2a2936',
      '--card-foreground': '#edecee',
      '--popover': '#2a2936',
      '--popover-foreground': '#edecee',
      '--primary': '#edecee',
      '--primary-foreground': '#21202e',
      '--secondary': '#33323f',
      '--secondary-foreground': '#edecee',
      '--muted': '#33323f',
      '--muted-foreground': '#a6a2d7',
      '--accent': '#393945',
      '--accent-foreground': '#edecee',
      '--destructive': '#ff6767',
      '--border': '#edecee1f',
      '--input': '#edecee26',
      '--ring': '#edecee',
      '--sidebar': '#21202e',
      '--sidebar-foreground': '#edecee',
      '--sidebar-primary': '#edecee',
      '--sidebar-primary-foreground': '#21202e',
      '--sidebar-accent': '#393945',
      '--sidebar-accent-foreground': '#edecee',
      '--sidebar-border': '#edecee1f',
      '--sidebar-ring': '#edecee'
    }
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    dark: true,
    terminal: 'rose-pine',
    ui: {
      '--background': '#191724',
      '--foreground': '#e0def4',
      '--card': '#22202d',
      '--card-foreground': '#e0def4',
      '--popover': '#22202d',
      '--popover-foreground': '#e0def4',
      '--primary': '#e0def4',
      '--primary-foreground': '#191724',
      '--secondary': '#2b2a36',
      '--secondary-foreground': '#e0def4',
      '--muted': '#2b2a36',
      '--muted-foreground': '#858297',
      '--accent': '#32313c',
      '--accent-foreground': '#e0def4',
      '--destructive': '#be5d78',
      '--border': '#e0def41f',
      '--input': '#e0def426',
      '--ring': '#e0def4',
      '--sidebar': '#191724',
      '--sidebar-foreground': '#e0def4',
      '--sidebar-primary': '#e0def4',
      '--sidebar-primary-foreground': '#191724',
      '--sidebar-accent': '#32313c',
      '--sidebar-accent-foreground': '#e0def4',
      '--sidebar-border': '#e0def41f',
      '--sidebar-ring': '#e0def4'
    }
  },
  {
    id: 'rose-pine-moon',
    label: 'Rosé Pine Moon',
    dark: true,
    terminal: 'rose-pine-moon',
    ui: {
      '--background': '#232136',
      '--foreground': '#e0def4',
      '--card': '#2c2a3e',
      '--card-foreground': '#e0def4',
      '--popover': '#2c2a3e',
      '--popover-foreground': '#e0def4',
      '--primary': '#e0def4',
      '--primary-foreground': '#232136',
      '--secondary': '#353346',
      '--secondary-foreground': '#e0def4',
      '--muted': '#353346',
      '--muted-foreground': '#858297',
      '--accent': '#3b394c',
      '--accent-foreground': '#e0def4',
      '--destructive': '#be5d78',
      '--border': '#e0def41f',
      '--input': '#e0def426',
      '--ring': '#e0def4',
      '--sidebar': '#232136',
      '--sidebar-foreground': '#e0def4',
      '--sidebar-primary': '#e0def4',
      '--sidebar-primary-foreground': '#232136',
      '--sidebar-accent': '#3b394c',
      '--sidebar-accent-foreground': '#e0def4',
      '--sidebar-border': '#e0def41f',
      '--sidebar-ring': '#e0def4'
    }
  },
  {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    dark: false,
    terminal: 'rose-pine-dawn',
    ui: {
      '--background': '#faf4ed',
      '--foreground': '#575279',
      '--card': '#f0eae4',
      '--card-foreground': '#575279',
      '--popover': '#f0eae4',
      '--popover-foreground': '#575279',
      '--primary': '#575279',
      '--primary-foreground': '#faf4ed',
      '--secondary': '#e6e0da',
      '--secondary-foreground': '#575279',
      '--muted': '#e6e0da',
      '--muted-foreground': '#7d776f',
      '--accent': '#dfd9d3',
      '--accent-foreground': '#575279',
      '--destructive': '#b4637a',
      '--border': '#5752791f',
      '--input': '#57527926',
      '--ring': '#575279',
      '--sidebar': '#faf4ed',
      '--sidebar-foreground': '#575279',
      '--sidebar-primary': '#575279',
      '--sidebar-primary-foreground': '#faf4ed',
      '--sidebar-accent': '#dfd9d3',
      '--sidebar-accent-foreground': '#575279',
      '--sidebar-border': '#5752791f',
      '--sidebar-ring': '#575279'
    }
  },
  {
    id: 'cobalt2',
    label: 'Cobalt2',
    dark: true,
    terminal: 'cobalt2',
    ui: {
      '--background': '#132738',
      '--foreground': '#ffffff',
      '--card': '#1c3040',
      '--card-foreground': '#ffffff',
      '--popover': '#1c3040',
      '--popover-foreground': '#ffffff',
      '--primary': '#f0cc09',
      '--primary-foreground': '#132738',
      '--secondary': '#263848',
      '--secondary-foreground': '#ffffff',
      '--muted': '#263848',
      '--muted-foreground': '#8b9cab',
      '--accent': '#2d3f4e',
      '--accent-foreground': '#ffffff',
      '--destructive': '#ff0000',
      '--border': '#ffffff1f',
      '--input': '#ffffff26',
      '--ring': '#f0cc09',
      '--sidebar': '#132738',
      '--sidebar-foreground': '#ffffff',
      '--sidebar-primary': '#f0cc09',
      '--sidebar-primary-foreground': '#132738',
      '--sidebar-accent': '#2d3f4e',
      '--sidebar-accent-foreground': '#ffffff',
      '--sidebar-border': '#ffffff1f',
      '--sidebar-ring': '#f0cc09'
    }
  },
  {
    id: 'octocat-dark',
    label: 'Octocat Dark',
    dark: true,
    terminal: 'octocat-dark',
    ui: {
      '--background': '#101216',
      '--foreground': '#8b949e',
      '--card': '#1a1b1f',
      '--card-foreground': '#8b949e',
      '--popover': '#1a1b1f',
      '--popover-foreground': '#8b949e',
      '--primary': '#c9d1d9',
      '--primary-foreground': '#101216',
      '--secondary': '#232529',
      '--secondary-foreground': '#8b949e',
      '--muted': '#232529',
      '--muted-foreground': '#626873',
      '--accent': '#2a2c30',
      '--accent-foreground': '#8b949e',
      '--destructive': '#f78166',
      '--border': '#8b949e1f',
      '--input': '#8b949e26',
      '--ring': '#c9d1d9',
      '--sidebar': '#101216',
      '--sidebar-foreground': '#8b949e',
      '--sidebar-primary': '#c9d1d9',
      '--sidebar-primary-foreground': '#101216',
      '--sidebar-accent': '#2a2c30',
      '--sidebar-accent-foreground': '#8b949e',
      '--sidebar-border': '#8b949e1f',
      '--sidebar-ring': '#c9d1d9'
    }
  },
  {
    id: 'octocat-light',
    label: 'Octocat Light',
    dark: false,
    terminal: 'octocat-light',
    ui: {
      '--background': '#f4f4f4',
      '--foreground': '#3e3e3e',
      '--card': '#eaeaea',
      '--card-foreground': '#3e3e3e',
      '--popover': '#eaeaea',
      '--popover-foreground': '#3e3e3e',
      '--primary': '#3f3f3f',
      '--primary-foreground': '#f4f4f4',
      '--secondary': '#e0e0e0',
      '--secondary-foreground': '#3e3e3e',
      '--muted': '#e0e0e0',
      '--muted-foreground': '#a1a1a1',
      '--accent': '#d9d9d9',
      '--accent-foreground': '#3e3e3e',
      '--destructive': '#970b16',
      '--border': '#3e3e3e1f',
      '--input': '#3e3e3e26',
      '--ring': '#3f3f3f',
      '--sidebar': '#f4f4f4',
      '--sidebar-foreground': '#3e3e3e',
      '--sidebar-primary': '#3f3f3f',
      '--sidebar-primary-foreground': '#f4f4f4',
      '--sidebar-accent': '#d9d9d9',
      '--sidebar-accent-foreground': '#3e3e3e',
      '--sidebar-border': '#3e3e3e1f',
      '--sidebar-ring': '#3f3f3f'
    }
  },
  {
    id: 'ayu-dark',
    label: 'Ayu Dark',
    dark: true,
    terminal: 'ayu-dark',
    ui: {
      '--background': '#0f1419',
      '--foreground': '#e6e1cf',
      '--card': '#191d22',
      '--card-foreground': '#e6e1cf',
      '--popover': '#191d22',
      '--popover-foreground': '#e6e1cf',
      '--primary': '#f29718',
      '--primary-foreground': '#0f1419',
      '--secondary': '#22272b',
      '--secondary-foreground': '#e6e1cf',
      '--muted': '#22272b',
      '--muted-foreground': '#716f67',
      '--accent': '#292e32',
      '--accent-foreground': '#e6e1cf',
      '--destructive': '#ff3333',
      '--border': '#e6e1cf1f',
      '--input': '#e6e1cf26',
      '--ring': '#f29718',
      '--sidebar': '#0f1419',
      '--sidebar-foreground': '#e6e1cf',
      '--sidebar-primary': '#f29718',
      '--sidebar-primary-foreground': '#0f1419',
      '--sidebar-accent': '#292e32',
      '--sidebar-accent-foreground': '#e6e1cf',
      '--sidebar-border': '#e6e1cf1f',
      '--sidebar-ring': '#f29718'
    }
  },
  {
    id: 'ayu-light',
    label: 'Ayu Light',
    dark: false,
    terminal: 'ayu-light',
    ui: {
      '--background': '#fafafa',
      '--foreground': '#5c6773',
      '--card': '#f0f0f0',
      '--card-foreground': '#5c6773',
      '--popover': '#f0f0f0',
      '--popover-foreground': '#5c6773',
      '--primary': '#ff6a00',
      '--primary-foreground': '#fafafa',
      '--secondary': '#e6e6e6',
      '--secondary-foreground': '#5c6773',
      '--muted': '#e6e6e6',
      '--muted-foreground': '#a1a1a1',
      '--accent': '#dfdfdf',
      '--accent-foreground': '#5c6773',
      '--destructive': '#ff3333',
      '--border': '#5c67731f',
      '--input': '#5c677326',
      '--ring': '#ff6a00',
      '--sidebar': '#fafafa',
      '--sidebar-foreground': '#5c6773',
      '--sidebar-primary': '#ff6a00',
      '--sidebar-primary-foreground': '#fafafa',
      '--sidebar-accent': '#dfdfdf',
      '--sidebar-accent-foreground': '#5c6773',
      '--sidebar-border': '#5c67731f',
      '--sidebar-ring': '#ff6a00'
    }
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    dark: true,
    terminal: 'cyberpunk',
    ui: {
      '--background': '#332a57',
      '--foreground': '#e5e5e5',
      '--card': '#3b335e',
      '--card-foreground': '#e5e5e5',
      '--popover': '#3b335e',
      '--popover-foreground': '#e5e5e5',
      '--primary': '#21f6bc',
      '--primary-foreground': '#332a57',
      '--secondary': '#433b64',
      '--secondary-foreground': '#e5e5e5',
      '--muted': '#433b64',
      '--muted-foreground': '#8174b8',
      '--accent': '#494169',
      '--accent-foreground': '#e5e5e5',
      '--destructive': '#ff7092',
      '--border': '#e5e5e51f',
      '--input': '#e5e5e526',
      '--ring': '#21f6bc',
      '--sidebar': '#332a57',
      '--sidebar-foreground': '#e5e5e5',
      '--sidebar-primary': '#21f6bc',
      '--sidebar-primary-foreground': '#332a57',
      '--sidebar-accent': '#494169',
      '--sidebar-accent-foreground': '#e5e5e5',
      '--sidebar-border': '#e5e5e51f',
      '--sidebar-ring': '#21f6bc'
    }
  },
  {
    id: 'cyberpunk-scarlet',
    label: 'Cyberpunk Scarlet',
    dark: true,
    terminal: 'cyberpunk-scarlet',
    ui: {
      '--background': '#101116',
      '--foreground': '#ff0055',
      '--card': '#1a1b1f',
      '--card-foreground': '#ff0055',
      '--popover': '#1a1b1f',
      '--popover-foreground': '#ff0055',
      '--primary': '#00ffc8',
      '--primary-foreground': '#101116',
      '--secondary': '#232429',
      '--secondary-foreground': '#ff0055',
      '--muted': '#232429',
      '--muted-foreground': '#933f5b',
      '--accent': '#2a2b30',
      '--accent-foreground': '#ff0055',
      '--destructive': '#c5123d',
      '--border': '#ff00551f',
      '--input': '#ff005526',
      '--ring': '#00ffc8',
      '--sidebar': '#101116',
      '--sidebar-foreground': '#ff0055',
      '--sidebar-primary': '#00ffc8',
      '--sidebar-primary-foreground': '#101116',
      '--sidebar-accent': '#2a2b30',
      '--sidebar-accent-foreground': '#ff0055',
      '--sidebar-border': '#ff00551f',
      '--sidebar-ring': '#00ffc8'
    }
  },
  {
    id: 'romania-night',
    label: 'Romania Night',
    dark: true,
    terminal: 'romania-night',
    ui: {
      '--background': '#0b141f',
      '--foreground': '#f5f5ea',
      '--card': '#151d28',
      '--card-foreground': '#f5f5ea',
      '--popover': '#151d28',
      '--popover-foreground': '#f5f5ea',
      '--primary': '#f7d382',
      '--primary-foreground': '#0b141f',
      '--secondary': '#1f2731',
      '--secondary-foreground': '#f5f5ea',
      '--muted': '#1f2731',
      '--muted-foreground': '#8092a7',
      '--accent': '#262e38',
      '--accent-foreground': '#f5f5ea',
      '--destructive': '#b50011',
      '--border': '#f5f5ea1f',
      '--input': '#f5f5ea26',
      '--ring': '#f7d382',
      '--sidebar': '#0b141f',
      '--sidebar-foreground': '#f5f5ea',
      '--sidebar-primary': '#f7d382',
      '--sidebar-primary-foreground': '#0b141f',
      '--sidebar-accent': '#262e38',
      '--sidebar-accent-foreground': '#f5f5ea',
      '--sidebar-border': '#f5f5ea1f',
      '--sidebar-ring': '#f7d382'
    }
  },
  {
    id: 'romania-day',
    label: 'Romania Day',
    dark: false,
    terminal: 'romania-day',
    ui: {
      '--background': '#f5e8e7',
      '--foreground': '#632228',
      '--card': '#ebdfde',
      '--card-foreground': '#632228',
      '--popover': '#ebdfde',
      '--popover-foreground': '#632228',
      '--primary': '#d7b25e',
      '--primary-foreground': '#f5e8e7',
      '--secondary': '#e1d5d5',
      '--secondary-foreground': '#632228',
      '--muted': '#e1d5d5',
      '--muted-foreground': '#b29a98',
      '--accent': '#dacece',
      '--accent-foreground': '#632228',
      '--destructive': '#b50011',
      '--border': '#6322281f',
      '--input': '#63222826',
      '--ring': '#d7b25e',
      '--sidebar': '#f5e8e7',
      '--sidebar-foreground': '#632228',
      '--sidebar-primary': '#d7b25e',
      '--sidebar-primary-foreground': '#f5e8e7',
      '--sidebar-accent': '#dacece',
      '--sidebar-accent-foreground': '#632228',
      '--sidebar-border': '#6322281f',
      '--sidebar-ring': '#d7b25e'
    }
  },
  {
    id: 'aubergine',
    label: 'Aubergine',
    dark: true,
    terminal: 'aubergine',
    ui: {
      '--background': '#2c001e',
      '--foreground': '#eeeeec',
      '--card': '#340a27',
      '--card-foreground': '#eeeeec',
      '--popover': '#340a27',
      '--popover-foreground': '#eeeeec',
      '--primary': '#bbbbbb',
      '--primary-foreground': '#2c001e',
      '--secondary': '#3d1430',
      '--secondary-foreground': '#eeeeec',
      '--muted': '#3d1430',
      '--muted-foreground': '#b385a5',
      '--accent': '#431c37',
      '--accent-foreground': '#eeeeec',
      '--destructive': '#ae3120',
      '--border': '#eeeeec1f',
      '--input': '#eeeeec26',
      '--ring': '#bbbbbb',
      '--sidebar': '#2c001e',
      '--sidebar-foreground': '#eeeeec',
      '--sidebar-primary': '#bbbbbb',
      '--sidebar-primary-foreground': '#2c001e',
      '--sidebar-accent': '#431c37',
      '--sidebar-accent-foreground': '#eeeeec',
      '--sidebar-border': '#eeeeec1f',
      '--sidebar-ring': '#bbbbbb'
    }
  },
  {
    id: 'peach-fresh',
    label: 'Peach Fresh',
    dark: false,
    terminal: 'peach-fresh',
    ui: {
      '--background': '#f5c19e',
      '--foreground': '#520701',
      '--card': '#ebb998',
      '--card-foreground': '#520701',
      '--popover': '#ebb998',
      '--popover-foreground': '#520701',
      '--primary': '#b33a00',
      '--primary-foreground': '#f5c19e',
      '--secondary': '#e1b291',
      '--secondary-foreground': '#520701',
      '--muted': '#e1b291',
      '--muted-foreground': '#8a6851',
      '--accent': '#daac8d',
      '--accent-foreground': '#520701',
      '--destructive': '#cb4434',
      '--border': '#5207011f',
      '--input': '#52070126',
      '--ring': '#b33a00',
      '--sidebar': '#f5c19e',
      '--sidebar-foreground': '#520701',
      '--sidebar-primary': '#b33a00',
      '--sidebar-primary-foreground': '#f5c19e',
      '--sidebar-accent': '#daac8d',
      '--sidebar-accent-foreground': '#520701',
      '--sidebar-border': '#5207011f',
      '--sidebar-ring': '#b33a00'
    }
  },
  {
    id: '1984-dark',
    label: '1984 Dark',
    dark: true,
    terminal: '1984-dark',
    ui: {
      '--background': '#0d1030',
      '--foreground': '#dedee1',
      '--card': '#171a38',
      '--card-foreground': '#dedee1',
      '--popover': '#171a38',
      '--popover-foreground': '#dedee1',
      '--primary': '#dedee1',
      '--primary-foreground': '#0d1030',
      '--secondary': '#202341',
      '--secondary-foreground': '#dedee1',
      '--muted': '#202341',
      '--muted-foreground': '#767698',
      '--accent': '#282a47',
      '--accent-foreground': '#dedee1',
      '--destructive': '#db229d',
      '--border': '#dedee11f',
      '--input': '#dedee126',
      '--ring': '#dedee1',
      '--sidebar': '#0d1030',
      '--sidebar-foreground': '#dedee1',
      '--sidebar-primary': '#dedee1',
      '--sidebar-primary-foreground': '#0d1030',
      '--sidebar-accent': '#282a47',
      '--sidebar-accent-foreground': '#dedee1',
      '--sidebar-border': '#dedee11f',
      '--sidebar-ring': '#dedee1'
    }
  },
  {
    id: '1984-light',
    label: '1984 Light',
    dark: false,
    terminal: '1984-light',
    ui: {
      '--background': '#e4ecf4',
      '--foreground': '#353247',
      '--card': '#dbe3ea',
      '--card-foreground': '#353247',
      '--popover': '#dbe3ea',
      '--popover-foreground': '#353247',
      '--primary': '#353247',
      '--primary-foreground': '#e4ecf4',
      '--secondary': '#d2d9e0',
      '--secondary-foreground': '#353247',
      '--muted': '#d2d9e0',
      '--muted-foreground': '#798da1',
      '--accent': '#cbd2d9',
      '--accent-foreground': '#353247',
      '--destructive': '#f93bb8',
      '--border': '#3532471f',
      '--input': '#35324726',
      '--ring': '#353247',
      '--sidebar': '#e4ecf4',
      '--sidebar-foreground': '#353247',
      '--sidebar-primary': '#353247',
      '--sidebar-primary-foreground': '#e4ecf4',
      '--sidebar-accent': '#cbd2d9',
      '--sidebar-accent-foreground': '#353247',
      '--sidebar-border': '#3532471f',
      '--sidebar-ring': '#353247'
    }
  },
  {
    id: 'winter-night',
    label: 'Winter Night',
    dark: true,
    terminal: 'winter-night',
    ui: {
      '--background': '#00192c',
      '--foreground': '#e4d5cc',
      '--card': '#0a2234',
      '--card-foreground': '#e4d5cc',
      '--popover': '#0a2234',
      '--popover-foreground': '#e4d5cc',
      '--primary': '#f8cfa6',
      '--primary-foreground': '#00192c',
      '--secondary': '#142b3d',
      '--secondary-foreground': '#e4d5cc',
      '--muted': '#142b3d',
      '--muted-foreground': '#869cb2',
      '--accent': '#1c3243',
      '--accent-foreground': '#e4d5cc',
      '--destructive': '#933911',
      '--border': '#e4d5cc1f',
      '--input': '#e4d5cc26',
      '--ring': '#f8cfa6',
      '--sidebar': '#00192c',
      '--sidebar-foreground': '#e4d5cc',
      '--sidebar-primary': '#f8cfa6',
      '--sidebar-primary-foreground': '#00192c',
      '--sidebar-accent': '#1c3243',
      '--sidebar-accent-foreground': '#e4d5cc',
      '--sidebar-border': '#e4d5cc1f',
      '--sidebar-ring': '#f8cfa6'
    }
  },
  {
    id: 'winter-day',
    label: 'Winter Day',
    dark: false,
    terminal: 'winter-day',
    ui: {
      '--background': '#ece3d1',
      '--foreground': '#1a2720',
      '--card': '#e3dac9',
      '--card-foreground': '#1a2720',
      '--popover': '#e3dac9',
      '--popover-foreground': '#1a2720',
      '--primary': '#5c6370',
      '--primary-foreground': '#ece3d1',
      '--secondary': '#d9d1c0',
      '--secondary-foreground': '#1a2720',
      '--muted': '#d9d1c0',
      '--muted-foreground': '#887f6a',
      '--accent': '#d2caba',
      '--accent-foreground': '#1a2720',
      '--destructive': '#9c3b12',
      '--border': '#1a27201f',
      '--input': '#1a272026',
      '--ring': '#5c6370',
      '--sidebar': '#ece3d1',
      '--sidebar-foreground': '#1a2720',
      '--sidebar-primary': '#5c6370',
      '--sidebar-primary-foreground': '#ece3d1',
      '--sidebar-accent': '#d2caba',
      '--sidebar-accent-foreground': '#1a2720',
      '--sidebar-border': '#1a27201f',
      '--sidebar-ring': '#5c6370'
    }
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    dark: true,
    terminal: 'tokyo-night',
    ui: {
      '--background': '#1a1b26',
      '--foreground': '#cdd6ff',
      '--card': '#23242f',
      '--card-foreground': '#cdd6ff',
      '--popover': '#23242f',
      '--popover-foreground': '#cdd6ff',
      '--primary': '#c0caf5',
      '--primary-foreground': '#1a1b26',
      '--secondary': '#2c2d37',
      '--secondary-foreground': '#cdd6ff',
      '--muted': '#2c2d37',
      '--muted-foreground': '#6e769a',
      '--accent': '#33343e',
      '--accent-foreground': '#cdd6ff',
      '--destructive': '#f7768e',
      '--border': '#cdd6ff1f',
      '--input': '#cdd6ff26',
      '--ring': '#c0caf5',
      '--sidebar': '#1a1b26',
      '--sidebar-foreground': '#cdd6ff',
      '--sidebar-primary': '#c0caf5',
      '--sidebar-primary-foreground': '#1a1b26',
      '--sidebar-accent': '#33343e',
      '--sidebar-accent-foreground': '#cdd6ff',
      '--sidebar-border': '#cdd6ff1f',
      '--sidebar-ring': '#c0caf5'
    }
  },
  {
    id: 'tokyo-day',
    label: 'Tokyo Day',
    dark: false,
    terminal: 'tokyo-day',
    ui: {
      '--background': '#e1e2e7',
      '--foreground': '#2f54a8',
      '--card': '#d8d9de',
      '--card-foreground': '#2f54a8',
      '--popover': '#d8d9de',
      '--popover-foreground': '#2f54a8',
      '--primary': '#3760bf',
      '--primary-foreground': '#e1e2e7',
      '--secondary': '#cfd0d5',
      '--secondary-foreground': '#2f54a8',
      '--muted': '#cfd0d5',
      '--muted-foreground': '#757885',
      '--accent': '#c8c9ce',
      '--accent-foreground': '#2f54a8',
      '--destructive': '#f52a65',
      '--border': '#2f54a81f',
      '--input': '#2f54a826',
      '--ring': '#3760bf',
      '--sidebar': '#e1e2e7',
      '--sidebar-foreground': '#2f54a8',
      '--sidebar-primary': '#3760bf',
      '--sidebar-primary-foreground': '#e1e2e7',
      '--sidebar-accent': '#c8c9ce',
      '--sidebar-accent-foreground': '#2f54a8',
      '--sidebar-border': '#2f54a81f',
      '--sidebar-ring': '#3760bf'
    }
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    dark: false,
    terminal: 'catppuccin-latte',
    ui: {
      '--background': '#eff1f5',
      '--foreground': '#4c4f69',
      '--card': '#e5e7eb',
      '--card-foreground': '#4c4f69',
      '--popover': '#e5e7eb',
      '--popover-foreground': '#4c4f69',
      '--primary': '#dc8a78',
      '--primary-foreground': '#eff1f5',
      '--secondary': '#dcdee1',
      '--secondary-foreground': '#4c4f69',
      '--muted': '#dcdee1',
      '--muted-foreground': '#858a9c',
      '--accent': '#d5d6da',
      '--accent-foreground': '#4c4f69',
      '--destructive': '#c41037',
      '--border': '#4c4f691f',
      '--input': '#4c4f6926',
      '--ring': '#dc8a78',
      '--sidebar': '#eff1f5',
      '--sidebar-foreground': '#4c4f69',
      '--sidebar-primary': '#dc8a78',
      '--sidebar-primary-foreground': '#eff1f5',
      '--sidebar-accent': '#d5d6da',
      '--sidebar-accent-foreground': '#4c4f69',
      '--sidebar-border': '#4c4f691f',
      '--sidebar-ring': '#dc8a78'
    }
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    dark: true,
    terminal: 'catppuccin-mocha',
    ui: {
      '--background': '#1e1e2e',
      '--foreground': '#cdd6f4',
      '--card': '#272736',
      '--card-foreground': '#cdd6f4',
      '--popover': '#272736',
      '--popover-foreground': '#cdd6f4',
      '--primary': '#f5e0dc',
      '--primary-foreground': '#1e1e2e',
      '--secondary': '#30303f',
      '--secondary-foreground': '#cdd6f4',
      '--muted': '#30303f',
      '--muted-foreground': '#777790',
      '--accent': '#373745',
      '--accent-foreground': '#cdd6f4',
      '--destructive': '#ad626b',
      '--border': '#cdd6f41f',
      '--input': '#cdd6f426',
      '--ring': '#f5e0dc',
      '--sidebar': '#1e1e2e',
      '--sidebar-foreground': '#cdd6f4',
      '--sidebar-primary': '#f5e0dc',
      '--sidebar-primary-foreground': '#1e1e2e',
      '--sidebar-accent': '#373745',
      '--sidebar-accent-foreground': '#cdd6f4',
      '--sidebar-border': '#cdd6f41f',
      '--sidebar-ring': '#f5e0dc'
    }
  },
  {
    id: 'diwali',
    label: 'Diwali',
    dark: true,
    terminal: 'diwali',
    ui: {
      '--background': '#311652',
      '--foreground': '#fdf6f6',
      '--card': '#391f59',
      '--card-foreground': '#fdf6f6',
      '--popover': '#391f59',
      '--popover-foreground': '#fdf6f6',
      '--primary': '#ffa900',
      '--primary-foreground': '#311652',
      '--secondary': '#412960',
      '--secondary-foreground': '#fdf6f6',
      '--muted': '#412960',
      '--muted-foreground': '#856ea2',
      '--accent': '#483065',
      '--accent-foreground': '#fdf6f6',
      '--destructive': '#ad0656',
      '--border': '#fdf6f61f',
      '--input': '#fdf6f626',
      '--ring': '#ffa900',
      '--sidebar': '#311652',
      '--sidebar-foreground': '#fdf6f6',
      '--sidebar-primary': '#ffa900',
      '--sidebar-primary-foreground': '#311652',
      '--sidebar-accent': '#483065',
      '--sidebar-accent-foreground': '#fdf6f6',
      '--sidebar-border': '#fdf6f61f',
      '--sidebar-ring': '#ffa900'
    }
  },
  {
    id: 'movember',
    label: 'Movember',
    dark: true,
    terminal: 'movember',
    ui: {
      '--background': '#1f0900',
      '--foreground': '#ffe7c3',
      '--card': '#28130a',
      '--card-foreground': '#ffe7c3',
      '--popover': '#28130a',
      '--popover-foreground': '#ffe7c3',
      '--primary': '#e6c03c',
      '--primary-foreground': '#1f0900',
      '--secondary': '#311d14',
      '--secondary-foreground': '#ffe7c3',
      '--muted': '#311d14',
      '--muted-foreground': '#8c6d5e',
      '--accent': '#38241c',
      '--accent-foreground': '#ffe7c3',
      '--destructive': '#a43219',
      '--border': '#ffe7c31f',
      '--input': '#ffe7c326',
      '--ring': '#e6c03c',
      '--sidebar': '#1f0900',
      '--sidebar-foreground': '#ffe7c3',
      '--sidebar-primary': '#e6c03c',
      '--sidebar-primary-foreground': '#1f0900',
      '--sidebar-accent': '#38241c',
      '--sidebar-accent-foreground': '#ffe7c3',
      '--sidebar-border': '#ffe7c31f',
      '--sidebar-ring': '#e6c03c'
    }
  },
  {
    id: 'atom-one-dark',
    label: 'Atom One Dark',
    dark: true,
    terminal: 'atom-one-dark',
    ui: {
      '--background': '#1e2127',
      '--foreground': '#abb2bf',
      '--card': '#272a30',
      '--card-foreground': '#abb2bf',
      '--popover': '#272a30',
      '--popover-foreground': '#abb2bf',
      '--primary': '#5c6370',
      '--primary-foreground': '#1e2127',
      '--secondary': '#303338',
      '--secondary-foreground': '#abb2bf',
      '--muted': '#303338',
      '--muted-foreground': '#70798d',
      '--accent': '#37393f',
      '--accent-foreground': '#abb2bf',
      '--destructive': '#ca6169',
      '--border': '#abb2bf1f',
      '--input': '#abb2bf26',
      '--ring': '#5c6370',
      '--sidebar': '#1e2127',
      '--sidebar-foreground': '#abb2bf',
      '--sidebar-primary': '#5c6370',
      '--sidebar-primary-foreground': '#1e2127',
      '--sidebar-accent': '#37393f',
      '--sidebar-accent-foreground': '#abb2bf',
      '--sidebar-border': '#abb2bf1f',
      '--sidebar-ring': '#5c6370'
    }
  },
  {
    id: 'atom-one-light',
    label: 'Atom One Light',
    dark: false,
    terminal: 'atom-one-light',
    ui: {
      '--background': '#f9f9f9',
      '--foreground': '#383a42',
      '--card': '#efefef',
      '--card-foreground': '#383a42',
      '--popover': '#efefef',
      '--popover-foreground': '#383a42',
      '--primary': '#383a42',
      '--primary-foreground': '#f9f9f9',
      '--secondary': '#e5e5e5',
      '--secondary-foreground': '#383a42',
      '--muted': '#e5e5e5',
      '--muted-foreground': '#9395a3',
      '--accent': '#dedede',
      '--accent-foreground': '#383a42',
      '--destructive': '#e45649',
      '--border': '#383a421f',
      '--input': '#383a4226',
      '--ring': '#383a42',
      '--sidebar': '#f9f9f9',
      '--sidebar-foreground': '#383a42',
      '--sidebar-primary': '#383a42',
      '--sidebar-primary-foreground': '#f9f9f9',
      '--sidebar-accent': '#dedede',
      '--sidebar-accent-foreground': '#383a42',
      '--sidebar-border': '#383a421f',
      '--sidebar-ring': '#383a42'
    }
  },
  {
    id: 'halloween',
    label: 'Halloween',
    dark: true,
    terminal: 'halloween',
    ui: {
      '--background': '#22012b',
      '--foreground': '#e5e5e5',
      '--card': '#2b0b33',
      '--card-foreground': '#e5e5e5',
      '--popover': '#2b0b33',
      '--popover-foreground': '#e5e5e5',
      '--primary': '#ffa900',
      '--primary-foreground': '#22012b',
      '--secondary': '#34153c',
      '--secondary-foreground': '#e5e5e5',
      '--muted': '#34153c',
      '--muted-foreground': '#9f84a7',
      '--accent': '#3a1d42',
      '--accent-foreground': '#e5e5e5',
      '--destructive': '#a31736',
      '--border': '#e5e5e51f',
      '--input': '#e5e5e526',
      '--ring': '#ffa900',
      '--sidebar': '#22012b',
      '--sidebar-foreground': '#e5e5e5',
      '--sidebar-primary': '#ffa900',
      '--sidebar-primary-foreground': '#22012b',
      '--sidebar-accent': '#3a1d42',
      '--sidebar-accent-foreground': '#e5e5e5',
      '--sidebar-border': '#e5e5e51f',
      '--sidebar-ring': '#ffa900'
    }
  },
  {
    id: 'dia-de-muertos',
    label: 'Dia De Muertos',
    dark: false,
    terminal: 'dia-de-muertos',
    ui: {
      '--background': '#fffdf5',
      '--foreground': '#281f63',
      '--card': '#f5f3eb',
      '--card-foreground': '#281f63',
      '--popover': '#f5f3eb',
      '--popover-foreground': '#281f63',
      '--primary': '#b33a00',
      '--primary-foreground': '#fffdf5',
      '--secondary': '#ebe9e1',
      '--secondary-foreground': '#281f63',
      '--muted': '#ebe9e1',
      '--muted-foreground': '#8b8982',
      '--accent': '#e3e1da',
      '--accent-foreground': '#281f63',
      '--destructive': '#eb1670',
      '--border': '#281f631f',
      '--input': '#281f6326',
      '--ring': '#b33a00',
      '--sidebar': '#fffdf5',
      '--sidebar-foreground': '#281f63',
      '--sidebar-primary': '#b33a00',
      '--sidebar-primary-foreground': '#fffdf5',
      '--sidebar-accent': '#e3e1da',
      '--sidebar-accent-foreground': '#281f63',
      '--sidebar-border': '#281f631f',
      '--sidebar-ring': '#b33a00'
    }
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    dark: true,
    terminal: 'gruvbox-dark',
    ui: {
      '--background': '#282828',
      '--foreground': '#ebdbb2',
      '--card': '#313131',
      '--card-foreground': '#ebdbb2',
      '--popover': '#313131',
      '--popover-foreground': '#ebdbb2',
      '--primary': '#ebdbb2',
      '--primary-foreground': '#282828',
      '--secondary': '#393939',
      '--secondary-foreground': '#ebdbb2',
      '--muted': '#393939',
      '--muted-foreground': '#908477',
      '--accent': '#404040',
      '--accent-foreground': '#ebdbb2',
      '--destructive': '#cc241d',
      '--border': '#ebdbb21f',
      '--input': '#ebdbb226',
      '--ring': '#ebdbb2',
      '--sidebar': '#282828',
      '--sidebar-foreground': '#ebdbb2',
      '--sidebar-primary': '#ebdbb2',
      '--sidebar-primary-foreground': '#282828',
      '--sidebar-accent': '#404040',
      '--sidebar-accent-foreground': '#ebdbb2',
      '--sidebar-border': '#ebdbb21f',
      '--sidebar-ring': '#ebdbb2'
    }
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    dark: false,
    terminal: 'gruvbox-light',
    ui: {
      '--background': '#fbf1c7',
      '--foreground': '#282828',
      '--card': '#f1e7bf',
      '--card-foreground': '#282828',
      '--popover': '#f1e7bf',
      '--popover-foreground': '#282828',
      '--primary': '#282828',
      '--primary-foreground': '#fbf1c7',
      '--secondary': '#e7deb7',
      '--secondary-foreground': '#282828',
      '--muted': '#e7deb7',
      '--muted-foreground': '#857d5f',
      '--accent': '#dfd6b1',
      '--accent-foreground': '#282828',
      '--destructive': '#9d0006',
      '--border': '#2828281f',
      '--input': '#28282826',
      '--ring': '#282828',
      '--sidebar': '#fbf1c7',
      '--sidebar-foreground': '#282828',
      '--sidebar-primary': '#282828',
      '--sidebar-primary-foreground': '#fbf1c7',
      '--sidebar-accent': '#dfd6b1',
      '--sidebar-accent-foreground': '#282828',
      '--sidebar-border': '#2828281f',
      '--sidebar-ring': '#282828'
    }
  },
  {
    id: 'material-dark',
    label: 'Material Dark',
    dark: true,
    terminal: 'material-dark',
    ui: {
      '--background': '#232322',
      '--foreground': '#e5e5e5',
      '--card': '#2c2c2b',
      '--card-foreground': '#e5e5e5',
      '--popover': '#2c2c2b',
      '--popover-foreground': '#e5e5e5',
      '--primary': '#16afca',
      '--primary-foreground': '#232322',
      '--secondary': '#353534',
      '--secondary-foreground': '#e5e5e5',
      '--muted': '#353534',
      '--muted-foreground': '#75756e',
      '--accent': '#3b3b3a',
      '--accent-foreground': '#e5e5e5',
      '--destructive': '#b7141f',
      '--border': '#e5e5e51f',
      '--input': '#e5e5e526',
      '--ring': '#16afca',
      '--sidebar': '#232322',
      '--sidebar-foreground': '#e5e5e5',
      '--sidebar-primary': '#16afca',
      '--sidebar-primary-foreground': '#232322',
      '--sidebar-accent': '#3b3b3a',
      '--sidebar-accent-foreground': '#e5e5e5',
      '--sidebar-border': '#e5e5e51f',
      '--sidebar-ring': '#16afca'
    }
  },
  {
    id: 'material-light',
    label: 'Material Light',
    dark: false,
    terminal: 'material-light',
    ui: {
      '--background': '#eaeaea',
      '--foreground': '#2f2f2f',
      '--card': '#e1e1e1',
      '--card-foreground': '#2f2f2f',
      '--popover': '#e1e1e1',
      '--popover-foreground': '#2f2f2f',
      '--primary': '#16afca',
      '--primary-foreground': '#eaeaea',
      '--secondary': '#d7d7d7',
      '--secondary-foreground': '#2f2f2f',
      '--muted': '#d7d7d7',
      '--muted-foreground': '#747474',
      '--accent': '#d0d0d0',
      '--accent-foreground': '#2f2f2f',
      '--destructive': '#b7141f',
      '--border': '#2f2f2f1f',
      '--input': '#2f2f2f26',
      '--ring': '#16afca',
      '--sidebar': '#eaeaea',
      '--sidebar-foreground': '#2f2f2f',
      '--sidebar-primary': '#16afca',
      '--sidebar-primary-foreground': '#eaeaea',
      '--sidebar-accent': '#d0d0d0',
      '--sidebar-accent-foreground': '#2f2f2f',
      '--sidebar-border': '#2f2f2f1f',
      '--sidebar-ring': '#16afca'
    }
  },
  {
    id: 'manhattan',
    label: 'Manhattan',
    dark: true,
    terminal: 'manhattan',
    ui: {
      '--background': '#0a0a0a',
      '--foreground': '#b8b9b4',
      '--card': '#141414',
      '--card-foreground': '#b8b9b4',
      '--popover': '#141414',
      '--popover-foreground': '#b8b9b4',
      '--primary': '#dfe0db',
      '--primary-foreground': '#0a0a0a',
      '--secondary': '#1e1e1e',
      '--secondary-foreground': '#b8b9b4',
      '--muted': '#1e1e1e',
      '--muted-foreground': '#7b7b7b',
      '--accent': '#252525',
      '--accent-foreground': '#b8b9b4',
      '--destructive': '#840f02',
      '--border': '#b8b9b41f',
      '--input': '#b8b9b426',
      '--ring': '#dfe0db',
      '--sidebar': '#0a0a0a',
      '--sidebar-foreground': '#b8b9b4',
      '--sidebar-primary': '#dfe0db',
      '--sidebar-primary-foreground': '#0a0a0a',
      '--sidebar-accent': '#252525',
      '--sidebar-accent-foreground': '#b8b9b4',
      '--sidebar-border': '#b8b9b41f',
      '--sidebar-ring': '#dfe0db'
    }
  },
  {
    id: 'plastic-world',
    label: 'Plastic World',
    dark: true,
    terminal: 'plastic-world',
    ui: {
      '--background': '#ea56c1',
      '--foreground': '#ffe9da',
      '--card': '#eb5dc3',
      '--card-foreground': '#ffe9da',
      '--popover': '#eb5dc3',
      '--popover-foreground': '#ffe9da',
      '--primary': '#bafc8b',
      '--primary-foreground': '#ea56c1',
      '--secondary': '#ec64c6',
      '--secondary-foreground': '#ffe9da',
      '--muted': '#ec64c6',
      '--muted-foreground': '#ffd9f2',
      '--accent': '#ec69c8',
      '--accent-foreground': '#ffe9da',
      '--destructive': '#de0000',
      '--border': '#ffe9da1f',
      '--input': '#ffe9da26',
      '--ring': '#bafc8b',
      '--sidebar': '#ea56c1',
      '--sidebar-foreground': '#ffe9da',
      '--sidebar-primary': '#bafc8b',
      '--sidebar-primary-foreground': '#ea56c1',
      '--sidebar-accent': '#ec69c8',
      '--sidebar-accent-foreground': '#ffe9da',
      '--sidebar-border': '#ffe9da1f',
      '--sidebar-ring': '#bafc8b'
    }
  },
  {
    id: 'basic',
    label: 'Basic',
    dark: false,
    terminal: 'basic',
    ui: {
      '--background': '#ffffff',
      '--foreground': '#000000',
      '--card': '#f5f5f5',
      '--card-foreground': '#000000',
      '--popover': '#f5f5f5',
      '--popover-foreground': '#000000',
      '--primary': '#7f7f7f',
      '--primary-foreground': '#ffffff',
      '--secondary': '#ebebeb',
      '--secondary-foreground': '#000000',
      '--muted': '#ebebeb',
      '--muted-foreground': '#808080',
      '--accent': '#e3e3e3',
      '--accent-foreground': '#000000',
      '--destructive': '#c61a1a',
      '--border': '#0000001f',
      '--input': '#00000026',
      '--ring': '#7f7f7f',
      '--sidebar': '#ffffff',
      '--sidebar-foreground': '#000000',
      '--sidebar-primary': '#7f7f7f',
      '--sidebar-primary-foreground': '#ffffff',
      '--sidebar-accent': '#e3e3e3',
      '--sidebar-accent-foreground': '#000000',
      '--sidebar-border': '#0000001f',
      '--sidebar-ring': '#7f7f7f'
    }
  },
  {
    id: 'homebrew',
    label: 'Homebrew',
    dark: true,
    terminal: 'homebrew',
    ui: {
      '--background': '#000000',
      '--foreground': '#00ff00',
      '--card': '#0a0a0a',
      '--card-foreground': '#00ff00',
      '--popover': '#0a0a0a',
      '--popover-foreground': '#00ff00',
      '--primary': '#23ff18',
      '--primary-foreground': '#000000',
      '--secondary': '#141414',
      '--secondary-foreground': '#00ff00',
      '--muted': '#141414',
      '--muted-foreground': '#9d9d9d',
      '--accent': '#1c1c1c',
      '--accent-foreground': '#00ff00',
      '--destructive': '#c93434',
      '--border': '#00ff001f',
      '--input': '#00ff0026',
      '--ring': '#23ff18',
      '--sidebar': '#000000',
      '--sidebar-foreground': '#00ff00',
      '--sidebar-primary': '#23ff18',
      '--sidebar-primary-foreground': '#000000',
      '--sidebar-accent': '#1c1c1c',
      '--sidebar-accent-foreground': '#00ff00',
      '--sidebar-border': '#00ff001f',
      '--sidebar-ring': '#23ff18'
    }
  },
  {
    id: 'grass',
    label: 'Grass',
    dark: true,
    terminal: 'grass',
    ui: {
      '--background': '#13773d',
      '--foreground': '#fff0a5',
      '--card': '#1c7c45',
      '--card-foreground': '#fff0a5',
      '--popover': '#1c7c45',
      '--popover-foreground': '#fff0a5',
      '--primary': '#8c2800',
      '--primary-foreground': '#13773d',
      '--secondary': '#26824d',
      '--secondary-foreground': '#fff0a5',
      '--muted': '#26824d',
      '--muted-foreground': '#8ed4ac',
      '--accent': '#2d8652',
      '--accent-foreground': '#fff0a5',
      '--destructive': '#9a183c',
      '--border': '#fff0a51f',
      '--input': '#fff0a526',
      '--ring': '#8c2800',
      '--sidebar': '#13773d',
      '--sidebar-foreground': '#fff0a5',
      '--sidebar-primary': '#8c2800',
      '--sidebar-primary-foreground': '#13773d',
      '--sidebar-accent': '#2d8652',
      '--sidebar-accent-foreground': '#fff0a5',
      '--sidebar-border': '#fff0a51f',
      '--sidebar-ring': '#8c2800'
    }
  },
  {
    id: 'man-page',
    label: 'Man Page',
    dark: false,
    terminal: 'man-page',
    ui: {
      '--background': '#fef49c',
      '--foreground': '#000000',
      '--card': '#f4ea96',
      '--card-foreground': '#000000',
      '--popover': '#f4ea96',
      '--popover-foreground': '#000000',
      '--primary': '#7f7f7f',
      '--primary-foreground': '#fef49c',
      '--secondary': '#eae090',
      '--secondary-foreground': '#000000',
      '--muted': '#eae090',
      '--muted-foreground': '#848057',
      '--accent': '#e2d98b',
      '--accent-foreground': '#000000',
      '--destructive': '#9a183c',
      '--border': '#0000001f',
      '--input': '#00000026',
      '--ring': '#7f7f7f',
      '--sidebar': '#fef49c',
      '--sidebar-foreground': '#000000',
      '--sidebar-primary': '#7f7f7f',
      '--sidebar-primary-foreground': '#fef49c',
      '--sidebar-accent': '#e2d98b',
      '--sidebar-accent-foreground': '#000000',
      '--sidebar-border': '#0000001f',
      '--sidebar-ring': '#7f7f7f'
    }
  },
  {
    id: 'novel',
    label: 'Novel',
    dark: false,
    terminal: 'novel',
    ui: {
      '--background': '#dfdbc3',
      '--foreground': '#3b2322',
      '--card': '#d6d2bb',
      '--card-foreground': '#3b2322',
      '--popover': '#d6d2bb',
      '--popover-foreground': '#3b2322',
      '--primary': '#73635a',
      '--primary-foreground': '#dfdbc3',
      '--secondary': '#cdc9b3',
      '--secondary-foreground': '#3b2322',
      '--muted': '#cdc9b3',
      '--muted-foreground': '#6f6c5a',
      '--accent': '#c6c3ae',
      '--accent-foreground': '#3b2322',
      '--destructive': '#d30f0f',
      '--border': '#3b23221f',
      '--input': '#3b232226',
      '--ring': '#73635a',
      '--sidebar': '#dfdbc3',
      '--sidebar-foreground': '#3b2322',
      '--sidebar-primary': '#73635a',
      '--sidebar-primary-foreground': '#dfdbc3',
      '--sidebar-accent': '#c6c3ae',
      '--sidebar-accent-foreground': '#3b2322',
      '--sidebar-border': '#3b23221f',
      '--sidebar-ring': '#73635a'
    }
  },
  {
    id: 'ocean',
    label: 'Ocean',
    dark: true,
    terminal: 'ocean',
    ui: {
      '--background': '#224fbc',
      '--foreground': '#ffffff',
      '--card': '#2b56bf',
      '--card-foreground': '#ffffff',
      '--popover': '#2b56bf',
      '--popover-foreground': '#ffffff',
      '--primary': '#7f7f7f',
      '--primary-foreground': '#224fbc',
      '--secondary': '#345dc1',
      '--secondary-foreground': '#ffffff',
      '--muted': '#345dc1',
      '--muted-foreground': '#9bb4ee',
      '--accent': '#3a62c3',
      '--accent-foreground': '#ffffff',
      '--destructive': '#881616',
      '--border': '#ffffff1f',
      '--input': '#ffffff26',
      '--ring': '#7f7f7f',
      '--sidebar': '#224fbc',
      '--sidebar-foreground': '#ffffff',
      '--sidebar-primary': '#7f7f7f',
      '--sidebar-primary-foreground': '#224fbc',
      '--sidebar-accent': '#3a62c3',
      '--sidebar-accent-foreground': '#ffffff',
      '--sidebar-border': '#ffffff1f',
      '--sidebar-ring': '#7f7f7f'
    }
  },
  {
    id: 'pro',
    label: 'Pro',
    dark: true,
    terminal: 'pro',
    ui: {
      '--background': '#000000',
      '--foreground': '#f2f2f2',
      '--card': '#0a0a0a',
      '--card-foreground': '#f2f2f2',
      '--popover': '#0a0a0a',
      '--popover-foreground': '#f2f2f2',
      '--primary': '#4d4d4d',
      '--primary-foreground': '#000000',
      '--secondary': '#141414',
      '--secondary-foreground': '#f2f2f2',
      '--muted': '#141414',
      '--muted-foreground': '#9d9d9d',
      '--accent': '#1c1c1c',
      '--accent-foreground': '#f2f2f2',
      '--destructive': '#c93434',
      '--border': '#f2f2f21f',
      '--input': '#f2f2f226',
      '--ring': '#4d4d4d',
      '--sidebar': '#000000',
      '--sidebar-foreground': '#f2f2f2',
      '--sidebar-primary': '#4d4d4d',
      '--sidebar-primary-foreground': '#000000',
      '--sidebar-accent': '#1c1c1c',
      '--sidebar-accent-foreground': '#f2f2f2',
      '--sidebar-border': '#f2f2f21f',
      '--sidebar-ring': '#4d4d4d'
    }
  },
  {
    id: 'red-sands',
    label: 'Red Sands',
    dark: true,
    terminal: 'red-sands',
    ui: {
      '--background': '#7a251e',
      '--foreground': '#d7c9a7',
      '--card': '#7f2e27',
      '--card-foreground': '#d7c9a7',
      '--popover': '#7f2e27',
      '--popover-foreground': '#d7c9a7',
      '--primary': '#ffffff',
      '--primary-foreground': '#7a251e',
      '--secondary': '#853630',
      '--secondary-foreground': '#d7c9a7',
      '--muted': '#853630',
      '--muted-foreground': '#cc8984',
      '--accent': '#893d37',
      '--accent-foreground': '#d7c9a7',
      '--destructive': '#d30e0e',
      '--border': '#d7c9a71f',
      '--input': '#d7c9a726',
      '--ring': '#ffffff',
      '--sidebar': '#7a251e',
      '--sidebar-foreground': '#d7c9a7',
      '--sidebar-primary': '#ffffff',
      '--sidebar-primary-foreground': '#7a251e',
      '--sidebar-accent': '#893d37',
      '--sidebar-accent-foreground': '#d7c9a7',
      '--sidebar-border': '#d7c9a71f',
      '--sidebar-ring': '#ffffff'
    }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dark: true,
    terminal: 'solarized-dark',
    ui: {
      '--background': '#002b36',
      '--foreground': '#839496',
      '--card': '#0a333e',
      '--card-foreground': '#839496',
      '--popover': '#0a333e',
      '--popover-foreground': '#839496',
      '--primary': '#657779',
      '--primary-foreground': '#002b36',
      '--secondary': '#143c46',
      '--secondary-foreground': '#839496',
      '--muted': '#143c46',
      '--muted-foreground': '#5d838d',
      '--accent': '#1c424c',
      '--accent-foreground': '#839496',
      '--destructive': '#dc322f',
      '--border': '#8394961f',
      '--input': '#83949626',
      '--ring': '#657779',
      '--sidebar': '#002b36',
      '--sidebar-foreground': '#839496',
      '--sidebar-primary': '#657779',
      '--sidebar-primary-foreground': '#002b36',
      '--sidebar-accent': '#1c424c',
      '--sidebar-accent-foreground': '#839496',
      '--sidebar-border': '#8394961f',
      '--sidebar-ring': '#657779'
    }
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    dark: false,
    terminal: 'solarized-light',
    ui: {
      '--background': '#fdf6e3',
      '--foreground': '#657b83',
      '--card': '#f3ecda',
      '--card-foreground': '#657b83',
      '--popover': '#f3ecda',
      '--popover-foreground': '#657b83',
      '--primary': '#657b83',
      '--primary-foreground': '#fdf6e3',
      '--secondary': '#e9e2d1',
      '--secondary-foreground': '#657b83',
      '--muted': '#e9e2d1',
      '--muted-foreground': '#9c9686',
      '--accent': '#e1dbca',
      '--accent-foreground': '#657b83',
      '--destructive': '#dc322f',
      '--border': '#657b831f',
      '--input': '#657b8326',
      '--ring': '#657b83',
      '--sidebar': '#fdf6e3',
      '--sidebar-foreground': '#657b83',
      '--sidebar-primary': '#657b83',
      '--sidebar-primary-foreground': '#fdf6e3',
      '--sidebar-accent': '#e1dbca',
      '--sidebar-accent-foreground': '#657b83',
      '--sidebar-border': '#657b831f',
      '--sidebar-ring': '#657b83'
    }
  },
  {
    id: 'silver-aerogel',
    label: 'Silver Aerogel',
    dark: true,
    terminal: 'silver-aerogel',
    ui: {
      '--background': '#919191',
      '--foreground': '#000000',
      '--card': '#959595',
      '--card-foreground': '#000000',
      '--popover': '#959595',
      '--popover-foreground': '#000000',
      '--primary': '#d9d9d9',
      '--primary-foreground': '#919191',
      '--secondary': '#9a9a9a',
      '--secondary-foreground': '#000000',
      '--muted': '#9a9a9a',
      '--muted-foreground': '#4d4d4d',
      '--accent': '#9d9d9d',
      '--accent-foreground': '#000000',
      '--destructive': '#ca3535',
      '--border': '#0000001f',
      '--input': '#00000026',
      '--ring': '#d9d9d9',
      '--sidebar': '#919191',
      '--sidebar-foreground': '#000000',
      '--sidebar-primary': '#d9d9d9',
      '--sidebar-primary-foreground': '#919191',
      '--sidebar-accent': '#9d9d9d',
      '--sidebar-accent-foreground': '#000000',
      '--sidebar-border': '#0000001f',
      '--sidebar-ring': '#d9d9d9'
    }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    dark: true,
    terminal: 'dracula',
    ui: {
      '--background': '#282a36',
      '--foreground': '#f8f8f2',
      '--card': '#31333e',
      '--card-foreground': '#f8f8f2',
      '--popover': '#31333e',
      '--popover-foreground': '#f8f8f2',
      '--primary': '#bbbbbb',
      '--primary-foreground': '#282a36',
      '--secondary': '#393b46',
      '--secondary-foreground': '#f8f8f2',
      '--muted': '#393b46',
      '--muted-foreground': '#7d8197',
      '--accent': '#40414c',
      '--accent-foreground': '#f8f8f2',
      '--destructive': '#e04242',
      '--border': '#f8f8f21f',
      '--input': '#f8f8f226',
      '--ring': '#bbbbbb',
      '--sidebar': '#282a36',
      '--sidebar-foreground': '#f8f8f2',
      '--sidebar-primary': '#bbbbbb',
      '--sidebar-primary-foreground': '#282a36',
      '--sidebar-accent': '#40414c',
      '--sidebar-accent-foreground': '#f8f8f2',
      '--sidebar-border': '#f8f8f21f',
      '--sidebar-ring': '#bbbbbb'
    }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    dark: true,
    terminal: 'monokai',
    ui: {
      '--background': '#0c0c0c',
      '--foreground': '#d9d9d9',
      '--card': '#161616',
      '--card-foreground': '#d9d9d9',
      '--popover': '#161616',
      '--popover-foreground': '#d9d9d9',
      '--primary': '#fc971f',
      '--primary-foreground': '#0c0c0c',
      '--secondary': '#1f1f1f',
      '--secondary-foreground': '#d9d9d9',
      '--muted': '#1f1f1f',
      '--muted-foreground': '#86899a',
      '--accent': '#272727',
      '--accent-foreground': '#d9d9d9',
      '--destructive': '#dd0056',
      '--border': '#d9d9d91f',
      '--input': '#d9d9d926',
      '--ring': '#fc971f',
      '--sidebar': '#0c0c0c',
      '--sidebar-foreground': '#d9d9d9',
      '--sidebar-primary': '#fc971f',
      '--sidebar-primary-foreground': '#0c0c0c',
      '--sidebar-accent': '#272727',
      '--sidebar-accent-foreground': '#d9d9d9',
      '--sidebar-border': '#d9d9d91f',
      '--sidebar-ring': '#fc971f'
    }
  },
  {
    id: 'nord-light',
    label: 'Nord Light',
    dark: false,
    terminal: 'nord-light',
    ui: {
      '--background': '#e5e9f0',
      '--foreground': '#414858',
      '--card': '#dce0e6',
      '--card-foreground': '#414858',
      '--popover': '#dce0e6',
      '--popover-foreground': '#414858',
      '--primary': '#88c0d0',
      '--primary-foreground': '#e5e9f0',
      '--secondary': '#d3d6dd',
      '--secondary-foreground': '#414858',
      '--muted': '#d3d6dd',
      '--muted-foreground': '#6f7683',
      '--accent': '#cccfd6',
      '--accent-foreground': '#414858',
      '--destructive': '#ae545d',
      '--border': '#4148581f',
      '--input': '#41485826',
      '--ring': '#88c0d0',
      '--sidebar': '#e5e9f0',
      '--sidebar-foreground': '#414858',
      '--sidebar-primary': '#88c0d0',
      '--sidebar-primary-foreground': '#e5e9f0',
      '--sidebar-accent': '#cccfd6',
      '--sidebar-accent-foreground': '#414858',
      '--sidebar-border': '#4148581f',
      '--sidebar-ring': '#88c0d0'
    }
  },
  {
    id: 'nord-dark',
    label: 'Nord Dark',
    dark: true,
    terminal: 'nord-dark',
    ui: {
      '--background': '#2e3440',
      '--foreground': '#d8dee9',
      '--card': '#363c48',
      '--card-foreground': '#d8dee9',
      '--popover': '#363c48',
      '--popover-foreground': '#d8dee9',
      '--primary': '#eceff4',
      '--primary-foreground': '#2e3440',
      '--secondary': '#3f444f',
      '--secondary-foreground': '#d8dee9',
      '--muted': '#3f444f',
      '--muted-foreground': '#808a9e',
      '--accent': '#454a55',
      '--accent-foreground': '#d8dee9',
      '--destructive': '#ae545d',
      '--border': '#d8dee91f',
      '--input': '#d8dee926',
      '--ring': '#eceff4',
      '--sidebar': '#2e3440',
      '--sidebar-foreground': '#d8dee9',
      '--sidebar-primary': '#eceff4',
      '--sidebar-primary-foreground': '#2e3440',
      '--sidebar-accent': '#454a55',
      '--sidebar-accent-foreground': '#d8dee9',
      '--sidebar-border': '#d8dee91f',
      '--sidebar-ring': '#eceff4'
    }
  }
]

/** 废弃主题 id 的归宿。 */
const LEGACY_THEME_IDS: Record<string, string> = {
  dark: 'termius-dark',
  light: 'termius-light',
  'one-dark': 'atom-one-dark',
  nord: 'nord-dark'
}

/** 按 id 找统一主题，废弃 id 先映射，找不到回落到「深色」。 */
export function unifiedTheme(id: string): UnifiedTheme {
  const mapped = LEGACY_THEME_IDS[id] ?? id
  return UNIFIED_THEMES.find((item) => item.id === mapped) ?? UNIFIED_THEMES[0]!
}

export interface Appearance {
  /** 统一主题 id（UNIFIED_THEMES），整套界面 + 终端配色一起换 */
  theme: string
  /** 终端字体（首选，后面接固定 fallback 链） */
  terminalFont: string
  /** 终端字号，10–24 */
  terminalSize: number
}

/** 终端字体候选。存的是首选字体名，渲染时再接通用 fallback。 */
export const TERMINAL_FONTS = [
  'Cascadia Mono',
  'Consolas',
  'JetBrains Mono',
  'Source Code Pro',
  'Microsoft YaHei'
] as const

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'termius-dark',
  terminalFont: 'Source Code Pro',
  terminalSize: 14
}

export function parseAppearance(input: unknown): Appearance {
  const row = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  // 存的是统一主题 id（废弃 id 在统一主题函数里映射，不认识的回退深色）
  const theme =
    typeof row.theme === 'string' && row.theme ? unifiedTheme(row.theme).id : DEFAULT_APPEARANCE.theme
  const terminalFont =
    typeof row.terminalFont === 'string' && row.terminalFont.trim()
      ? row.terminalFont.trim()
      : DEFAULT_APPEARANCE.terminalFont
  const size = typeof row.terminalSize === 'number' ? Math.trunc(row.terminalSize) : NaN
  const terminalSize = size >= 10 && size <= 24 ? size : DEFAULT_APPEARANCE.terminalSize
  return { theme, terminalFont, terminalSize }
}

/** 一条命令片段：存常用命令，一键发到当前终端执行 */
export interface Snippet {
  id: string
  name: string
  command: string
  createdAt: number
}

/** 一条历史指令。从终端按键流里结算出来，只留最近 200 条 */
export interface HistoryEntry {
  id: number
  /** 这条命令属于哪扇终端，历史按窗口隔离 */
  termId: string
  command: string
  at: number
}
