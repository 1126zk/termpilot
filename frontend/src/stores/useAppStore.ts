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
export type RightPanelPane = 'files' | 'snippets' | 'history' | 'theme'

interface AppState {
  sessions: SessionConfig[]
  localShells: LocalShellInfo[]
  /** 服务器静态身份缓存（主机名/系统/内核/IP），按会话存，带采集时间戳 */
  serverInfoBySession: Record<string, { info: ServerInfo; at: number }>
  /** Docker 采集缓存，按会话存。at 在采集开始时就写，兼作在途标记 */
  dockerBySession: Record<string, { info: DockerInfo | null; at: number }>
  /** 网站服务（nginx/caddy）配置采集缓存，按会话存，at 用法同 dockerBySession */
  webBySession: Record<string, { info: WebInfo | null; at: number }>
  /** SFTP 传输记录按服务器会话归属，同一服务器的多个终端标签共用 */
  transfersBySession: Record<string, SftpTransferEvent[]>
  /** 主机地址归一化后的备注，同一台机器上的连接共用 */
  hostNotes: Record<string, string>
  sessionStatus: Record<string, SessionStatus>
  /** 每个终端（标签）的连接状态 */
  termState: Record<string, TermState>
  tabs: Tab[]
  activeTabId: string | null

  /** 右侧面板是否打开 */
  rightPanelOpen: boolean
  /** 主机页是否打开。开着终端也能切回主机页，标签压在下面不关。 */
  hostsOpen: boolean
  toggleHostsOpen: () => void
  setHostsOpen: (open: boolean) => void
  /** 右侧面板当前板块 */
  rightPanelPane: RightPanelPane
  search: string
  /** 各终端标签下打开的文件，按 termId 归属，关终端时一起清掉 */
  editorTabs: EditorTab[]
  /** 正在看的文件。null 表示回到这台机器的终端。 */
  activeEditorKey: string | null
  /** 已打开运维面板的终端标签，互不影响。 */
  opsPanelTermIds: string[]

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
  onSessionsChanged: (sessions: SessionConfig[]) => void
  /** 取服务器静态身份：有缓存且 10 分钟内就直接用，否则重新采一次 */
  loadServerInfo: (sessionId: string) => void
  /** 取 Docker 列表：15 秒内有缓存（含在途）就直接用，force 强制重采 */
  loadDockerInfo: (sessionId: string, force?: boolean) => Promise<void>
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
  /** 标签栏拖动排序：按 id 数组重排 tabs（不在数组里的保持相对顺序排在后面） */
  reorderTabs: (ids: string[]) => void
  /** 主进程终端状态事件入口（App 中订阅一次） */
  onTermStatus: (e: TermStatusEvent) => void
  onTermMeta: (e: { termId: string; title: string; remark: string }) => void
  onSftpTransfer: (e: SftpTransferEvent) => void
  dismissSftpTransfer: (sessionId: string, transferId: string) => void

  toggleRightPanel: () => void
  toggleOpsPanel: (termId: string) => void
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
  /** null 表示回到终端，文件标签保留 */
  activateEditorTab: (key: string | null) => void
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

/** 标签/备注文本清洗：压缩空白、去头尾、截断。 */
function cleanLabel(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  localShells: [],
  serverInfoBySession: {},
  dockerBySession: {},
  webBySession: {},
  transfersBySession: {},
  hostNotes: {},
  sessionStatus: {},
  termState: {},
  tabs: [],
  activeTabId: null,
  rightPanelOpen: false,
  opsPanelTermIds: [],
  hostsOpen: false,
  rightPanelPane: 'files',
  search: '',
  editorTabs: [],
  activeEditorKey: null,
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
      set({ activeTabId: tab.termId })
      return
    }
    set({
      tabs: [
        ...get().tabs,
        { id: tab.termId, sessionId: tab.sessionId, kind: tab.kind, title: tab.title }
      ],
      activeTabId: tab.termId
    })
  },

  onMcpCloseTab: (termId) => {
    if (get().tabs.some((tab) => tab.id === termId)) get().closeTab(termId)
    else terminalPool.dispose(termId)
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

  loadDockerInfo: (sessionId, force = false) => {
    const cached = get().dockerBySession[sessionId]
    const now = Date.now()
    // at 开始时就写：15 秒内的重复调用（含还在跑的）都跳过
    if (!force && cached && now - cached.at < 15 * 1000) return Promise.resolve()
    set({ dockerBySession: { ...get().dockerBySession, [sessionId]: { info: cached?.info ?? null, at: now } } })
    return window.api.sessions
      .docker(sessionId)
      .then((info) =>
        set({ dockerBySession: { ...get().dockerBySession, [sessionId]: { info, at: Date.now() } } })
      )
      .catch(() => undefined)
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
    set(open ? { settingsOpen: true, hostsOpen: false, rightPanelOpen: false, editing: null } : { settingsOpen: false }),

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
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
    if (!fresh) {
      const existing = get().tabs.find((t) => t.sessionId === session.id && t.kind === 'ssh')
      if (existing) {
        set({ activeTabId: existing.id })
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
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
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
      tabs: [...get().tabs, tab],
      activeTabId: tab.id,
      hostsOpen: false,
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
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    const status = get().termState[tabId]?.status
    if (status === 'connected' || status === 'connecting') return
    set({
      activeTabId: tabId,
      activeEditorKey: null
    })
    window.api.term.create({
      termId: tab.id,
      kind: tab.kind,
      sessionId: tab.sessionId ?? undefined,
      title: tab.title,
      ...(terminalPool.size(tab.id) ?? { cols: 80, rows: 24 })
    })
  },

  closeTab: (tabId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId)
    const activeTabId =
      get().activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId
    const termState = { ...get().termState }
    delete termState[tabId]
    const editorTabs = get().editorTabs.filter((t) => {
      if (t.termId !== tabId) return true
      dropBuffer(t.key)
      return false
    })
    const activeEditorKey = editorTabs.some((t) => t.key === get().activeEditorKey) ? get().activeEditorKey : null
    const opsPanelTermIds = get().opsPanelTermIds.filter((id) => id !== tabId)
    set({ tabs, activeTabId, termState, editorTabs, activeEditorKey, opsPanelTermIds })
    // 先断主进程连接，再销毁 xterm 实例
    window.api.term.close(tabId)
    terminalPool.dispose(tabId)
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    set({
      activeTabId: tabId,
      activeEditorKey: null,
      hostsOpen: false,
      settingsOpen: false,
      ...closeOverlaysPatch(get)
    })
  },

  reorderTabs: (ids) => {
    const pos = new Map(ids.map((id, index) => [id, index]))
    const tabs = [...get().tabs].sort(
      (a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
    set({ tabs })
  },

  onTermStatus: (e) => {
    const termState = { ...get().termState, [e.termId]: { status: e.status, error: e.error } }
    const patch: Partial<AppState> = { termState }
    // 终端状态点亮所属会话
    if (e.sessionId && get().tabs.some((t) => t.id === e.termId && t.kind === 'ssh')) {
      const st: SessionStatus = e.status === 'error' ? 'disconnected' : (e.status as SessionStatus)
      patch.sessionStatus = { ...get().sessionStatus, [e.sessionId]: st }
    }
    set(patch)
    // 连接失败时把错误写进终端，用户能直接看到（翻译成中文）
    if (e.status === 'error' && e.error) {
      terminalPool.write(e.termId, `\r\n\x1b[1;31m✗ ${connErrorText(e.error)}\x1b[0m\r\n`)
    }
  },

  onTermMeta: (e) => {
    set({
      tabs: get().tabs.map((tab) => (tab.id === e.termId ? { ...tab, title: e.title || tab.title, remark: e.remark } : tab))
    })
  },

  onSftpTransfer: (event) => {
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

  // 文件盖在最上层：开面板时把正在看的文件退到后台（tab 不丢），不然面板出不来
  toggleOpsPanel: (termId) => {
    const open = get().opsPanelTermIds
    set(
      open.includes(termId)
        ? { opsPanelTermIds: open.filter((id) => id !== termId) }
        : { opsPanelTermIds: [...open, termId], activeEditorKey: null }
    )
  },

  toggleHostsOpen: () =>
    get().hostsOpen ? set({ hostsOpen: false }) : set({ hostsOpen: true, settingsOpen: false }),
  setHostsOpen: (open) => {
    set(open ? { hostsOpen: true, settingsOpen: false, rightPanelOpen: false } : { hostsOpen: false })
    if (open) void get().loadSessions()
  },
  setRightPanelPane: (pane) => set({ rightPanelPane: pane }),
  openRemoteEditor: (termId, sessionId, file, pin = false, readOnly) => {
    const key = editorKey(termId, sessionId, file.path)
    const tabs = get().editorTabs
    const existing = tabs.find((t) => t.key === key)
    if (existing) {
      set({
        editorTabs: tabs.map((t) =>
          t.key === key
            ? { ...t, preview: pin ? false : t.preview, readOnly: readOnly ?? t.readOnly }
            : t
        ),
        activeEditorKey: key
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
    set({
      editorTabs: [
        ...next,
        { key, termId, sessionId, path: file.path, name: file.name, preview: !pin, dirty: false, readOnly: readOnly ?? true }
      ],
      activeEditorKey: key
    })
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
    const tabs = get().editorTabs.filter((t) => t.key !== key)
    const sibling = tabs.filter((t) => t.termId === current?.termId)
    set({
      editorTabs: tabs,
      activeEditorKey: get().activeEditorKey === key ? (sibling.at(-1)?.key ?? null) : get().activeEditorKey
    })
  },
  activateEditorTab: (key) => set({ activeEditorKey: key }),
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
