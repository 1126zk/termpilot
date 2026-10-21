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
  type SessionStatus,
  type Tab,
  type TermStatusEvent
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
  /** 运维面板开在哪个终端标签上。null 表示都关着。 */
  opsPanelTermId: string | null

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
  hostNotes: {},
  sessionStatus: {},
  termState: {},
  tabs: [],
  activeTabId: null,
  rightPanelOpen: false,
  opsPanelTermId: null,
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

  setSettingsOpen: (open) =>
    set(open ? { settingsOpen: true, hostsOpen: false, rightPanelOpen: false, editing: null } : { settingsOpen: false }),

  setNotice: (notice) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    set({ notice })
    if (notice) noticeTimer = setTimeout(() => set({ notice: null }), 2000)
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
    const opsPanelTermId = get().opsPanelTermId === tabId ? null : get().opsPanelTermId
    set({ tabs, activeTabId, termState, editorTabs, activeEditorKey, opsPanelTermId })
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

  // 面板内容硬性互斥：开文件面板就关掉编辑表单
  toggleRightPanel: () => set({ rightPanelOpen: !get().rightPanelOpen, editing: null }),

  toggleOpsPanel: (termId) =>
    set({ opsPanelTermId: get().opsPanelTermId === termId ? null : termId }),

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
