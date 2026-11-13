import { create } from 'zustand'
import {
  MCP_DEFAULT_PORT,
  unifiedTheme,
  type Appearance,
  type DockerInfo,
  type LocalShell,
  type LocalShellInfo,
  type McpOpenTab,
  type McpRuntime,
  type McpSettings,
  type McpSettingsInput,
  type ServerInfo,
  type ServerMetrics,
  type SessionConfig,
  type SessionStatus,
  type SftpTransferEvent,
  type Tab,
  type TermStatusEvent,
  type WebInfo
} from '../../../shared/types'
import { newTermId } from '../../../shared/ids'
import { osIconProps } from '../components/OsIcon'
import { dropBuffer, editorKey } from '../editor/editorBuffers'
import { shellLabel, termTitle } from '../agentPrompt'
import { firstOrderedShell } from '../menuOrder'
import { terminalPool } from '../terminal/TerminalPool'
import { applyAppearance, readCachedAppearance, type ResolvedAppTheme } from '../theme/applyAppearance'

const EDITOR_WRAP_KEY = 'termpilot.editorWrap'

export interface EditorTab {
  key: string
  /** 所属终端标签，只在这个终端下显示 */
  termId: string
  /** null 表示本机文件 */
  sessionId: string | null
  path: string
  name: string
  /** 斜体预览：再单击别的文件会替换它 */
  preview: boolean
  dirty: boolean
  /** 查看模式：编辑器只读，Markdown 显示渲染结果 */
  readOnly: boolean
}

interface TermState {
  status: SessionStatus | 'error'
  error?: string
}

/** 右侧面板的四个板块 */
export type RightPanelPane = 'files' | 'images' | 'commands' | 'theme'

interface AppState {
  sessions: SessionConfig[]
  localShells: LocalShellInfo[]
  /** 服务器静态身份缓存（主机名/系统/内核/IP），按会话存，带采集时间戳 */
  serverInfoBySession: Record<string, { info: ServerInfo; at: number }>
  /** 运维面板的动态采集（CPU/内存/进程…），按会话存，同一服务器的多个标签共用。
      error 是最近一次失败的原始信息，成功后清空 */
  metricsBySession: Record<string, { metrics: ServerMetrics | null; error: string; at: number }>
  /** Docker 采集缓存，按会话存。at 在采集开始时就写，兼作在途标记 */
  dockerBySession: Record<string, { info: DockerInfo | null; at: number }>
  /** 本次运行里记住的 sudo 密码，只在内存，关掉应用就没了。用来刷新 Docker 列表 */
  dockerSudoBySession: Record<string, string>
  /** 网站服务（nginx/caddy）配置采集缓存，按会话存，at 用法同 dockerBySession */
  webBySession: Record<string, { info: WebInfo | null; at: number }>
  /** SFTP 传输记录按服务器会话归属，同一服务器的多个终端标签共用。speed 为字节/秒 */
  transfersBySession: Record<string, (SftpTransferEvent & { speed: number })[]>
  /** 主机地址归一化后的备注，同一台机器上的连接共用 */
  hostNotes: Record<string, string>
  sessionStatus: Record<string, SessionStatus>
  /** 每个终端（标签）的连接状态 */
  termState: Record<string, TermState>
  tabs: Tab[]
  /** 焦点所在的标签。分屏时是最后点过的那一栏显示的标签，文件面板、片段、历史都跟它走 */
  activeTabId: string | null
  /** 左右或上下分屏，null 表示不分屏 */
  split: SplitState | null

  /** 右侧面板是否打开 */
  rightPanelOpen: boolean
  /** 主机页是否打开。开着终端也能切回主机页，标签压在下面不关。 */
  hostsOpen: boolean
  toggleHostsOpen: () => void
  setHostsOpen: (open: boolean) => void
  /** 工具页是否打开，行为与主机页一致 */
  toolsOpen: boolean
  toggleToolsOpen: () => void
  setToolsOpen: (open: boolean) => void
  /** 右侧面板当前板块 */
  rightPanelPane: RightPanelPane
  search: string
  /** 各终端标签下打开的文件，按 termId 归属，关终端时一起清掉 */
  editorTabs: EditorTab[]
  /** 每个终端标签正在看的文件 key，没有表示显示终端。会话分栏时是焦点那一侧的文件 */
  editorKeyByTerm: Record<string, string>
  /** 会话窗口内部的分栏，按会话标签 id。和窗口 split 互斥 */
  sessionSplit: Record<string, SessionSplit>
  /** 会话分栏里另开的终端，不进顶栏 */
  sideTerms: SideTerm[]
  /** 已打开运维面板的终端标签，互不影响。 */
  opsPanelTermIds: string[]
  /** 云浏览器静态预览的标签；只控制界面，不启动远端服务。 */
  browserPreviewTermIds: string[]

  /** 会话编辑弹窗。host 表示在这台机器下再加一条连接 */
  editing:
    | null
    | { action: 'create'; host?: string; port?: number }
    | { action: 'edit'; session: SessionConfig }
  settingsOpen: boolean
  appearance: Appearance
  /** 跟随系统时，这里是当前真正用上的浅色或深色。 */
  resolvedApp: ResolvedAppTheme
  mcp: McpSettings | null
  mcpRuntime: McpRuntime
  notice: string | null

  loadSessions: () => Promise<void>
  loadLocalShells: () => Promise<void>
  setHostNote: (hostKey: string, remark: string) => Promise<void>
  loadAppearance: () => Promise<void>
  setAppearance: (patch: Partial<Appearance>) => Promise<void>
  loadMcp: () => Promise<void>
  onMcpState: (state: McpRuntime) => void
  onMcpOpenTab: (tab: McpOpenTab) => void
  onMcpCloseTab: (termId: string) => void
  /** 执行 MCP 发来的分栏。成功时 termId 是标签内新开的终端；失败时 error 说明原因。 */
  applyMcpSplit: (kind: 'window' | 'inside', termId: string) => { error?: string; termId?: string }
  onSessionsChanged: (sessions: SessionConfig[]) => void
  /** 取服务器静态身份：有缓存且 10 分钟内就直接用，否则重新采一次 */
  loadServerInfo: (sessionId: string) => void
  /** 采一次动态指标写进共用缓存；同一会话上一次没回来就跳过。quiet 时失败不记错误（连上时的预取） */
  collectMetrics: (sessionId: string, quiet?: boolean) => Promise<void>
  /** 有面板在显示这台服务器时调用：同一会话只有一个 3 秒采集器，最后一个面板退订才停。返回退订函数 */
  watchMetrics: (sessionId: string) => () => void
  /** 取 Docker 列表：15 秒内有缓存（含在途）就直接用，force 强制重采 */
  loadDockerInfo: (sessionId: string, force?: boolean) => Promise<void>
  /** 记住 sudo 密码并立刻重采。密码不对时 loadDockerInfo 会清掉 */
  setDockerSudo: (sessionId: string, password: string) => Promise<void>
  loadWebInfo: (sessionId: string, force?: boolean) => void
  saveMcp: (input: McpSettingsInput) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  /** sticky 为真时不自动消失（长时间任务的进行态），等下一条提示顶掉 */
  setNotice: (notice: string | null, sticky?: boolean) => void
  deleteSession: (id: string) => Promise<void>

  openSessionTab: (session: SessionConfig, fresh?: boolean) => void
  openLocalTab: (shell?: LocalShell, cwd?: string) => void
  /** 资源管理器右键：用 + 菜单里排第一的本机终端，打开这个目录 */
  openAtDir: (dir: string) => Promise<void>
  closeTab: (tabId: string) => void
  reconnectTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  setActiveTab: (tabId: string) => void
  /** 标签栏拖动排序：按 id 数组重排 tabs（不在数组里的保持相对顺序排在后面）。
      分屏时数组里带 SPLIT_MARK，它后面的标签归辅栏 */
  reorderTabs: (ids: string[]) => void
  /** 右键标签「分右栏」：这个标签单独进辅栏。已有会话分栏时不做 */
  splitTab: (tabId: string, dir: SplitDir) => void
  /** 右键文件条「分右栏」：当前会话内左主右辅。已有窗口分栏时不做 */
  splitSessionView: (parentId: string, viewId: string, dir: SplitDir) => void
  /** 文件条拖动排序。ids 里带 SPLIT_MARK，主终端不在其中。辅栏空了就收起分栏 */
  reorderSessionStrip: (parentId: string, ids: string[]) => void
  /** 收起这个会话的内部分栏，并关掉为它另开的终端 */
  cancelSessionSplit: (parentId: string) => void
  /** 点文件条上的一项：只换它所在的那一侧 */
  activateSessionView: (parentId: string, viewId: string) => void
  /** 点进某一侧，工具按钮跟着这一侧 */
  focusSessionSide: (parentId: string, side: 'primary' | 'secondary') => void
  setSessionSplitRatio: (parentId: string, ratio: number) => void
  /** 关掉分栏里另开的那个终端。它是辅栏最后一项时收起分栏 */
  closeSideTerm: (termId: string) => void
  /** 拖动两栏中间的分隔线，ratio 是主栏占比 */
  setSplitRatio: (ratio: number) => void
  /** 标签拖完调用：有一栏空了就取消分屏 */
  settleSplit: () => void
  /** 分屏时点进某一栏：焦点移过去，不像点标签那样收起面板 */
  focusPane: (tabId: string) => void
  /** 主进程终端状态事件入口（App 中订阅一次） */
  onTermStatus: (e: TermStatusEvent) => void
  onTermMeta: (e: { termId: string; title: string; remark: string }) => void
  onSftpTransfer: (e: SftpTransferEvent) => void
  dismissSftpTransfer: (sessionId: string, transferId: string) => void

  toggleRightPanel: () => void
  toggleOpsPanel: (termId: string) => void
  toggleBrowserPreview: (termId: string) => void
  setRightPanelPane: (pane: RightPanelPane) => void
  /** readOnly 不传时沿用已打开标签的模式，新标签默认查看 */
  openRemoteEditor: (
    termId: string,
    sessionId: string | null,
    file: { path: string; name: string },
    pin?: boolean,
    readOnly?: boolean
  ) => void
  setEditorReadOnly: (key: string, readOnly: boolean) => void
  /** 文件标签拖动排序：按 key 数组重排（不在数组里的保持相对顺序排在后面） */
  reorderEditorTabs: (keys: string[]) => void
  /** 编辑器自动换行，所有文件共用，记在本地 */
  editorWrap: boolean
  toggleEditorWrap: () => void
  closeEditorTab: (key: string) => void
  /** 切换这个终端标签看的文件，key 为 null 表示回到终端，文件标签保留 */
  activateEditorTab: (termId: string, key: string | null) => void
  setEditorDirty: (key: string, dirty: boolean) => void
  pinEditorTab: (key: string) => void
  setSearch: (v: string) => void
  setEditing: (
    v:
      | null
      | { action: 'create'; host?: string; port?: number }
      | { action: 'edit'; session: SessionConfig }
  ) => void
}

export type EditingState = AppState['editing']

let noticeTimer: ReturnType<typeof setTimeout> | undefined
const bootAppearance = readCachedAppearance()

/**
 * 面板内容硬性互斥：打开/切换终端时关掉编辑表单；
 * 从主机编辑面板切走时整个右侧面板一起收，终端之间切换不动面板开关。
 */
function closeOverlaysPatch(get: () => AppState): Partial<AppState> {
  return { editing: null, ...(get().editing ? { rightPanelOpen: false } : {}) }
}

export type SplitDir = 'right' | 'down'

/** 文件条上的终端项。文件项直接用 editor key。 */
export function termViewId(termId: string): string {
  return `term:${termId}`
}

export function termIdFromView(view: string): string | null {
  return view.startsWith('term:') ? view.slice(5) : null
}

/** 会话分栏里另开的终端。进程独立，文件和运维面板仍归所属会话。 */
export interface SideTerm {
  id: string
  parentId: string
  title: string
}

/** 一个会话窗口内部的左右（或上下）分栏。左侧是主，右侧是辅。 */
export interface SessionSplit {
  dir: SplitDir
  ratio: number
  /** 主终端以外的标签，从左到右。辅栏是其中靠右的一段 */
  order: string[]
  /** 辅栏里的文件条项。其余都在主栏 */
  secondary: string[]
  primaryView: string
  secondaryView: string
  /** 保存、换行这些按钮跟着这一侧 */
  focus: 'primary' | 'secondary'
}

export interface SplitState {
  dir: SplitDir
  /** 辅栏（右 / 下）里的标签，其余都在主栏。tabs 数组里主栏的标签排在前面 */
  secondary: string[]
  /** 两栏各自显示的标签。拖动标签途中某一栏可能暂时是空的 */
  primaryTab: string | null
  secondaryTab: string | null
  /** 主栏占比 */
  ratio: number
}

/** 标签栏里那条分隔竖线在拖动排序时的占位 id */
export const SPLIT_MARK = '__split__'

/**
 * 标签或焦点变了之后把分屏理顺：主栏标签排在前面；各栏显示的标签没了就换成这一栏最后一个；
 * 焦点标签在哪一栏，那一栏就显示它。keepEmpty 为假时，有一栏空了就取消分屏。
 */
function withTabs(
  get: () => AppState,
  tabs: Tab[],
  activeTabId: string | null,
  keepEmpty = false
): Pick<AppState, 'tabs' | 'activeTabId' | 'split'> {
  const split = get().split
  if (!split) return { tabs, activeTabId, split: null }
  const inSecondary = new Set(split.secondary)
  const primary = tabs.filter((tab) => !inSecondary.has(tab.id))
  const secondary = tabs.filter((tab) => inSecondary.has(tab.id))
  const pick = (list: Tab[], current: string | null) => {
    if (list.some((tab) => tab.id === activeTabId)) return activeTabId
    if (list.some((tab) => tab.id === current)) return current
    return list[list.length - 1]?.id ?? null
  }
  const next: SplitState = {
    ...split,
    secondary: secondary.map((tab) => tab.id),
    primaryTab: pick(primary, split.primaryTab),
    secondaryTab: pick(secondary, split.secondaryTab)
  }
  const empty = !next.primaryTab || !next.secondaryTab
  return { tabs: [...primary, ...secondary], activeTabId, split: empty && !keepEmpty ? null : next }
}

/** 关掉这个会话为分栏另开的终端，并拿掉分栏状态。 */
function releaseSideTerms(state: AppState, parentId: string): Pick<AppState, 'sideTerms' | 'termState' | 'sessionSplit'> {
  const sides = state.sideTerms.filter((term) => term.parentId === parentId)
  for (const term of sides) {
    window.api.term.close(term.id)
    terminalPool.dispose(term.id)
  }
  const termState = { ...state.termState }
  for (const term of sides) delete termState[term.id]
  const sessionSplit = { ...state.sessionSplit }
  delete sessionSplit[parentId]
  return {
    sideTerms: state.sideTerms.filter((term) => term.parentId !== parentId),
    termState,
    sessionSplit
  }
}

/** 主终端以外的标签顺序。旧状态没有 order 时，辅栏那些排在后面。 */
function stripOrder(pane: SessionSplit): string[] {
  return pane.order?.length ? pane.order : pane.secondary
}

/** 把一项放到焦点所在的那一侧，并保持从左到右的顺序。辅栏空了就返回 null。 */
function assignSessionView(pane: SessionSplit, parentId: string, viewId: string, side: 'primary' | 'secondary'): SessionSplit | null {
  const without = stripOrder(pane).filter((id) => id !== viewId)
  const stayRight = new Set(pane.secondary.filter((id) => id !== viewId))
  let secondary = pane.secondary.filter((id) => id !== viewId)
  let order: string[]
  if (side === 'secondary') {
    secondary = [...secondary, viewId]
    order = [...without, viewId]
  } else {
    const left = without.filter((id) => !stayRight.has(id))
    const right = without.filter((id) => stayRight.has(id))
    order = [...left, viewId, ...right]
  }
  let primaryView = pane.primaryView
  let secondaryView = pane.secondaryView
  if (side === 'primary') {
    primaryView = viewId
    if (secondaryView === viewId) secondaryView = secondary.at(-1) ?? ''
  } else {
    secondaryView = viewId
    if (primaryView === viewId) primaryView = termViewId(parentId)
  }
  if (primaryView === secondaryView) return null
  if (!secondary.length || !secondaryView) {
    return { ...pane, order, secondary: [], primaryView, secondaryView: '', focus: 'primary' }
  }
  return { ...pane, order, secondary, primaryView, secondaryView, focus: side }
}

/** 只重排这个会话自己的文件，其它会话的文件位置不动。 */
function orderTermFiles(tabs: EditorTab[], termId: string, keys: string[]): EditorTab[] {
  const pos = new Map(keys.map((key, index) => [key, index]))
  const sorted = tabs
    .filter((tab) => tab.termId === termId)
    .sort((a, b) => (pos.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.key) ?? Number.MAX_SAFE_INTEGER))
  let index = 0
  return tabs.map((tab) => (tab.termId === termId ? sorted[index++]! : tab))
}

function editorKeyFor(map: Record<string, string>, parentId: string, view: string): Record<string, string> {
  if (!view || termIdFromView(view)) return withoutKey(map, parentId)
  return { ...map, [parentId]: view }
}

/** 去掉对象里的一个键；本来就没有时原样返回，免得无谓地触发重渲染 */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

/** 标签/备注文本清洗：压缩空白、去头尾、截断。 */
function cleanLabel(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 传输速度（字节/秒）。后端每写一块就推一次进度，太密，直接相邻两次相除会乱跳。
 * 攒够 500ms 才算一次，再和上一次的速度做平滑。传完就丢掉采样。
 */
/** 每台服务器一个指标采集器：watchers 是正在显示的面板数，归零就停；inFlight 防止慢链路上请求叠起来 */
const metricsWatch = new Map<string, { watchers: number; timer: number }>()
const metricsInFlight = new Set<string>()
const METRICS_INTERVAL = 3000

const transferSamples = new Map<string, { at: number; bytes: number; speed: number }>()
function transferSpeed(event: SftpTransferEvent): number {
  if (event.done) {
    transferSamples.delete(event.id)
    return 0
  }
  const now = performance.now()
  const last = transferSamples.get(event.id)
  if (!last) {
    transferSamples.set(event.id, { at: now, bytes: event.transferred, speed: 0 })
    return 0
  }
  const elapsed = (now - last.at) / 1000
  if (elapsed < 0.5) return last.speed
  const current = Math.max(0, event.transferred - last.bytes) / elapsed
  const speed = last.speed ? last.speed * 0.6 + current * 0.4 : current
  transferSamples.set(event.id, { at: now, bytes: event.transferred, speed })
  return speed
}

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  localShells: [],
  serverInfoBySession: {},
  metricsBySession: {},
  dockerBySession: {},
  dockerSudoBySession: {},
  webBySession: {},
  transfersBySession: {},
  hostNotes: {},
  sessionStatus: {},
  termState: {},
  tabs: [],
  activeTabId: null,
  split: null,
  sessionSplit: {},
  sideTerms: [],
  rightPanelOpen: false,
  opsPanelTermIds: [],
  browserPreviewTermIds: [],
  hostsOpen: false,
  toolsOpen: false,
  rightPanelPane: 'files',
  search: '',
  editorTabs: [],
  editorKeyByTerm: {},
  editing: null,
  settingsOpen: false,
  appearance: bootAppearance,
  resolvedApp: unifiedTheme(bootAppearance.theme).dark ? 'dark' : 'light',
  mcp: null,
  mcpRuntime: { running: false, port: MCP_DEFAULT_PORT, clients: 0 },
  notice: null,

  loadSessions: async () => {
    const [sessions, hostNotes] = await Promise.all([window.api.sessions.list(), window.api.hosts.list()])
    set({ sessions, hostNotes })
  },

  loadLocalShells: async () => {
    set({ localShells: await window.api.shells.list() })
  },

  setHostNote: async (hostKey, remark) => {
    const hostNotes = await window.api.hosts.setNote(hostKey, remark)
    set({ hostNotes })
  },

  loadAppearance: async () => {
    const appearance = await window.api.appearance.get()
    set({ appearance, resolvedApp: applyAppearance(appearance) })
  },

  setAppearance: async (patch) => {
    const prev = get().appearance
    const next = { ...prev, ...patch }
    set({ appearance: next, resolvedApp: applyAppearance(next, false) })
    try {
      const saved = await window.api.appearance.save(next)
      set({ appearance: saved, resolvedApp: applyAppearance(saved) })
    } catch (error) {
      set({ appearance: prev, resolvedApp: applyAppearance(prev) })
      throw error
    }
  },

  loadMcp: async () => {
    const [mcp, mcpRuntime] = await Promise.all([window.api.mcp.get(), window.api.mcp.state()])
    set({ mcp, mcpRuntime })
  },

  saveMcp: async (input) => {
    const mcp = await window.api.mcp.save(input)
    const mcpRuntime = await window.api.mcp.state()
    set({ mcp, mcpRuntime, settingsOpen: false })
  },

  onMcpState: (mcpRuntime) => set({ mcpRuntime }),

  onMcpOpenTab: (tab) => {
    terminalPool.ensure(tab.termId)
    window.api.mcp.bound(tab.termId)
    if (get().tabs.some((item) => item.id === tab.termId)) {
      set(withTabs(get, get().tabs, tab.termId))
      return
    }
    set(
      withTabs(
        get,
        [...get().tabs, { id: tab.termId, sessionId: tab.sessionId, kind: tab.kind, title: tab.title }],
        tab.termId
      )
    )
  },

  onMcpCloseTab: (termId) => {
    if (get().tabs.some((tab) => tab.id === termId)) get().closeTab(termId)
    else terminalPool.dispose(termId)
  },

  applyMcpSplit: (kind, termId) => {
    const state = get()
    if (!state.tabs.some((tab) => tab.id === termId)) return { error: '没有这扇终端' }
    if (kind === 'window') {
      if (state.split) return { error: '窗口已经分栏' }
      if (Object.keys(state.sessionSplit).length > 0) return { error: '已有标签内分栏' }
      if (state.tabs.length < 2) return { error: '至少要两扇标签才能分到右栏' }
      state.splitTab(termId, 'right')
      if (!get().split) return { error: '没能分到右栏' }
      return {}
    }
    if (state.split) return { error: '窗口已经分栏' }
    if (state.sessionSplit[termId]) return { error: '这扇标签已经分栏' }
    state.splitSessionView(termId, termViewId(termId), 'right')
    const pane = get().sessionSplit[termId]
    if (!pane) return { error: '没能在标签内分栏' }
    return { termId: termIdFromView(pane.secondaryView) ?? undefined }
  },

  onSessionsChanged: (sessions) => {
    const ids = new Set(sessions.map((session) => session.id))
    set({ sessions })
    for (const tab of get().tabs) {
      if (tab.sessionId && !ids.has(tab.sessionId)) get().closeTab(tab.id)
    }
  },

  loadServerInfo: (sessionId) => {
    const cached = get().serverInfoBySession[sessionId]
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return
    void window.api.sessions
      .serverInfo(sessionId)
      .then((info) =>
        set({
          serverInfoBySession: { ...get().serverInfoBySession, [sessionId]: { info, at: Date.now() } }
        })
      )
      .catch(() => undefined)
  },

  collectMetrics: async (sessionId, quiet = false) => {
    if (metricsInFlight.has(sessionId)) return
    metricsInFlight.add(sessionId)
    try {
      const metrics = await window.api.sessions.metrics(sessionId)
      set({ metricsBySession: { ...get().metricsBySession, [sessionId]: { metrics, error: '', at: Date.now() } } })
    } catch (e) {
      if (quiet) return
      // 失败保留上一次成功的数据，只记错误
      const prev = get().metricsBySession[sessionId]
      set({
        metricsBySession: {
          ...get().metricsBySession,
          [sessionId]: {
            metrics: prev?.metrics ?? null,
            error: e instanceof Error ? e.message : String(e),
            at: prev?.at ?? 0
          }
        }
      })
    } finally {
      metricsInFlight.delete(sessionId)
    }
  },

  watchMetrics: (sessionId) => {
    const existing = metricsWatch.get(sessionId)
    if (existing) {
      existing.watchers++
    } else {
      void get().collectMetrics(sessionId)
      const timer = window.setInterval(() => void get().collectMetrics(sessionId), METRICS_INTERVAL)
      metricsWatch.set(sessionId, { watchers: 1, timer })
    }
    let done = false
    return () => {
      if (done) return
      done = true
      const w = metricsWatch.get(sessionId)
      if (!w) return
      w.watchers--
      if (w.watchers > 0) return
      window.clearInterval(w.timer)
      metricsWatch.delete(sessionId)
    }
  },

  loadDockerInfo: (sessionId, force = false) => {
    const cached = get().dockerBySession[sessionId]
    const now = Date.now()
    // at 开始时就写：15 秒内的重复调用（含还在跑的）都跳过
    if (!force && cached && now - cached.at < 15 * 1000) return Promise.resolve()
    const password = get().dockerSudoBySession[sessionId] ?? ''
    set({ dockerBySession: { ...get().dockerBySession, [sessionId]: { info: cached?.info ?? null, at: now } } })
    const stillLatest = () => (get().dockerBySession[sessionId]?.at ?? 0) <= now
    return window.api.sessions
      .docker(sessionId, password)
      .then((info) => {
        // 后发起的采集先回来时，丢掉这次，避免没权限的空列表盖住 sudo 结果
        if (!stillLatest()) return
        set({ dockerBySession: { ...get().dockerBySession, [sessionId]: { info, at: Date.now() } } })
      })
      .catch((e) => {
        if (!stillLatest()) return
        const message = e instanceof Error ? e.message : String(e)
        if (!password || !message.includes('密码')) return
        const next = { ...get().dockerSudoBySession }
        delete next[sessionId]
        const prev = get().dockerBySession[sessionId]?.info
        const info: DockerInfo = {
          available: true,
          needSudo: true,
          running: false,
          containers: [],
          images: [],
          volumes: [],
          networks: [],
          daemonJson: prev?.daemonJson ?? ''
        }
        set({
          dockerSudoBySession: next,
          dockerBySession: { ...get().dockerBySession, [sessionId]: { info, at: Date.now() } }
        })
        get().setNotice('sudo 密码不对')
      })
  },

  setDockerSudo: (sessionId, password) => {
    set({ dockerSudoBySession: { ...get().dockerSudoBySession, [sessionId]: password } })
    return get().loadDockerInfo(sessionId, true)
  },

  loadWebInfo: (sessionId, force = false) => {
    const cached = get().webBySession[sessionId]
    const now = Date.now()
    // at 开始时就写：15 秒内的重复调用（含还在跑的）都跳过
    if (!force && cached && now - cached.at < 15 * 1000) return
    set({ webBySession: { ...get().webBySession, [sessionId]: { info: cached?.info ?? null, at: now } } })
    void window.api.sessions
      .web(sessionId)
      .then((info) =>
        set({ webBySession: { ...get().webBySession, [sessionId]: { info, at: Date.now() } } })
      )
      .catch(() => undefined)
  },

  setSettingsOpen: (open) =>
    set(open ? { settingsOpen: true, hostsOpen: false, toolsOpen: false, rightPanelOpen: false, editing: null } : { settingsOpen: false }),

  setNotice: (notice, sticky = false) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    set({ notice })
    if (notice && !sticky) noticeTimer = setTimeout(() => set({ notice: null }), 2000)
  },

  deleteSession: async (id) => {
    await window.api.sessions.delete(id)
    // 关掉该会话已打开的标签
    for (const t of get().tabs.filter((t) => t.sessionId === id)) {
      get().closeTab(t.id)
    }
    await get().loadSessions()
  },

  openSessionTab: (session, fresh = false) => {
    set({
      hostsOpen: false,
      toolsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
    if (!fresh) {
      const existing = get().tabs.find((t) => t.sessionId === session.id && t.kind === 'ssh')
      if (existing) {
        set(withTabs(get, get().tabs, existing.id))
        return
      }
    }
    const count = get().tabs.filter((t) => t.sessionId === session.id && t.kind === 'ssh').length
    const known = osIconProps(session.os)
    const tab: Tab = {
      id: newTermId(),
      sessionId: session.id,
      kind: 'ssh',
      title: termTitle(count + 1, session.name),
      ...known
    }
    set(withTabs(get, [...get().tabs, tab], tab.id))
    window.api.term.create({
      termId: tab.id,
      kind: 'ssh',
      sessionId: session.id,
      title: tab.title,
      cols: 80,
      rows: 24
    })
    // 连上后探测一次对端系统/发行版，更新标签图标并存回连接配置给列表图标用，失败就保持 unknown
    void window.api.sessions
      .detectOs(session.id)
      .then((info) => {
        // 连上了就顺手预取一次运维面板的数据，第一次打开面板不用等。Windows 跑不了采集脚本，跳过
        if (info?.os && info.os !== 'unknown' && info.os !== 'windows') {
          void get().collectMetrics(session.id, true)
          get().loadServerInfo(session.id)
        }
        // 连接抖一下就会探成 unknown，别把之前认出来的系统冲掉
        if (!info?.os || (info.os === 'unknown' && known.os)) return
        set({
          tabs: get().tabs.map((t) => (t.id === tab.id ? { ...t, os: info.os, distro: info.distro } : t))
        })
        const saved = info.distro ?? info.os
        if (saved !== session.os) {
          void window.api.sessions.setOs(session.id, saved).catch(() => undefined)
          set({
            sessions: get().sessions.map((s) => (s.id === session.id ? { ...s, os: saved } : s))
          })
        }
      })
      .catch(() => undefined)
  },

  openLocalTab: (shell = 'powershell', cwd) => {
    const count = get().tabs.filter((t) => t.kind === 'local').length
    const platform = window.api.platform
    const tab: Tab = {
      id: newTermId(),
      sessionId: null,
      kind: 'local',
      title: termTitle(count + 1, shellLabel(shell)),
      os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
      shell
    }
    set({
      ...withTabs(get, [...get().tabs, tab], tab.id),
      hostsOpen: false,
      toolsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
    window.api.term.create({
      termId: tab.id,
      kind: 'local',
      title: tab.title,
      shell,
      cols: 80,
      rows: 24,
      ...(cwd ? { cwd } : {})
    })
  },

  openAtDir: async (dir) => {
    const path = dir.trim()
    if (!path) return
    if (get().localShells.length === 0) await get().loadLocalShells()
    get().openLocalTab(firstOrderedShell(get().localShells), path)
  },

  renameTab: (tabId, title) => {
    const name = cleanLabel(title, 80)
    if (!name) return
    set({ tabs: get().tabs.map((tab) => (tab.id === tabId ? { ...tab, title: name } : tab)) })
    window.api.term.label(tabId, { title: name })
  },

  reconnectTab: (tabId) => {
    const side = get().sideTerms.find((item) => item.id === tabId)
    if (side) {
      const parent = get().tabs.find((item) => item.id === side.parentId)
      const status = get().termState[tabId]?.status
      if (!parent || status === 'connected' || status === 'connecting') return
      if (parent.kind === 'local') {
        terminalPool.clear(side.id)
        window.api.term.bindView(side.id)
      }
      window.api.term.create({
        termId: side.id,
        kind: parent.kind,
        sessionId: parent.sessionId ?? undefined,
        title: side.title,
        shell: parent.kind === 'local' ? parent.shell : undefined,
        ...(terminalPool.size(side.id) ?? { cols: 80, rows: 24 })
      })
      return
    }
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    const status = get().termState[tabId]?.status
    if (status === 'connected' || status === 'connecting') return
    set({
      ...withTabs(get, get().tabs, tabId),
      editorKeyByTerm: withoutKey(get().editorKeyByTerm, tabId)
    })
    if (tab.kind === 'local') {
      terminalPool.clear(tab.id)
      window.api.term.bindView(tab.id)
    }
    window.api.term.create({
      termId: tab.id,
      kind: tab.kind,
      sessionId: tab.sessionId ?? undefined,
      title: tab.title,
      shell: tab.kind === 'local' ? tab.shell : undefined,
      ...(terminalPool.size(tab.id) ?? { cols: 80, rows: 24 })
    })
  },

  closeTab: (tabId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId)
    const split = get().split
    let activeTabId = get().activeTabId
    if (activeTabId === tabId) {
      // 分屏时先在同一栏里找下一个；这一栏空了，焦点落到另一栏显示的标签
      const secondaryClosed = split?.secondary.includes(tabId) ?? false
      const sameSide = split ? tabs.filter((t) => split.secondary.includes(t.id) === secondaryClosed) : tabs
      const otherSide = split ? (secondaryClosed ? split.primaryTab : split.secondaryTab) : null
      activeTabId = sameSide[sameSide.length - 1]?.id ?? otherSide ?? tabs[tabs.length - 1]?.id ?? null
    }
    const termState = { ...get().termState }
    delete termState[tabId]
    const editorTabs = get().editorTabs.filter((t) => {
      if (t.termId !== tabId) return true
      dropBuffer(t.key)
      return false
    })
    const editorKeyByTerm = withoutKey(get().editorKeyByTerm, tabId)
    const opsPanelTermIds = get().opsPanelTermIds.filter((id) => id !== tabId)
    const browserPreviewTermIds = get().browserPreviewTermIds.filter((id) => id !== tabId)
    const released = releaseSideTerms({ ...get(), termState }, tabId)
    set({
      ...withTabs(get, tabs, activeTabId),
      termState: released.termState,
      editorTabs,
      editorKeyByTerm,
      opsPanelTermIds,
      browserPreviewTermIds,
      sessionSplit: released.sessionSplit,
      sideTerms: released.sideTerms
    })
    // 先断主进程连接，再销毁 xterm 实例。releaseSideTerms 已经关掉另开的终端
    window.api.term.close(tabId)
    terminalPool.dispose(tabId)
  },

  setActiveTab: (tabId) => {
    // 点标签回到这个标签的终端，打开的文件标签保留。会话分栏开着时不收起
    const keepSplit = !!get().sessionSplit[tabId]
    set({
      ...withTabs(get, get().tabs, tabId),
      ...(keepSplit ? {} : { editorKeyByTerm: withoutKey(get().editorKeyByTerm, tabId) }),
      hostsOpen: false,
      toolsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
  },

  reorderTabs: (ids) => {
    const pos = new Map(ids.map((id, index) => [id, index]))
    const tabs = [...get().tabs].sort(
      (a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
    const split = get().split
    const mark = ids.indexOf(SPLIT_MARK)
    if (split && mark >= 0) {
      // 拖过分隔竖线就换栏。拖动途中允许某一栏空着，松手时 settleSplit 再决定是否取消分屏
      set({ split: { ...split, secondary: ids.slice(mark + 1) } })
      set(withTabs(get, tabs, get().activeTabId, true))
      return
    }
    set({ tabs })
  },

  splitTab: (tabId, dir) => {
    const { tabs, activeTabId, split } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (split || !tab || tabs.length < 2 || Object.keys(get().sessionSplit).length > 0) return
    const others = tabs.filter((t) => t.id !== tabId)
    const primaryTab = activeTabId && activeTabId !== tabId ? activeTabId : others[others.length - 1].id
    set({
      split: { dir, secondary: [tabId], primaryTab, secondaryTab: tabId, ratio: 0.5 },
      hostsOpen: false,
      toolsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
    set(withTabs(get, [...others, tab], tabId))
  },

  setSplitRatio: (ratio) => {
    const split = get().split
    if (split) set({ split: { ...split, ratio: Math.min(0.85, Math.max(0.15, ratio)) } })
  },

  settleSplit: () => {
    if (get().split) set(withTabs(get, get().tabs, get().activeTabId))
  },

  focusPane: (tabId) => {
    if (get().split && get().activeTabId !== tabId) set(withTabs(get, get().tabs, tabId))
  },

  splitSessionView: (parentId, viewId, dir) => {
    if (get().split || get().sessionSplit[parentId]) return
    const tab = get().tabs.find((item) => item.id === parentId)
    if (!tab) return
    const primaryTerm = termViewId(parentId)
    const currentView = get().editorKeyByTerm[parentId] ?? primaryTerm
    let sideTerms = get().sideTerms
    let secondaryView = viewId
    let primaryView = currentView === viewId ? primaryTerm : currentView
    let created: { id: string; title: string } | null = null
    if (viewId === primaryTerm && currentView === primaryTerm) {
      const id = newTermId()
      const title = `终端 (${sideTerms.filter((item) => item.parentId === parentId).length + 2})`
      sideTerms = [...sideTerms, { id, parentId, title }]
      secondaryView = termViewId(id)
      primaryView = primaryTerm
      created = { id, title }
    } else if (viewId === primaryTerm) {
      primaryView = currentView
      secondaryView = primaryTerm
    }
    if (primaryView === secondaryView) return
    const files = get().editorTabs.filter((item) => item.termId === parentId).map((item) => item.key)
    const order = [...files.filter((id) => id !== secondaryView && id !== primaryTerm), secondaryView]
    set({
      sideTerms,
      sessionSplit: {
        ...get().sessionSplit,
        [parentId]: {
          dir,
          ratio: 0.5,
          order,
          secondary: [secondaryView],
          primaryView,
          secondaryView,
          focus: 'secondary'
        }
      },
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, secondaryView),
      opsPanelTermIds: get().opsPanelTermIds.filter((id) => id !== parentId),
      hostsOpen: false,
      toolsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
    if (created) {
      window.api.term.create({
        termId: created.id,
        kind: tab.kind,
        sessionId: tab.sessionId ?? undefined,
        title: created.title,
        shell: tab.kind === 'local' ? tab.shell : undefined,
        cols: 80,
        rows: 24
      })
    }
  },

  cancelSessionSplit: (parentId) => {
    const pane = get().sessionSplit[parentId]
    if (!pane) return
    const view = pane.primaryView
    set({
      ...releaseSideTerms(get(), parentId),
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, view)
    })
  },

  activateSessionView: (parentId, viewId) => {
    const pane = get().sessionSplit[parentId]
    if (!pane) return
    const onRight = pane.secondary.includes(viewId)
    const next: SessionSplit = {
      ...pane,
      focus: onRight ? 'secondary' : 'primary',
      primaryView: onRight ? pane.primaryView : viewId,
      secondaryView: onRight ? viewId : pane.secondaryView
    }
    const shown = next.focus === 'secondary' ? next.secondaryView : next.primaryView
    set({
      sessionSplit: { ...get().sessionSplit, [parentId]: next },
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, shown)
    })
  },

  focusSessionSide: (parentId, side) => {
    const pane = get().sessionSplit[parentId]
    if (!pane || pane.focus === side) return
    const shown = side === 'secondary' ? pane.secondaryView : pane.primaryView
    if (!shown) {
      set({ sessionSplit: { ...get().sessionSplit, [parentId]: { ...pane, focus: side } } })
      return
    }
    set({
      sessionSplit: { ...get().sessionSplit, [parentId]: { ...pane, focus: side } },
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, shown)
    })
  },

  reorderSessionStrip: (parentId, ids) => {
    const pane = get().sessionSplit[parentId]
    const mark = ids.indexOf(SPLIT_MARK)
    if (!pane || mark < 0) return
    const primary = termViewId(parentId)
    const pinnedRight = pane.secondary.includes(primary)
    const left = ids.slice(0, mark).filter((id) => id !== SPLIT_MARK && id !== primary)
    let right = ids.slice(mark + 1).filter((id) => id !== SPLIT_MARK && id !== primary)
    if (pinnedRight) {
      const at = Math.min(Math.max(pane.secondary.indexOf(primary), 0), right.length)
      right = [...right.slice(0, at), primary, ...right.slice(at)]
    }
    const fileKeys = [...left, ...right].filter((id) => !termIdFromView(id))
    const editorTabs = orderTermFiles(get().editorTabs, parentId, fileKeys)
    if (!right.length) {
      const primaryView = left.includes(pane.primaryView) || pane.primaryView === primary ? pane.primaryView : (left.at(-1) ?? primary)
      set({
        editorTabs,
        editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, primaryView),
        sessionSplit: {
          ...get().sessionSplit,
          [parentId]: { ...pane, order: left, secondary: [], primaryView, secondaryView: '', focus: 'primary' }
        }
      })
      return
    }
    let primaryView = pane.primaryView
    let secondaryView = pane.secondaryView
    let focus = pane.focus
    if (right.includes(primaryView)) {
      secondaryView = primaryView
      primaryView = left.at(-1) ?? primary
      if (pane.focus === 'primary') focus = 'secondary'
    } else if (left.includes(secondaryView)) {
      primaryView = secondaryView
      secondaryView = right.at(-1) ?? secondaryView
      if (pane.focus === 'secondary') focus = 'primary'
    }
    if (!right.includes(secondaryView)) secondaryView = right.at(-1) ?? secondaryView
    if (primaryView !== primary && !left.includes(primaryView)) primaryView = left.at(-1) ?? primary
    const shown = focus === 'secondary' ? secondaryView : primaryView
    set({
      editorTabs,
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, parentId, shown),
      sessionSplit: {
        ...get().sessionSplit,
        [parentId]: { ...pane, order: [...left, ...right], secondary: right, primaryView, secondaryView, focus }
      }
    })
  },

  setSessionSplitRatio: (parentId, ratio) => {
    const pane = get().sessionSplit[parentId]
    if (!pane) return
    set({
      sessionSplit: {
        ...get().sessionSplit,
        [parentId]: { ...pane, ratio: Math.min(0.85, Math.max(0.15, ratio)) }
      }
    })
  },

  closeSideTerm: (termId) => {
    const side = get().sideTerms.find((item) => item.id === termId)
    if (!side) return
    window.api.term.close(termId)
    terminalPool.dispose(termId)
    const termState = { ...get().termState }
    delete termState[termId]
    const sideTerms = get().sideTerms.filter((item) => item.id !== termId)
    const pane = get().sessionSplit[side.parentId]
    const view = termViewId(termId)
    if (!pane) {
      set({ sideTerms, termState })
      return
    }
    const secondary = pane.secondary.filter((id) => id !== view)
    const order = stripOrder(pane).filter((id) => id !== view)
    const secondaryView = pane.secondaryView === view ? (secondary.at(-1) ?? '') : pane.secondaryView
    const primaryView = pane.primaryView === view ? termViewId(side.parentId) : pane.primaryView
    if (!secondary.length || !secondaryView || primaryView === secondaryView) {
      const sessionSplit = { ...get().sessionSplit }
      delete sessionSplit[side.parentId]
      set({
        sideTerms,
        termState,
        sessionSplit,
        editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, side.parentId, primaryView)
      })
      return
    }
    const focusView = pane.focus === 'secondary' ? secondaryView : primaryView
    set({
      sideTerms,
      termState,
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, side.parentId, focusView),
      sessionSplit: {
        ...get().sessionSplit,
        [side.parentId]: { ...pane, order, secondary, primaryView, secondaryView }
      }
    })
  },

  onTermStatus: (e) => {
    const previous = get().termState[e.termId]
    const termState = { ...get().termState, [e.termId]: { status: e.status, error: e.error } }
    const patch: Partial<AppState> = { termState }
    // 终端状态点亮所属会话
    if (e.sessionId && get().tabs.some((t) => t.id === e.termId && t.kind === 'ssh')) {
      const st: SessionStatus = e.status === 'error' ? 'disconnected' : (e.status as SessionStatus)
      patch.sessionStatus = { ...get().sessionStatus, [e.sessionId]: st }
    }
    set(patch)
    if (e.status === 'connected') {
      requestAnimationFrame(() => terminalPool.focus(e.termId))
    }
    const down = e.status === 'error' || e.status === 'disconnected'
    const changed = previous?.status !== e.status || (e.error && e.error !== previous?.error)
    if (down && changed) {
      const message = e.error || '连接已断开，请重新连接'
      terminalPool.write(e.termId, `\r\n\x1b[1;31m✗ ${connErrorText(message)}\x1b[0m\r\n`)
    }
  },

  onTermMeta: (e) => {
    set({
      tabs: get().tabs.map((tab) => (tab.id === e.termId ? { ...tab, title: e.title || tab.title, remark: e.remark } : tab))
    })
  },

  onSftpTransfer: (raw) => {
    const event = { ...raw, speed: transferSpeed(raw) }
    const list = get().transfersBySession[event.sessionId] ?? []
    const index = list.findIndex((item) => item.id === event.id)
    const transfers = index < 0 ? [...list, event] : list.map((item, i) => (i === index ? event : item))
    set({ transfersBySession: { ...get().transfersBySession, [event.sessionId]: transfers } })
    if (event.done && !event.error) {
      setTimeout(() => get().dismissSftpTransfer(event.sessionId, event.id), 10000)
    }
  },

  dismissSftpTransfer: (sessionId, transferId) => {
    const transfers = (get().transfersBySession[sessionId] ?? []).filter((item) => item.id !== transferId)
    set({ transfersBySession: { ...get().transfersBySession, [sessionId]: transfers } })
  },

  // 面板内容硬性互斥：开文件面板就关掉编辑表单
  toggleRightPanel: () => set({ rightPanelOpen: !get().rightPanelOpen, editing: null }),

  // 文件盖在最上层：没分栏时，开面板把正在看的文件退到后台（标签不丢），不然面板出不来。
  // 会话分栏留着，面板只占主栏，辅栏的终端和文件不动
  toggleOpsPanel: (termId) => {
    const open = get().opsPanelTermIds
    if (open.includes(termId)) {
      set({ opsPanelTermIds: open.filter((id) => id !== termId) })
      return
    }
    const splitOn = !!get().sessionSplit[termId]
    set({
      opsPanelTermIds: [...open, termId],
      // 云浏览器和它占同一块地方，展开运维面板先收起云浏览器
      browserPreviewTermIds: get().browserPreviewTermIds.filter((id) => id !== termId),
      ...(splitOn ? {} : { editorKeyByTerm: withoutKey(get().editorKeyByTerm, termId) })
    })
  },

  toggleBrowserPreview: (termId) => {
    const open = get().browserPreviewTermIds
    const opening = !open.includes(termId)
    set({
      browserPreviewTermIds: opening ? [...open, termId] : open.filter((id) => id !== termId),
      // 同上，展开云浏览器先收起运维面板和右侧面板
      ...(opening
        ? { opsPanelTermIds: get().opsPanelTermIds.filter((id) => id !== termId), rightPanelOpen: false }
        : {})
    })
  },

  toggleHostsOpen: () =>
    get().hostsOpen ? set({ hostsOpen: false }) : set({ hostsOpen: true, toolsOpen: false, settingsOpen: false }),
  setHostsOpen: (open) => {
    set(open ? { hostsOpen: true, toolsOpen: false, settingsOpen: false, rightPanelOpen: false } : { hostsOpen: false })
    if (open) void get().loadSessions()
  },
  toggleToolsOpen: () =>
    get().toolsOpen ? set({ toolsOpen: false }) : set({ toolsOpen: true, hostsOpen: false, settingsOpen: false }),
  setToolsOpen: (open) => {
    set(open ? { toolsOpen: true, hostsOpen: false, settingsOpen: false, rightPanelOpen: false } : { toolsOpen: false })
  },
  setRightPanelPane: (pane) => set({ rightPanelPane: pane }),
  openRemoteEditor: (termId, sessionId, file, pin = false, readOnly) => {
    const key = editorKey(termId, sessionId, file.path)
    const tabs = get().editorTabs
    const existing = tabs.find((t) => t.key === key)
    const pane = get().sessionSplit[termId]
    const place = (editorTabs: EditorTab[]) => {
      if (!pane) return { editorKeyByTerm: { ...get().editorKeyByTerm, [termId]: key } }
      const alive = new Set(editorTabs.map((tab) => tab.key))
      const keep = (id: string) => termIdFromView(id) !== null || alive.has(id)
      const secondary = pane.secondary.filter(keep)
      const primaryView = keep(pane.primaryView) ? pane.primaryView : termViewId(termId)
      const secondaryView = keep(pane.secondaryView) ? pane.secondaryView : (secondary.at(-1) ?? '')
      const placed = assignSessionView({ ...pane, secondary, primaryView, secondaryView }, termId, key, pane.focus)
      if (!placed) {
        return {
          ...releaseSideTerms(get(), termId),
          editorKeyByTerm: { ...get().editorKeyByTerm, [termId]: key }
        }
      }
      const shown = placed.focus === 'secondary' ? placed.secondaryView : placed.primaryView
      return {
        sessionSplit: { ...get().sessionSplit, [termId]: placed },
        editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, termId, shown)
      }
    }
    if (existing) {
      set({
        editorTabs: tabs.map((t) =>
          t.key === key
            ? { ...t, preview: pin ? false : t.preview, readOnly: readOnly ?? t.readOnly }
            : t
        ),
        ...place(tabs)
      })
      return
    }
    let next = tabs
    if (!pin) {
      const preview = next.find((t) => t.termId === termId && t.preview && !t.dirty)
      if (preview) {
        dropBuffer(preview.key)
        next = next.filter((t) => t.key !== preview.key)
      }
    }
    const editorTabs = [
      ...next,
      { key, termId, sessionId, path: file.path, name: file.name, preview: !pin, dirty: false, readOnly: readOnly ?? true }
    ]
    set({ editorTabs, ...place(editorTabs) })
  },
  setEditorReadOnly: (key, readOnly) =>
    set({
      editorTabs: get().editorTabs.map((t) => (t.key === key && t.readOnly !== readOnly ? { ...t, readOnly } : t))
    }),
  reorderEditorTabs: (keys) => {
    const pos = new Map(keys.map((key, index) => [key, index]))
    const editorTabs = [...get().editorTabs].sort(
      (a, b) => (pos.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    )
    set({ editorTabs })
  },
  editorWrap: localStorage.getItem(EDITOR_WRAP_KEY) !== '0',
  toggleEditorWrap: () => {
    const editorWrap = !get().editorWrap
    localStorage.setItem(EDITOR_WRAP_KEY, editorWrap ? '1' : '0')
    set({ editorWrap })
  },
  closeEditorTab: (key) => {
    dropBuffer(key)
    const current = get().editorTabs.find((t) => t.key === key)
    const editorTabs = get().editorTabs.filter((t) => t.key !== key)
    if (!current) {
      set({ editorTabs })
      return
    }
    const pane = get().sessionSplit[current.termId]
    if (!pane) {
      const editorKeyByTerm = { ...get().editorKeyByTerm }
      // 关的是这个终端正在看的文件，就换成它剩下的最后一个；都关了回到终端
      if (editorKeyByTerm[current.termId] === key) {
        const sibling = editorTabs.filter((t) => t.termId === current.termId).at(-1)
        if (sibling) editorKeyByTerm[current.termId] = sibling.key
        else delete editorKeyByTerm[current.termId]
      }
      set({ editorTabs, editorKeyByTerm })
      return
    }
    const secondary = pane.secondary.filter((id) => id !== key)
    const order = stripOrder(pane).filter((id) => id !== key)
    const leftFile = editorTabs.filter((t) => t.termId === current.termId && !secondary.includes(t.key)).at(-1)
    const primaryTerm = termViewId(current.termId)
    const primaryView = pane.primaryView === key ? (leftFile?.key ?? primaryTerm) : pane.primaryView
    const secondaryView = pane.secondaryView === key ? (secondary.at(-1) ?? '') : pane.secondaryView
    if (!secondary.length || !secondaryView || primaryView === secondaryView) {
      const keep = pane.primaryView === key ? primaryView : pane.primaryView
      set({
        editorTabs,
        ...releaseSideTerms(get(), current.termId),
        editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, current.termId, keep)
      })
      return
    }
    const next = { ...pane, order, secondary, primaryView, secondaryView }
    const shown = next.focus === 'secondary' ? next.secondaryView : next.primaryView
    set({
      editorTabs,
      editorKeyByTerm: editorKeyFor(get().editorKeyByTerm, current.termId, shown),
      sessionSplit: { ...get().sessionSplit, [current.termId]: next }
    })
  },
  activateEditorTab: (termId, key) =>
    set({
      editorKeyByTerm: key ? { ...get().editorKeyByTerm, [termId]: key } : withoutKey(get().editorKeyByTerm, termId)
    }),
  setEditorDirty: (key, dirty) =>
    set({
      editorTabs: get().editorTabs.map((t) => (t.key === key && t.dirty !== dirty ? { ...t, dirty } : t))
    }),
  pinEditorTab: (key) =>
    set({
      editorTabs: get().editorTabs.map((t) => (t.key === key && t.preview ? { ...t, preview: false } : t))
    }),
  setSearch: (v) => set({ search: v }),
  // 面板内容硬性互斥：打开编辑表单就关掉文件面板
  setEditing: (v) => set(v ? { editing: v, rightPanelOpen: false } : { editing: null })
}))

/** 连接报错翻译：Go/SSH 的英文错误映射成中文写进终端，认不出的保留原文。 */
export function connErrorText(err: string): string {
  const rules: [string, string][] = [
    ['use of closed network connection', '连接已断开'],
    ['connection refused', '拒绝连接（端口没监听或被防火墙拦了）'],
    ['i/o timeout', '连接超时（网络不通或被防火墙拦了）'],
    ['deadline exceeded', '连接超时'],
    ['no route to host', '没有到主机的路由'],
    ['no such host', '域名解析失败'],
    ['connection reset by peer', '对方重置了连接'],
    ['unable to authenticate', '认证失败（密码或密钥不对）'],
    ['permission denied', '认证失败（密码或密钥不对）'],
    ['handshake failed', 'SSH 握手失败']
  ]
  for (const [pat, text] of rules) {
    if (err.includes(pat)) return text
  }
  return err
}
