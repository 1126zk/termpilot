import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { RightPanel } from './components/RightPanel'
import { TabBar } from './components/TabBar'
import { EditorTabBar } from './components/EditorTabBar'
import { SettingsPage } from './components/SettingsPage'
import { McpConfirmDialog } from './components/McpConfirmDialog'
import { NoticeToast } from './components/NoticeToast'
import { SftpInstallDialog } from './components/SftpInstallDialog'
import { TerminalView } from './components/TerminalView'
import { OpsPanel } from './components/OpsPanel'
import { RemoteEditor } from './components/RemoteEditor'
import { HostsPage } from './components/HostsPage'
import { ToolsPage } from './components/ToolsPage'
import { startPointerDrag } from './components/flip'
import { useAppStore, termIdFromView, type SessionSplit, type SplitDir, type SplitState } from './stores/useAppStore'
import { runCapture } from './terminal/captureView'
import { pasteClipboardImage } from './terminal/pasteImage'
import { setImageOpenHandler } from './terminal/imageHover'
import { ImageHoverPreview } from './components/ImageHoverPreview'
import { setAltVHandler, terminalPool } from './terminal/TerminalPool'

export default function App() {
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadLocalShells = useAppStore((s) => s.loadLocalShells)
  const loadAppearance = useAppStore((s) => s.loadAppearance)
  const loadMcp = useAppStore((s) => s.loadMcp)
  const onTermStatus = useAppStore((s) => s.onTermStatus)
  const onTermMeta = useAppStore((s) => s.onTermMeta)
  const onMcpState = useAppStore((s) => s.onMcpState)
  const onMcpOpenTab = useAppStore((s) => s.onMcpOpenTab)
  const onMcpCloseTab = useAppStore((s) => s.onMcpCloseTab)
  const onSessionsChanged = useAppStore((s) => s.onSessionsChanged)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const editorKeyByTerm = useAppStore((s) => s.editorKeyByTerm)
  const editorTabs = useAppStore((s) => s.editorTabs)
  const sessionSplit = useAppStore((s) => s.sessionSplit)
  const focusPane = useAppStore((s) => s.focusPane)

  useEffect(() => window.api.capture.onRun((job) => void runCapture(job)), [])
  useEffect(() => window.api.sftp.onTransfer(useAppStore.getState().onSftpTransfer), [])

  // SSH 终端里的 Alt+V：剪贴板是图片就传到服务器并填入路径，否则原样发给服务器。
  // 本机终端不接手，里面的程序自己能读本机剪贴板
  useEffect(() => {
    setAltVHandler((termId) => {
      const state = useAppStore.getState()
      const side = state.sideTerms.find((item) => item.id === termId)
      const tab = state.tabs.find((item) => item.id === (side?.parentId ?? termId))
      if (tab?.kind !== 'ssh' || !tab.sessionId) return false
      void pasteClipboardImage(tab, termId)
      return true
    })
    return () => setAltVHandler(null)
  }, [])

  // 终端里 Ctrl+点击图片路径：用图片查看器打开，盖在这个终端所在的那一栏
  useEffect(() => {
    setImageOpenHandler((termId, path) => {
      const state = useAppStore.getState()
      const side = state.sideTerms.find((item) => item.id === termId)
      const parentId = side?.parentId ?? termId
      const tab = state.tabs.find((item) => item.id === parentId)
      if (!tab) return
      const pane = state.sessionSplit[parentId]
      if (pane) {
        const view = `term:${termId}`
        state.focusSessionSide(parentId, pane.secondary.includes(view) || pane.secondaryView === view ? 'secondary' : 'primary')
      }
      const remote = tab.kind === 'ssh' ? tab.sessionId : null
      if (!remote && path.startsWith('~')) return state.setNotice('本机路径请写完整')
      useAppStore.getState().openRemoteEditor(parentId, remote, {
        path,
        name: path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)
      })
    })
    return () => setImageOpenHandler(null)
  }, [])

  useEffect(() => {
    const open = () => {
      void window.api.app.takeDir().then((dir) => {
        if (dir) void useAppStore.getState().openAtDir(dir)
      })
    }
    const off = window.api.app.onOpenDir(open)
    open()
    return off
  }, [])

  useEffect(
    () =>
      window.api.mcp.onSplit((job) => {
        const result = useAppStore.getState().applyMcpSplit(job.kind, job.termId)
        window.api.mcp.splitReply({ id: job.id, error: result.error, termId: result.termId })
      }),
    []
  )

  useEffect(
    () =>
      window.api.term.onLines((job) => {
        const listed = terminalPool.bufferLines(job.termId, job.startLine, job.endLine)
        window.api.term.linesReply(
          listed
            ? { id: job.id, ...listed }
            : { id: job.id, error: '终端不在画面上' }
        )
      }),
    []
  )

  useEffect(
    () =>
      window.api.term.onMode((job) => {
        window.api.term.modeReply({
          id: job.id,
          applicationCursor: terminalPool.applicationCursor(job.termId)
        })
      }),
    []
  )

  useEffect(() => {
    const onFocus = () => {
      void loadSessions()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSessions])

  useEffect(() => {
    void loadSessions()
    void loadLocalShells()
    loadAppearance()
    loadMcp()
    const offStatus = window.api.term.onStatus(onTermStatus)
    const offMeta = window.api.term.onMeta(onTermMeta)
    const offMcpState = window.api.mcp.onState(onMcpState)
    const offMcpOpen = window.api.mcp.onOpenTab(onMcpOpenTab)
    const offMcpClose = window.api.mcp.onCloseTab(onMcpCloseTab)
    const offSessions = window.api.sessions.onChanged(onSessionsChanged)
    return () => {
      offStatus()
      offMeta()
      offMcpState()
      offMcpOpen()
      offMcpClose()
      offSessions()
    }
  }, [
    loadSessions,
    loadLocalShells,
    loadAppearance,
    loadMcp,
    onTermStatus,
    onTermMeta,
    onMcpState,
    onMcpOpenTab,
    onMcpCloseTab,
    onSessionsChanged
  ])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const split = useAppStore((s) => s.split)
  const opsPanelTermIds = useAppStore((s) => s.opsPanelTermIds)
  const hostsOpen = useAppStore((s) => s.hostsOpen)
  const toolsOpen = useAppStore((s) => s.toolsOpen)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // 文件标签跟着终端页走，切到主机页、工具页、设置页时收起
  const onTerminalPage = !!activeTab && !hostsOpen && !toolsOpen && !settingsOpen
  const editing = useAppStore((s) => s.editing)
  const panelOpen = Boolean(editing || (rightPanelOpen && !hostsOpen && !toolsOpen && !settingsOpen && activeTab))
  const gridRef = useRef<HTMLDivElement>(null)

  // a 是主栏（左 / 上），b 是辅栏（右 / 下）；不分屏时只有 a。每一栏有自己的文件标签和正在看的文件
  const panes = (
    [
      ['a', split ? split.primaryTab : activeTabId],
      ['b', split ? split.secondaryTab : null]
    ] as const
  ).flatMap(([area, termId]) => {
    if (!onTerminalPage || !termId) return []
    const files = editorTabs.filter((t) => t.termId === termId)
    const inner = sessionSplit[termId] ?? null
    const file = inner ? null : (files.find((t) => t.key === editorKeyByTerm[termId]) ?? null)
    return [{ area, termId, files, file, inner }]
  })
  const bars = panes.filter((pane) => pane.files.length > 0 || pane.inner).map((pane) => pane.area)
  // 每个标签放进哪一栏：在看文件的那一栏不放终端；运维面板只在主栏出现，辅栏只放终端。
  // 会话内部分栏自己画终端和文件，外层格子让出来
  const opsAreas: Record<string, PaneArea> = {}
  const termAreas: Record<string, PaneArea> = {}
  for (const pane of panes) {
    if (pane.inner || pane.file) continue
    if (pane.area === 'a' && opsPanelTermIds.includes(pane.termId)) opsAreas[pane.termId] = pane.area
    else termAreas[pane.termId] = pane.area
  }

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 flex-col">
        <TabBar />
        <div className="flex min-h-0 flex-1">
          <div ref={gridRef} className="grid min-h-0 min-w-0 flex-1 overflow-hidden" style={paneGrid(split, bars)}>
            {panes.map((pane) =>
              pane.files.length > 0 || pane.inner ? (
                <div
                  key={`bar:${pane.termId}`}
                  className="min-w-0"
                  style={{ gridArea: `${pane.area}bar` }}
                  onPointerDownCapture={() => focusPane(pane.termId)}
                >
                  <EditorTabBar termId={pane.termId} tabs={pane.files} activeKey={pane.file?.key ?? null} />
                </div>
              ) : null
            )}
            <OpsPanels areas={opsAreas} />
            <TerminalViews areas={termAreas} parked={Object.keys(sessionSplit)} />
            {split && onTerminalPage && <SplitDivider dir={split.dir} gridRef={gridRef} />}
            {settingsOpen ? (
              <div className={paneCell} style={{ gridArea: '1 / 1 / -1 / -1' }}>
                <SettingsPage />
              </div>
            ) : toolsOpen ? (
              <div className={paneCell} style={{ gridArea: '1 / 1 / -1 / -1' }}>
                <ToolsPage />
              </div>
            ) : hostsOpen || !activeTab ? (
              <div className={paneCell} style={{ gridArea: '1 / 1 / -1 / -1' }}>
                <HostsPage />
              </div>
            ) : null}
            {panes.map((pane) =>
              pane.inner ? (
                <div key={`split:${pane.termId}`} className={paneCell} style={{ gridArea: pane.area }}>
                  <SessionSplitPane parentId={pane.termId} pane={pane.inner} />
                </div>
              ) : pane.file ? (
                // 文件只盖住它所属的那一栏：面板/终端模式下点文件都能看，切走回落到之前的模式
                <div
                  key={`file:${pane.termId}`}
                  className={paneCell}
                  style={{ gridArea: pane.area }}
                  onPointerDownCapture={() => focusPane(pane.termId)}
                >
                  <RemoteEditor key={pane.file.key} tab={pane.file} />
                </div>
              ) : null
            )}
          </div>
          {/* 面板挤占布局不盖内容，宽度从 0 平滑展开到满宽。编辑表单任何页面都能弹；文件面板只属于终端页 */}
          <div
            className={cn(
              'flex min-h-0 shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out',
              panelOpen ? 'w-[400px]' : 'pointer-events-none w-0'
            )}
          >
            <div className="flex min-h-0 w-[400px] flex-1 flex-col py-2 pr-2">
              <RightPanel open={panelOpen} />
            </div>
          </div>
        </div>
        <McpConfirmDialog />
        <SftpInstallDialog />
        <NoticeToast />
        <ImageHoverPreview />
      </div>
    </TooltipProvider>
  )
}

type PaneArea = 'a' | 'b'

/** 一栏的格子：竖向排内容，宽高都允许缩到比内容小 */
const paneCell = 'flex min-h-0 min-w-0 flex-col'

/**
 * 内容区网格。两栏 a / b 中间夹分隔线 d；文件标签栏 abar / bbar 在对应那一栏上方。
 * 左右分屏两栏共用行，没有文件标签栏的那一栏占满两行，不留空条。
 */
function paneGrid(split: SplitState | null, bars: PaneArea[]): CSSProperties {
  if (!split) {
    return { gridTemplateAreas: '"abar" "a"', gridTemplateRows: 'auto minmax(0, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)' }
  }
  const a = `minmax(0, ${split.ratio}fr)`
  const b = `minmax(0, ${1 - split.ratio}fr)`
  if (split.dir === 'down') {
    return {
      gridTemplateAreas: '"abar" "a" "d" "bbar" "b"',
      gridTemplateRows: `auto ${a} 4px auto ${b}`,
      gridTemplateColumns: 'minmax(0, 1fr)'
    }
  }
  const top = `${bars.includes('a') ? 'abar' : 'a'} d ${bars.includes('b') ? 'bbar' : 'b'}`
  return { gridTemplateAreas: `"${top}" "a d b"`, gridTemplateRows: 'auto minmax(0, 1fr)', gridTemplateColumns: `${a} 4px ${b}` }
}

/** 两栏中间的分隔线，按住拖动调整主栏占比。 */
function SplitDivider(props: { dir: SplitDir; gridRef: RefObject<HTMLDivElement | null>; onRatio?: (ratio: number) => void }) {
  const setSplitRatio = useAppStore((s) => s.setSplitRatio)
  const apply = props.onRatio ?? setSplitRatio
  const axis = props.dir === 'right' ? 'x' : 'y'
  return (
    <div
      className={cn('group flex items-center justify-center', axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize')}
      style={{ gridArea: 'd' }}
      onPointerDown={(event) => {
        const grid = props.gridRef.current
        if (!grid) return
        // 不让拖动时选中两边的文字
        event.preventDefault()
        startPointerDrag({
          event,
          axis,
          threshold: 0,
          onActivate: () => undefined,
          onMove: (position) => {
            const rect = grid.getBoundingClientRect()
            apply(axis === 'x' ? (position - rect.left) / rect.width : (position - rect.top) / rect.height)
          },
          onEnd: () => undefined
        })
      }}
    >
      <div className={cn('bg-border transition-colors group-hover:bg-primary/60', axis === 'x' ? 'h-full w-px' : 'h-px w-full')} />
    </div>
  )
}

/** 打开了运维面板的标签。areas 里有的放进对应那一栏，其余藏起来但不卸载。 */
function OpsPanels(props: { areas: Record<string, PaneArea> }) {
  const tabs = useAppStore((s) => s.tabs)
  const openIds = useAppStore((s) => s.opsPanelTermIds)
  const sessionSplit = useAppStore((s) => s.sessionSplit)
  const focusPane = useAppStore((s) => s.focusPane)
  const openTabs = tabs.filter((tab) => openIds.includes(tab.id) && !sessionSplit[tab.id])
  return (
    <>
      {openTabs.map((tab) => {
        const area = props.areas[tab.id]
        return (
          <div
            key={tab.id}
            className={area ? paneCell : 'hidden'}
            style={area ? { gridArea: area } : undefined}
            onPointerDownCapture={() => focusPane(tab.id)}
          >
            <OpsPanel termId={tab.id} active={!!area} />
          </div>
        )
      })}
    </>
  )
}

/** 会话内部左主右辅。文件和两个终端各自占一半，终端进程互不影响。 */
function SessionSplitPane(props: { parentId: string; pane: SessionSplit }) {
  const editorTabs = useAppStore((s) => s.editorTabs)
  const focusSessionSide = useAppStore((s) => s.focusSessionSide)
  const setSessionSplitRatio = useAppStore((s) => s.setSessionSplitRatio)
  const opsOpen = useAppStore((s) => s.opsPanelTermIds.includes(props.parentId))
  const gridRef = useRef<HTMLDivElement>(null)
  const rightEmpty = props.pane.secondary.length === 0
  const leftFile = editorTabs.find((tab) => tab.key === props.pane.primaryView) ?? null
  const rightFile = rightEmpty ? null : (editorTabs.find((tab) => tab.key === props.pane.secondaryView) ?? null)
  const leftTerm = termIdFromView(props.pane.primaryView)
  const rightTerm = rightEmpty ? null : termIdFromView(props.pane.secondaryView)
  const primary = `minmax(0, ${props.pane.ratio}fr)`
  const secondary = `minmax(0, ${1 - props.pane.ratio}fr)`
  const style: CSSProperties =
    props.pane.dir === 'down'
      ? { gridTemplateAreas: '"p" "d" "s"', gridTemplateRows: `${primary} 4px ${secondary}`, gridTemplateColumns: 'minmax(0, 1fr)' }
      : { gridTemplateAreas: '"p d s"', gridTemplateColumns: `${primary} 4px ${secondary}`, gridTemplateRows: 'minmax(0, 1fr)' }
  const side = (which: 'primary' | 'secondary', file: typeof leftFile, termId: string | null) => (
    <div
      className={cn(paneCell, rightEmpty && 'flex-1')}
      style={rightEmpty ? undefined : { gridArea: which === 'primary' ? 'p' : 's' }}
      onPointerDownCapture={() => focusSessionSide(props.parentId, which)}
    >
      {which === 'primary' && opsOpen ? (
        <OpsPanel termId={props.parentId} active />
      ) : file ? (
        <RemoteEditor key={file.key} tab={file} />
      ) : termId ? (
        <TerminalView termId={termId} active={props.pane.focus === which} />
      ) : null}
    </div>
  )
  if (rightEmpty) return side('primary', leftFile, leftTerm)
  return (
    <div ref={gridRef} className="grid min-h-0 min-w-0 flex-1" style={style}>
      {side('primary', leftFile, leftTerm)}
      <SplitDivider
        dir={props.pane.dir}
        gridRef={gridRef}
        onRatio={(ratio) => setSessionSplitRatio(props.parentId, ratio)}
      />
      {side('secondary', rightFile, rightTerm)}
    </div>
  )
}

/** 终端视图。看过的标签保持挂载，切回来不重挂；areas 决定谁显示在哪一栏。 */
function TerminalViews(props: { areas: Record<string, PaneArea>; parked?: string[] }) {
  const tabs = useAppStore((s) => s.tabs)
  const focusPane = useAppStore((s) => s.focusPane)
  const [visited, setVisited] = useState<string[]>([])
  const shownKey = Object.keys(props.areas).join()
  useEffect(() => {
    const shown = Object.keys(props.areas)
    setVisited((ids) => (shown.every((id) => ids.includes(id)) ? ids : [...ids, ...shown.filter((id) => !ids.includes(id))]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])
  const parked = new Set(props.parked ?? [])
  const visible = tabs.filter((tab) => !parked.has(tab.id) && (visited.includes(tab.id) || props.areas[tab.id]))
  return (
    <>
      {visible.map((tab) => {
        const area = props.areas[tab.id]
        return (
          <div
            key={tab.id}
            className={area ? paneCell : 'hidden'}
            style={area ? { gridArea: area } : undefined}
            onPointerDownCapture={() => focusPane(tab.id)}
          >
            <TerminalView termId={tab.id} active={!!area} />
          </div>
        )
      })}
    </>
  )
}
