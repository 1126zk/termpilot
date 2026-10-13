import { useEffect } from 'react'
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
import { RemoteEditor } from './components/RemoteEditor'
import { HostsPage } from './components/HostsPage'
import { useAppStore } from './stores/useAppStore'
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
  const remoteEditor = useAppStore((s) => s.activeEditorKey)
  const editorTabs = useAppStore((s) => s.editorTabs)

  useEffect(() => window.api.capture.onRun((job) => void runCapture(job)), [])

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
  const hostsOpen = useAppStore((s) => s.hostsOpen)
  const fileTabs = activeTab
    ? editorTabs.filter((t) => t.termId === activeTab.id)
    : []
  const currentFile = fileTabs.find((t) => t.key === remoteEditor) ?? null
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // 文件标签跟着终端页走，切到主机页、设置页时收起
  const onTerminalPage = !!activeTab && !hostsOpen && !settingsOpen
  const editing = useAppStore((s) => s.editing)
  const panelOpen = Boolean(editing || (rightPanelOpen && !hostsOpen && !settingsOpen && activeTab))

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 flex-col">
        <TabBar />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {onTerminalPage && fileTabs.length > 0 && (
              <EditorTabBar tabs={fileTabs} activeKey={currentFile?.key ?? null} />
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {settingsOpen ? (
                <SettingsPage />
              ) : hostsOpen || !activeTab ? (
                <HostsPage />
              ) : currentFile ? (
                <RemoteEditor key={currentFile.key} tab={currentFile} />
              ) : (
                <TerminalView key={activeTab.id} termId={activeTab.id} />
              )}
            </div>
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
