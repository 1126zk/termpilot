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
import { startPointerDrag } from './components/flip'
import { useAppStore, type SplitDir, type SplitState } from './stores/useAppStore'
import { runCapture } from './terminal/captureView'
import { terminalPool } from './terminal/TerminalPool'

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
  const focusPane = useAppStore((s) => s.focusPane)

  useEffect(() => window.api.capture.onRun((job) => void runCapture(job)), [])
  useEffect(() => window.api.sftp.onTransfer(useAppStore.getState().onSftpTransfer), [])

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
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // 文件标签跟着终端页走，切到主机页、设置页时收起
  const onTerminalPage = !!activeTab && !hostsOpen && !settingsOpen
  const editing = useAppStore((s) => s.editing)
  const panelOpen = Boolean(editing || (rightPanelOpen && !hostsOpen && !settingsOpen && activeTab))
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
    const file = files.find((t) => t.key === editorKeyByTerm[termId]) ?? null
    return [{ area, termId, files, file }]
  })
  const bars = panes.filter((pane) => pane.files.length > 0).map((pane) => pane.area)
  // 每个标签放进哪一栏：在看文件的那一栏不放终端；运维面板只在主栏出现，辅栏只放终端
  const opsAreas: Record<string, PaneArea> = {}
  const termAreas: Record<string, PaneArea> = {}
  for (const pane of panes) {
    if (pane.file) continue
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
              pane.files.length > 0 ? (
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
            <TerminalViews areas={termAreas} />
            {split && onTerminalPage && <SplitDivider dir={split.dir} gridRef={gridRef} />}
            {settingsOpen ? (
              <div className={paneCell} style={{ gridArea: '1 / 1 / -1 / -1' }}>
                <SettingsPage />
              </div>
            ) : hostsOpen || !activeTab ? (
              <div className={paneCell} style={{ gridArea: '1 / 1 / -1 / -1' }}>
                <HostsPage />
              </div>
            ) : null}
            {panes.map((pane) =>
              pane.file ? (
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
function SplitDivider(props: { dir: SplitDir; gridRef: RefObject<HTMLDivElement | null> }) {
  const setSplitRatio = useAppStore((s) => s.setSplitRatio)
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
            setSplitRatio(axis === 'x' ? (position - rect.left) / rect.width : (position - rect.top) / rect.height)
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
  const focusPane = useAppStore((s) => s.focusPane)
  const openTabs = tabs.filter((tab) => openIds.includes(tab.id))
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

/** 终端视图。看过的标签保持挂载，切回来不重挂；areas 决定谁显示在哪一栏。 */
function TerminalViews(props: { areas: Record<string, PaneArea> }) {
  const tabs = useAppStore((s) => s.tabs)
  const focusPane = useAppStore((s) => s.focusPane)
  const [visited, setVisited] = useState<string[]>([])
  const shownKey = Object.keys(props.areas).join()
  useEffect(() => {
    const shown = Object.keys(props.areas)
    setVisited((ids) => (shown.every((id) => ids.includes(id)) ? ids : [...ids, ...shown.filter((id) => !ids.includes(id))]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])
  const visible = tabs.filter((tab) => visited.includes(tab.id) || props.areas[tab.id])
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
