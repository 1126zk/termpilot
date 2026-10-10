import { create } from 'zustand'
import {
  MCP_DEFAULT_PORT,
  unifiedTheme,
  type Appearance,
  type LocalShell,
  type LocalShellInfo,
  type McpOpenTab,
  type McpRuntime,
  type McpSettings,
  type McpSettingsInput,
  type SessionConfig,
  type SessionInput,
  type SessionStatus,
  type Tab,
  type TermStatusEvent
} from '../../../shared/types'
import { newTermId } from '../../../shared/ids'
import { osIconProps } from '../components/OsIcon'
import { dropBuffer, editorKey } from '../editor/editorBuffers'
import { terminalPool } from '../terminal/TerminalPool'
import { applyAppearance, readCachedAppearance, type ResolvedAppTheme } from '../theme/applyAppearance'

export interface EditorTab {
  key: string
  /** null 表示本机文件 */
  sessionId: string | null
  path: string
  name: string
  /** 斜体预览：再单击别的文件会替换它 */
  preview: boolean
  dirty: boolean
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
  /** 主机地址归一化后的备注，同一台机器上的连接共用 */
  hostNotes: Record<string, string>
  sessionStatus: Record<string, SessionStatus>
  /** 每个终端（标签）的连接状态 */
  termState: Record<string, TermState>
  tabs: Tab[]
  activeTabId: string | null

  /** 侧边栏整体收纳（收成图标栏） */
  sidebarCollapsed: boolean
  /** 右侧文件面板是否打开 */
  rightPanelOpen: boolean
  /** 右侧面板当前板块 */
  rightPanelPane: RightPanelPane
  /** 树节点折叠，key 为 forward / local / 分组名 */
  collapsedGroups: Record<string, boolean>
  search: string
  /** 文件树跟随的会话 */
  selectedSessionId: string | null
  /** 当前连接或本机下打开的文件。和会话标签分开，按机器保留。 */
  editorTabs: EditorTab[]
  /** 正在看的文件。null 表示回到这台机器的终端。 */
  activeEditorKey: string | null

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
  saveMcp: (input: McpSettingsInput) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setNotice: (notice: string | null) => void
  saveSession: (id: string | null, input: SessionInput) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  duplicateSessions: (ids: string[]) => Promise<void>

  openSessionTab: (session: SessionConfig, fresh?: boolean) => void
  openLocalTab: (shell?: LocalShell) => void
  closeTab: (tabId: string) => void
  reconnectTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  setTabRemark: (tabId: string, remark: string) => void
  setSessionRemark: (session: SessionConfig, remark: string) => Promise<void>
  setActiveTab: (tabId: string) => void
  /** 标签栏拖动排序：按 id 数组重排 tabs（不在数组里的保持相对顺序排在后面） */
  reorderTabs: (ids: string[]) => void
  /** 主进程终端状态事件入口（App 中订阅一次） */
  onTermStatus: (e: TermStatusEvent) => void
  onTermMeta: (e: { termId: string; title: string; remark: string }) => void

  toggleSidebar: () => void
  toggleRightPanel: () => void
  setRightPanelPane: (pane: RightPanelPane) => void
  toggleGroup: (group: string) => void
  selectSession: (id: string) => void
  openRemoteEditor: (sessionId: string | null, file: { path: string; name: string }, pin?: boolean) => void
  closeEditorTab: (key: string) => void
  activateEditorTab: (key: string) => void
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

let noticeTimer: ReturnType<typeof setTimeout> | undefined
const bootAppearance = readCachedAppearance()

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  localShells: [],
  hostNotes: {},
  sessionStatus: {},
  termState: {},
  tabs: [],
  activeTabId: null,
  sidebarCollapsed: false,
  rightPanelOpen: false,
  rightPanelPane: 'files',
  collapsedGroups: {},
  search: '',
  selectedSessionId: null,
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
      set({ activeTabId: tab.termId, selectedSessionId: tab.sessionId })
      return
    }
    set({
      tabs: [
        ...get().tabs,
        { id: tab.termId, sessionId: tab.sessionId, kind: tab.kind, title: tab.title }
      ],
      activeTabId: tab.termId,
      selectedSessionId: tab.sessionId ?? get().selectedSessionId
    })
  },

  onMcpCloseTab: (termId) => {
    if (get().tabs.some((tab) => tab.id === termId)) get().closeTab(termId)
    else terminalPool.dispose(termId)
  },

  onSessionsChanged: (sessions) => {
    const ids = new Set(sessions.map((session) => session.id))
    const selected = get().selectedSessionId
    set({
      sessions,
      selectedSessionId: selected && ids.has(selected) ? selected : null
    })
    for (const tab of get().tabs) {
      if (tab.sessionId && !ids.has(tab.sessionId)) get().closeTab(tab.id)
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setNotice: (notice) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    set({ notice })
    if (notice) noticeTimer = setTimeout(() => set({ notice: null }), 12000)
  },

  saveSession: async (id, input) => {
    if (id) {
      await window.api.sessions.update(id, input)
    } else {
      await window.api.sessions.create(input)
    }
    await get().loadSessions()
    set({ editing: null })
  },

  deleteSession: async (id) => {
    await window.api.sessions.delete(id)
    // 关掉该会话已打开的标签
    for (const t of get().tabs.filter((t) => t.sessionId === id)) {
      get().closeTab(t.id)
    }
    await get().loadSessions()
  },

  duplicateSessions: async (ids) => {
    for (const id of ids) await window.api.sessions.duplicate(id)
    await get().loadSessions()
  },

  openSessionTab: (session, fresh = false) => {
    set({ selectedSessionId: session.id })
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
      title: `窗口 ${count + 1}`,
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

  openLocalTab: (shell = 'powershell') => {
    const count = get().tabs.filter((t) => t.kind === 'local').length
    const platform = window.api.platform
    const tab: Tab = {
      id: newTermId(),
      sessionId: null,
      kind: 'local',
      title: `窗口 ${count + 1}`,
      os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
      shell
    }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
    window.api.term.create({ termId: tab.id, kind: 'local', title: tab.title, shell, cols: 80, rows: 24 })
  },

  renameTab: (tabId, title) => {
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!name) return
    set({ tabs: get().tabs.map((tab) => (tab.id === tabId ? { ...tab, title: name } : tab)) })
    window.api.term.label(tabId, { title: name })
  },

  setTabRemark: (tabId, remark) => {
    const text = remark.replace(/\s+/g, ' ').trim().slice(0, 200)
    set({ tabs: get().tabs.map((tab) => (tab.id === tabId ? { ...tab, remark: text } : tab)) })
    window.api.term.label(tabId, { remark: text })
  },

  setSessionRemark: async (session, remark) => {
    const text = remark.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (text === (session.remark ?? '').trim()) return
    await window.api.sessions.update(session.id, {
      name: session.name,
      group: session.group,
      host: session.host,
      port: session.port,
      username: session.username,
      remark: text,
      jumpHost: session.jumpHost ?? '',
      jumpPort: session.jumpPort,
      jumpUsername: session.jumpUsername,
      sshOptions: session.sshOptions
    })
    await get().loadSessions()
  },

  reconnectTab: (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    const status = get().termState[tabId]?.status
    if (status === 'connected' || status === 'connecting') return
    set({
      activeTabId: tabId,
      selectedSessionId: tab.sessionId ?? get().selectedSessionId,
      activeEditorKey: null
    })
    window.api.term.create({
      termId: tab.id,
      kind: tab.kind,
      sessionId: tab.sessionId ?? undefined,
      title: tab.title,
      cols: 80,
      rows: 24
    })
  },

  closeTab: (tabId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId)
    const activeTabId =
      get().activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId
    const termState = { ...get().termState }
    delete termState[tabId]
    set({ tabs, activeTabId, termState })
    // 先断主进程连接，再销毁 xterm 实例
    window.api.term.close(tabId)
    terminalPool.dispose(tabId)
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    set({
      activeTabId: tabId,
      selectedSessionId: tab?.sessionId ?? get().selectedSessionId,
      activeEditorKey: null
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
    // 连接失败时把错误写进终端，用户能直接看到
    if (e.status === 'error' && e.error) {
      terminalPool.write(e.termId, `\r\n\x1b[1;31m✗ ${e.error}\x1b[0m\r\n`)
    }
  },

  onTermMeta: (e) => {
    set({
      tabs: get().tabs.map((tab) => (tab.id === e.termId ? { ...tab, title: e.title || tab.title, remark: e.remark } : tab))
    })
  },

  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  toggleRightPanel: () => set({ rightPanelOpen: !get().rightPanelOpen }),
  setRightPanelPane: (pane) => set({ rightPanelPane: pane }),
  toggleGroup: (group) =>
    set({ collapsedGroups: { ...get().collapsedGroups, [group]: !get().collapsedGroups[group] } }),
  selectSession: (id) => set({ selectedSessionId: id }),
  openRemoteEditor: (sessionId, file, pin = false) => {
    const key = editorKey(sessionId, file.path)
    const tabs = get().editorTabs
    const existing = tabs.find((t) => t.key === key)
    if (existing) {
      set({
        editorTabs: tabs.map((t) => (t.key === key && pin ? { ...t, preview: false } : t)),
        activeEditorKey: key
      })
      return
    }
    let next = tabs
    if (!pin) {
      const preview = next.find((t) => t.sessionId === sessionId && t.preview && !t.dirty)
      if (preview) {
        dropBuffer(preview.key)
        next = next.filter((t) => t.key !== preview.key)
      }
    }
    set({
      editorTabs: [
        ...next,
        { key, sessionId, path: file.path, name: file.name, preview: !pin, dirty: false }
      ],
      activeEditorKey: key
    })
  },
  closeEditorTab: (key) => {
    dropBuffer(key)
    const current = get().editorTabs.find((t) => t.key === key)
    const tabs = get().editorTabs.filter((t) => t.key !== key)
    const sibling = tabs.filter((t) => t.sessionId === current?.sessionId)
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
  setEditing: (v) => set({ editing: v })
}))
