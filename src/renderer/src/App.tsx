import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { RightPanel } from './components/RightPanel'
import { TabBar } from './components/TabBar'
import { EditorTabBar } from './components/EditorTabBar'
import { SettingsDialog } from './components/SettingsDialog'
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
    ? editorTabs.filter((t) => t.sessionId === activeTab.sessionId)
    : []
  const currentFile = fileTabs.find((t) => t.key === remoteEditor) ?? null
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const editing = useAppStore((s) => s.editing)

  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0 flex-col">
        <TabBar />
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {fileTabs.length > 0 && <EditorTabBar tabs={fileTabs} activeKey={currentFile?.key ?? null} />}
            <div className="flex min-h-0 flex-1 flex-col">
              {currentFile ? (
                <RemoteEditor key={currentFile.key} tab={currentFile} />
              ) : hostsOpen || !activeTab ? (
                <HostsPage />
              ) : (
                <TerminalView key={activeTab.id} termId={activeTab.id} />
              )}
            </div>
          </div>
          {/* 右侧面板悬浮在内容上，从右侧滑入滑出 */}
          <div
            className={cn(
              'absolute inset-y-0 right-0 z-20 flex shrink-0 flex-col py-2 pr-2 transition-transform duration-200 ease-out',
              rightPanelOpen || editing ? 'translate-x-0' : 'pointer-events-none translate-x-full'
            )}
          >
            <RightPanel />
          </div>
        </div>
        <SettingsDialog />
        <McpConfirmDialog />
        <SftpInstallDialog />
        <NoticeToast />
      </div>
    </TooltipProvider>
  )
}
