import type { CSSProperties } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, GalleryVertical, GitBranch, Minus, PanelRightClose, PanelRightOpen, Plus, Server, Square, SquareTerminal, Terminal, X } from 'lucide-react'
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
import { OsIcon, osIconProps } from './OsIcon'
import type { LocalShell } from '../../../shared/types'

/** 本机终端三种壳的标签图标。PowerShell 用它的品牌蓝。 */
function ShellIcon(props: { shell?: LocalShell }) {
  if (props.shell === 'cmd') return <Terminal className="size-4 shrink-0" strokeWidth={2} />
  if (props.shell === 'gitbash') return <GitBranch className="size-4 shrink-0" strokeWidth={2} />
  if (props.shell === 'wsl') return <OsIcon os="linux" />
  if (props.shell === 'pwsh') return <SquareTerminal className="size-4 shrink-0" strokeWidth={2} style={{ color: '#2c4fdd' }} />
  return <SquareTerminal className="size-4 shrink-0" strokeWidth={2} style={{ color: '#5391fe' }} />
}

function shellLabel(shell?: LocalShell): string {
  if (shell === 'cmd') return 'CMD'
  if (shell === 'gitbash') return 'Git Bash'
  if (shell === 'wsl') return 'WSL'
  if (shell === 'pwsh') return 'PowerShell 7'
  return 'PowerShell'
}

const drag = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** 最大化状态下「还原」的图标：两个叠着的方块。lucide 没有现成的，画一个。 */
function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

/** 顶栏所有图标按钮的统一规格：一样的高宽、颜色、hover。 */
const topBtn =
  'flex h-9 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40'

/** 自绘窗口控制按钮：右侧面板 / 最小化 / 最大化(还原) / 关闭。hover 是低调的灰底。 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)

  useEffect(() => {
    void window.api.win.isMaximized().then(setMaximized)
    return window.api.win.onMaximizeChanged(setMaximized)
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-0.5 pl-1" style={noDrag}>
      <button
        type="button"
        className={topBtn}
        title={rightPanelOpen ? '收起右侧面板' : '展开右侧面板'}
        onClick={toggleRightPanel}
      >
        {rightPanelOpen ? (
          <PanelRightClose className="size-5" strokeWidth={2} />
        ) : (
          <PanelRightOpen className="size-5" strokeWidth={2} />
        )}
      </button>
      <button type="button" className={topBtn} title="最小化" onClick={() => void window.api.win.minimize()}>
        <Minus className="size-5" strokeWidth={2} />
      </button>
      <button
        type="button"
        className={topBtn}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <Square className="size-4" strokeWidth={2} />}
      </button>
      <button type="button" className={topBtn} title="关闭" onClick={() => void window.api.win.close()}>
        <X className="size-5" strokeWidth={2} />
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
  const localShells = useAppStore((s) => s.localShells)
  const openSessionTab = useAppStore((s) => s.openSessionTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
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
  // 标签拖拽排序：pointerdown 记起点，过 4px 阈值才进拖拽态（阈值内仍是点击/双击）。
  // 拖拽态里被拖标签用 translateX 跟手浮在其他标签上面，其余标签实时让位。
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const suppressTabClick = useRef(false)
  // + 菜单项拖拽排序：顺序存 localStorage，竖直拖，同样 4px 阈值
  const [menuOrder, setMenuOrder] = useState<string[]>(readMenuOrder)
  const menuOrderRef = useRef(menuOrder)
  const [dragMenuKey, setDragMenuKey] = useState<string | null>(null)
  const suppressMenuSelect = useRef(false)
  const menuContentRef = useRef<HTMLDivElement>(null)

  const updateMenuOrder = (next: string[]) => {
    menuOrderRef.current = next
    setMenuOrder(next)
  }

  /**
   * 指针 x 落在各标签中点之前的位置，实时重排；顺序没变就返回 null。
   * 被拖标签带 transform，位移计算一律用 offsetLeft/offsetWidth（不受 transform 影响）。
   */
  const tabDropOrder = (clientX: number, dragId: string): string[] | null => {
    const strip = stripRef.current
    if (!strip) return null
    const pointerInStrip = clientX - strip.getBoundingClientRect().left + strip.scrollLeft
    const ids = useAppStore.getState().tabs.map((tab) => tab.id)
    const rest = ids.filter((id) => id !== dragId)
    const buttons = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')]
    let insert = rest.length
    for (const button of buttons) {
      const id = button.dataset.tabId!
      if (id === dragId) continue
      if (pointerInStrip < button.offsetLeft + button.offsetWidth / 2) {
        insert = rest.indexOf(id)
        break
      }
    }
    const next = [...rest.slice(0, insert), dragId, ...rest.slice(insert)]
    return next.join() === ids.join() ? null : next
  }

  const startTabDrag = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return
    let active = false
    const startX = event.clientX
    // 拖拽开始瞬间的布局位。数组实时重排后 offsetLeft 自动变，
    // translateX = 指针位移 - 布局位移，公式一直成立
    let startOffsetLeft = 0
    const dragged = () => stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 4) return
        active = true
        startOffsetLeft = dragged()?.offsetLeft ?? 0
        setDragTabId(id)
        setDragOffset(0)
      }
      const next = tabDropOrder(ev.clientX, id)
      if (next) reorderTabs(next)
      const current = dragged()
      if (current) setDragOffset(ev.clientX - startX - (current.offsetLeft - startOffsetLeft))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!active) return
      // 拖完会补一个 click，不能当成选中/关闭
      suppressTabClick.current = true
      setDragTabId(null)
      setDragOffset(0)
      window.api.term.reorder(useAppStore.getState().tabs.map((tab) => tab.id))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 菜单项竖直拖拽：指针 y 对同分区各项中点，实时改顺序 */
  const menuDropOrder = (clientY: number, dragKey: string): string[] | null => {
    const content = menuContentRef.current
    if (!content) return null
    const shellKeys = localShells.map((shell) => `shell:${shell.id}`)
    const sessionKeys = sessions.map((session) => `session:${session.id}`)
    const orderedShells = applyOrder(shellKeys, menuOrderRef.current)
    const orderedSessions = applyOrder(sessionKeys, menuOrderRef.current)
    const inShells = orderedShells.includes(dragKey)
    const section = inShells ? orderedShells : orderedSessions
    const rest = section.filter((key) => key !== dragKey)
    const nodes = [...content.querySelectorAll<HTMLElement>('[data-menu-key]')]
    let insert = rest.length
    for (const node of nodes) {
      const key = node.dataset.menuKey!
      if (key === dragKey || !rest.includes(key)) continue
      const rect = node.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        insert = rest.indexOf(key)
        break
      }
    }
    const nextSection = [...rest.slice(0, insert), dragKey, ...rest.slice(insert)]
    const next = inShells ? [...nextSection, ...orderedSessions] : [...orderedShells, ...nextSection]
    const current = [...orderedShells, ...orderedSessions]
    return next.join() === current.join() ? null : next
  }

  const startMenuDrag = (event: React.PointerEvent, key: string) => {
    if (event.button !== 0) return
    let active = false
    const startY = event.clientY
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 4) return
        active = true
        setDragMenuKey(key)
      }
      const next = menuDropOrder(ev.clientY, key)
      if (next) updateMenuOrder(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!active) return
      // 拖完菜单项会补一次 select，不能当成打开
      suppressMenuSelect.current = true
      setDragMenuKey(null)
      writeMenuOrder(menuOrderRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const shellById = new Map(localShells.map((shell) => [`shell:${shell.id}`, shell]))
  const sessionById = new Map(sessions.map((session) => [`session:${session.id}`, session]))
  const orderedShellKeys = applyOrder(
    localShells.map((shell) => `shell:${shell.id}`),
    menuOrder
  )
  const orderedSessionKeys = applyOrder(
    sessions.map((session) => `session:${session.id}`),
    menuOrder
  )

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
      className="flex h-12 shrink-0 items-center gap-1 bg-background px-2"
      style={drag}
      onDoubleClick={(e) => {
        // 标题栏空白处双击 = 最大化/还原（点到的必须是我们这个行本身，不是里面的控件）
        if (window.api.platform === 'win32' && e.target === e.currentTarget) void window.api.win.toggleMaximize()
      }}
    >
      <button type="button" className={topBtn} style={noDrag} title="收纳侧边栏" onClick={toggleSidebar}>
        <Server className="size-5" strokeWidth={2} />
      </button>
      {overflowing && (
        <button type="button" className={topBtn} style={noDrag} disabled={!canLeft} onClick={() => scrollStrip(-1)}>
          <ChevronLeft className="size-5" strokeWidth={2} />
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
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  data-active={active || undefined}
                  data-tab-id={t.id}
                  className={cn(
                    'group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md bg-muted/60 px-3 text-[14px] font-semibold text-muted-foreground transition-colors',
                    active && 'bg-primary/15 text-primary',
                    dragTabId === t.id && 'relative z-10 shadow-lg ring-1 ring-foreground/30'
                  )}
                  style={
                    dragTabId === t.id
                      ? { ...noDrag, transform: `translateX(${dragOffset}px)` }
                      : noDrag
                  }
                  title={t.remark?.trim() || undefined}
                  onPointerDown={(e) => startTabDrag(e, t.id)}
                  onClick={() => {
                    if (suppressTabClick.current) {
                      suppressTabClick.current = false
                      return
                    }
                    setActiveTab(t.id)
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    setRenamingId(t.id)
                  }}
                >
                  {/* 平时是系统图标；悬停标签或标签被选中时变成叉；悬停叉本身时叉变主题强调色并带小方框 */}
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <span className={cn('items-center justify-center', active ? 'hidden' : 'flex group-hover/tab:hidden')}>
                      {t.kind === 'local' ? <ShellIcon shell={t.shell} /> : <OsIcon os={t.os} distro={t.distro} />}
                    </span>
                    <span
                      role="button"
                      title="关闭"
                      className={cn(
                        'size-5 items-center justify-center rounded-[4px] hover:bg-muted-foreground/20 hover:text-primary',
                        active ? 'flex' : 'hidden group-hover/tab:flex'
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (suppressTabClick.current) {
                          suppressTabClick.current = false
                          return
                        }
                        closeTab(t.id)
                      }}
                    >
                      <X strokeWidth={2} />
                    </span>
                  </span>
                  <span className={cn('min-w-0 truncate', active && 'text-primary')}>
                    {windowLabel(t.title, t.kind === 'local' ? shellLabel(t.shell) : session?.name)}
                  </span>
                </button>
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
              <Plus className="size-5" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" ref={menuContentRef}>
            {orderedShellKeys.map((key) => {
              const shell = shellById.get(key)!
              return (
                <DropdownMenuItem
                  key={key}
                  data-menu-key={key}
                  className={cn(dragMenuKey === key && 'opacity-60 ring-1 ring-foreground/30')}
                  onPointerDown={(e) => startMenuDrag(e, key)}
                  onSelect={(event) => {
                    if (suppressMenuSelect.current) {
                      suppressMenuSelect.current = false
                      event.preventDefault()
                      return
                    }
                    openLocalTab(shell.id)
                  }}
                >
                  <ShellIcon shell={shell.id} />
                  {shell.label}
                </DropdownMenuItem>
              )
            })}
            {sessions.length > 0 && <DropdownMenuSeparator />}
            {orderedSessionKeys.map((key) => {
              const s = sessionById.get(key)!
              return (
                <DropdownMenuItem
                  key={key}
                  data-menu-key={key}
                  className={cn(dragMenuKey === key && 'opacity-60 ring-1 ring-foreground/30')}
                  onPointerDown={(e) => startMenuDrag(e, key)}
                  onSelect={(event) => {
                    if (suppressMenuSelect.current) {
                      suppressMenuSelect.current = false
                      event.preventDefault()
                      return
                    }
                    openSessionTab(s, true)
                  }}
                >
                  <OsIcon {...osIconProps(s.os)} />
                  {s.name}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {overflowing && (
        <button type="button" className={topBtn} style={noDrag} disabled={!canRight} onClick={() => scrollStrip(1)}>
          <ChevronRight className="size-5" strokeWidth={2} />
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
        <Camera className="size-5" strokeWidth={2} />
      </button>
      <button
        type="button"
        className={topBtn}
        style={noDrag}
        title="截取滚动缓冲"
        disabled={!activeTabId}
        onClick={() => shoot('scrollback')}
      >
        <GalleryVertical className="size-5" strokeWidth={2} />
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

/** 按保存的顺序排 key；不在顺序表里的新项保持原相对顺序排在末尾。 */
function applyOrder(keys: string[], order: string[]): string[] {
  const pos = new Map(order.map((key, index) => [key, index]))
  return [...keys].sort(
    (a, b) => (pos.get(a) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b) ?? Number.MAX_SAFE_INTEGER)
  )
}

const MENU_ORDER_KEY = 'termpilot.menuOrder'

function readMenuOrder(): string[] {
  try {
    const raw = localStorage.getItem(MENU_ORDER_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function writeMenuOrder(order: string[]): void {
  localStorage.setItem(MENU_ORDER_KEY, JSON.stringify(order))
}
