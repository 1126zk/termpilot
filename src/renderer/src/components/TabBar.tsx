import type { CSSProperties } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Apple, Camera, ChevronLeft, ChevronRight, GalleryVertical, Minus, PanelLeft, Plus, Server, Square, TerminalSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { copyAgentPrompt, termAgentPrompt, windowLabel } from '../agentPrompt'
import { openAfterMenu, RemarkDialog } from './RemarkDialog'
import { useAppStore } from '../stores/useAppStore'
import { captureTerminalView, type CaptureDone } from '../terminal/captureView'
import { CaptureDialog } from './CaptureDialog'
import type { OsKind } from '../../../shared/types'

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** 最大化状态下「还原」的图标：两个叠着的方块。lucide 没有现成的，画一个。 */
function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

/** 标签左边的系统图标。Windows 画四个方块，macOS 用 lucide 的 Apple，Linux 画企鹅，认不出用服务器。 */
function OsIcon(props: { os?: OsKind }) {
  if (props.os === 'windows') {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="currentColor">
        <rect x="2" y="2" width="5.5" height="5.5" rx="0.5" />
        <rect x="8.5" y="2" width="5.5" height="5.5" rx="0.5" />
        <rect x="2" y="8.5" width="5.5" height="5.5" rx="0.5" />
        <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="0.5" />
      </svg>
    )
  }
  if (props.os === 'macos') return <Apple className="size-3.5 shrink-0" strokeWidth={1.75} />
  if (props.os === 'linux') {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="currentColor" fillRule="evenodd">
        <path d="M8 2.2c-2.5 0-4.2 2.4-4.2 5.6 0 2 .7 3.6 1.7 4.5-.4.2-.9.6-.9 1 0 .5.8.7 1.6.5.6-.1 1.1-.4 1.8-.4s1.2.3 1.8.4c.8.2 1.6 0 1.6-.5 0-.4-.5-.8-.9-1 1-.9 1.7-2.5 1.7-4.5C11.2 4.6 10.5 2.2 8 2.2Z M5.6 7.1a0.7 0.7 0 1 0 1.4 0 0.7 0.7 0 1 0-1.4 0Z M9 7.1a0.7 0.7 0 1 0 1.4 0 0.7 0.7 0 1 0-1.4 0Z M7.2 7.9h1.6L8 9.2Z" />
      </svg>
    )
  }
  return <Server className="size-3.5 shrink-0" strokeWidth={1.75} />
}

/** 顶栏所有图标按钮的统一规格：一样的高宽、颜色、hover。 */
const topBtn =
  'flex h-7 w-12 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40'

/** 自绘窗口控制按钮：最小化 / 最大化(还原) / 关闭。hover 是低调的灰底。 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.win.isMaximized().then(setMaximized)
    return window.api.win.onMaximizeChanged(setMaximized)
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-0.5 pl-1" style={noDrag}>
      <button type="button" className={topBtn} title="最小化" onClick={() => void window.api.win.minimize()}>
        <Minus className="size-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className={topBtn}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <Square className="size-3.5" strokeWidth={1.75} />}
      </button>
      <button type="button" className={topBtn} title="关闭" onClick={() => void window.api.win.close()}>
        <X className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  )
}

/** 终端标签。窗口级标签，不用 Tabs 组件，避免切走时卸载终端。整行同时充当标题栏拖动区。 */
export function TabBar() {
  const tabs = useAppStore((s) => s.tabs)
  const sessions = useAppStore((s) => s.sessions)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const reconnectTab = useAppStore((s) => s.reconnectTab)
  const termState = useAppStore((s) => s.termState)
  const openLocalTab = useAppStore((s) => s.openLocalTab)
  const openSessionTab = useAppStore((s) => s.openSessionTab)
  const renameTab = useAppStore((s) => s.renameTab)
  const setTabRemark = useAppStore((s) => s.setTabRemark)
  const setNotice = useAppStore((s) => s.setNotice)
  const [shot, setShot] = useState<CaptureDone | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [remarkingId, setRemarkingId] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const { toggleSidebar } = useSidebar()
  const [overflowing, setOverflowing] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const updateArrows = () => {
    const el = stripRef.current
    if (!el) return
    setOverflowing(el.scrollWidth > el.clientWidth + 1)
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  useEffect(() => {
    updateArrows()
    const el = stripRef.current
    if (!el) return
    const observer = new ResizeObserver(updateArrows)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs.length])

  // 切标签时把它滚进视野
  useEffect(() => {
    stripRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTabId])

  const scrollStrip = (dir: -1 | 1) => {
    stripRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' })
  }

  const shoot = (mode: 'viewport' | 'scrollback') => {
    if (!activeTabId) return
    const termId = activeTabId
    setShotError(null)
    setNotice('正在截图…')
    void (async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      try {
        const done = await captureTerminalView({ termId, mode })
        setNotice(null)
        setShot(done)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message)
        setShotError(message)
      }
    })()
  }

  return (
    <>
    <div
      className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2"
      style={drag}
      onDoubleClick={(e) => {
        // 标题栏空白处双击 = 最大化/还原（点到的必须是我们这个行本身，不是里面的控件）
        if (window.api.platform === 'win32' && e.target === e.currentTarget) void window.api.win.toggleMaximize()
      }}
    >
      <button type="button" className={topBtn} style={noDrag} title="收纳侧边栏" onClick={toggleSidebar}>
        <PanelLeft className="size-4" strokeWidth={1.75} />
      </button>
      {overflowing && (
        <button type="button" className={topBtn} style={noDrag} disabled={!canLeft} onClick={() => scrollStrip(-1)}>
          <ChevronLeft className="size-4" strokeWidth={1.75} />
        </button>
      )}
      <div
        ref={stripRef}
        style={drag}
        onScroll={updateArrows}
        onWheel={(e) => {
          const el = stripRef.current
          if (!el) return
          el.scrollLeft += e.deltaY + e.deltaX
        }}
        onDoubleClick={(e) => {
          // 标签条的空白处双击 = 最大化/还原
          if (window.api.platform === 'win32' && e.target === e.currentTarget) void window.api.win.toggleMaximize()
        }}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((t, i) => {
          const active = t.id === activeTabId
          const session = sessions.find((item) => item.id === t.sessionId) ?? null
          return (
            <Fragment key={t.id}>
              {i > 0 && (
                <div
                  className={cn(
                    'h-4 w-px shrink-0 bg-border',
                    (active || tabs[i - 1].id === activeTabId) && 'opacity-0'
                  )}
                />
              )}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Button
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                  data-active={active || undefined}
                  className="max-w-48 min-w-0 shrink-0 overflow-hidden"
                  style={noDrag}
                  title={t.remark?.trim() || undefined}
                  onClick={() => setActiveTab(t.id)}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    setRenamingId(t.id)
                  }}
                >
                  {active ? (
                    <span
                      role="button"
                      title="关闭"
                      className="shrink-0 rounded-sm opacity-70 hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(t.id)
                      }}
                    >
                      <X strokeWidth={1.75} />
                    </span>
                  ) : (
                    <OsIcon os={t.os} />
                  )}
                  <span className="min-w-0 truncate">{windowLabel(t.title, session?.name)}</span>
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onClick={() => void copyAgentPrompt(termAgentPrompt(t, session), setNotice)}
                >
                  复制为 Agent 提示词
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openAfterMenu(() => setRenamingId(t.id))}>重命名</ContextMenuItem>
                <ContextMenuItem onClick={() => openAfterMenu(() => setRemarkingId(t.id))}>备注</ContextMenuItem>
                {(termState[t.id]?.status === 'disconnected' || termState[t.id]?.status === 'error') ? (
                  <ContextMenuItem onClick={() => reconnectTab(t.id)}>重新连接</ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => closeTab(t.id)}>关闭</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            </Fragment>
          )
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(topBtn, 'shrink-0')} style={noDrag} title="新建终端">
              <Plus className="size-4" strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={openLocalTab}>
              <TerminalSquare />
              本机终端
            </DropdownMenuItem>
            {sessions.length > 0 && <DropdownMenuSeparator />}
            {sessions.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => openSessionTab(s, true)}>
                <TerminalSquare />
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {overflowing && (
        <button type="button" className={topBtn} style={noDrag} disabled={!canRight} onClick={() => scrollStrip(1)}>
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      )}
      <button
        type="button"
        className={topBtn}
        style={noDrag}
        title="截取当前终端画面"
        disabled={!activeTabId}
        onClick={() => shoot('viewport')}
      >
        <Camera className="size-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className={topBtn}
        style={noDrag}
        title="截取滚动缓冲"
        disabled={!activeTabId}
        onClick={() => shoot('scrollback')}
      >
        <GalleryVertical className="size-4" strokeWidth={1.75} />
      </button>
      {window.api.platform === 'win32' && <WindowControls />}
    </div>
    <RemarkDialog
      open={renamingId !== null}
      title="重命名"
      description={`给「${tabs.find((tab) => tab.id === renamingId)?.title ?? ''}」换个名字。`}
      initial={tabs.find((tab) => tab.id === renamingId)?.title ?? ''}
      placeholder="窗口名称"
      onOpenChange={(open) => !open && setRenamingId(null)}
      onSave={(value) => {
        if (renamingId) renameTab(renamingId, value)
        setRenamingId(null)
      }}
    />
    <RemarkDialog
      open={remarkingId !== null}
      title="备注"
      description={`给「${tabs.find((tab) => tab.id === remarkingId)?.title ?? ''}」写一句，方便以后认出它。留空就是清掉。`}
      initial={tabs.find((tab) => tab.id === remarkingId)?.remark ?? ''}
      placeholder="这扇窗口在做什么"
      onOpenChange={(open) => !open && setRemarkingId(null)}
      onSave={(value) => {
        if (remarkingId) setTabRemark(remarkingId, value)
        setRemarkingId(null)
      }}
    />
    <CaptureDialog
      shot={shot}
      error={shotError}
      onClose={() => {
        setShot(null)
        setShotError(null)
      }}
    />
    </>
  )
}
