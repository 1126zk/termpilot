import type { CSSProperties } from 'react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Camera, ChevronLeft, ChevronRight, GalleryVertical, GitBranch, Info, Menu, Minus, PanelRightClose, PanelRightOpen, Pencil, Plus, RefreshCw, Server, Square, SquareTerminal, Terminal, X } from 'lucide-react'
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
import { agentOnboardPrompt, copyAgentPrompt, termAgentPrompt, windowLabel } from '../agentPrompt'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from './flip'
import { useMenuAction } from './PanelDialog'
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
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

/** 顶栏所有图标按钮的统一规格：28×28 正方形，与标签胶囊同高。 */
const topBtn =
  'flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40'

/** 自绘窗口控制按钮：最小化 / 最大化(还原) / 关闭。hover 是低调的灰底。面板按钮只在终端页出现。 */
function WindowControls(props: { terminalActive: boolean }) {
  const [maximized, setMaximized] = useState(false)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)

  useEffect(() => {
    void window.api.win.isMaximized().then(setMaximized)
    return window.api.win.onMaximizeChanged(setMaximized)
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-0.5" style={noDrag}>
      {props.terminalActive && (
        <button
          type="button"
          className={topBtn}
          title={rightPanelOpen ? '收起右侧面板' : '展开右侧面板'}
          onClick={toggleRightPanel}
        >
          {rightPanelOpen ? (
            <PanelRightClose className="size-4" strokeWidth={2} />
          ) : (
            <PanelRightOpen className="size-4" strokeWidth={2} />
          )}
        </button>
      )}
      <button type="button" className={topBtn} title="最小化" onClick={() => void window.api.win.minimize()}>
        <Minus className="size-4" strokeWidth={2} />
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
        <X className="size-4" strokeWidth={2} />
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
  const hostsOpen = useAppStore((s) => s.hostsOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // 截图和面板按钮只为终端服务，不在终端页就不出现
  const terminalActive = Boolean(activeTabId) && !hostsOpen && !settingsOpen
  const setHostsOpen = useAppStore((s) => s.setHostsOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const renameTab = useAppStore((s) => s.renameTab)
  const setNotice = useAppStore((s) => s.setNotice)
  const [shot, setShot] = useState<CaptureDone | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // 右键选重命名后，菜单关闭时阻止 Radix 把焦点还给标签按钮，否则原地输入框会被顶得失焦
  const renameMenu = useMenuAction()
  const stripRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  // ---- 拖拽排序（标签横向 / 菜单竖向共用 ./flip 里的公共件）----
  // 被拖项 transform 跟手浮动 + z-index/阴影；其余项 FLIP 160ms 让位；
  // 4px 阈值内仍是点击/双击；容器 relative 保证 offset* 与指针同一坐标系
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const suppressTabClick = useRef(false)
  const prevLeft = useRef(new Map<string, number>())
  // pos/layout 用于跟手位移（客户端坐标差 − 布局差）；grab/size 用于交换判定（视觉边缘）
  const tabDragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerX = useRef(0)
  // + 菜单项拖拽排序：顺序存 localStorage
  const [menuOrder, setMenuOrder] = useState<string[]>(readMenuOrder)
  const menuOrderRef = useRef(menuOrder)
  const [dragMenuKey, setDragMenuKey] = useState<string | null>(null)
  const [menuDragOffset, setMenuDragOffset] = useState(0)
  const suppressMenuSelect = useRef(false)
  const menuContentRef = useRef<HTMLDivElement>(null)
  const prevMenuTop = useRef(new Map<string, number>())
  const menuDragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerY = useRef(0)

  const updateMenuOrder = (next: string[]) => {
    menuOrderRef.current = next
    setMenuOrder(next)
  }

  /** 被拖标签跟手：translateX = 指针位移 − 布局位移。用当前 DOM 的真实 offsetLeft 算 */
  const followPointer = (id: string) => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
    if (!el) return
    setDragOffset(pointerX.current - tabDragStart.current.pos - (el.offsetLeft - tabDragStart.current.layout))
  }

  /** 被拖菜单项跟手（竖向版） */
  const followMenuPointer = (key: string) => {
    const el = menuContentRef.current?.querySelector<HTMLElement>(`[data-menu-key="${key}"]`)
    if (!el) return
    setMenuDragOffset(pointerY.current - menuDragStart.current.pos - (el.offsetTop - menuDragStart.current.layout))
  }

  // 重排渲染后：其余项 FLIP 滑过去；被拖项用新布局位重算跟手位移（move 里算时 DOM 还没更新）
  useFlipSlide(dragTabId !== null, stripRef, 'data-tab-id', 'x', dragTabId, prevLeft, [tabs, dragTabId])
  useLayoutEffect(() => {
    if (dragTabId) followPointer(dragTabId)
  }, [tabs, dragTabId])
  useFlipSlide(dragMenuKey !== null, menuContentRef, 'data-menu-key', 'y', dragMenuKey, prevMenuTop, [
    menuOrder,
    dragMenuKey
  ])
  useLayoutEffect(() => {
    if (dragMenuKey) followMenuPointer(dragMenuKey)
  }, [menuOrder, dragMenuKey])

  /** 被拖元素的视觉边缘（容器坐标）越过相邻标签中点就交换，返回新顺序；没变返回 null */
  const tabDropOrder = (clientX: number, dragId: string): string[] | null => {
    const strip = stripRef.current
    if (!strip) return null
    const pointer = clientX - strip.getBoundingClientRect().left + strip.scrollLeft
    const start = pointer - tabDragStart.current.grab
    const ids = useAppStore.getState().tabs.map((tab) => tab.id)
    return moveTo(ids, dragId, dropIndex(strip, 'data-tab-id', 'x', start, start + tabDragStart.current.size, dragId, ids))
  }

  /** 菜单项竖直拖拽：被拖菜单项的视觉上/下边缘对同分区各项中点，实时改顺序 */
  const menuDropOrder = (clientY: number, dragKey: string): string[] | null => {
    const content = menuContentRef.current
    if (!content) return null
    const shellKeys = localShells.map((shell) => `shell:${shell.id}`)
    const sessionKeys = sessions.map((session) => `session:${session.id}`)
    const orderedShells = applyOrder(shellKeys, menuOrderRef.current)
    const orderedSessions = applyOrder(sessionKeys, menuOrderRef.current)
    const inShells = orderedShells.includes(dragKey)
    const section = inShells ? orderedShells : orderedSessions
    const pointer = clientY - content.getBoundingClientRect().top + content.scrollTop
    const start = pointer - menuDragStart.current.grab
    const moved = moveTo(
      section,
      dragKey,
      dropIndex(content, 'data-menu-key', 'y', start, start + menuDragStart.current.size, dragKey, section)
    )
    if (!moved) return null
    return inShells ? [...moved, ...orderedSessions] : [...orderedShells, ...moved]
  }

  const startTabDrag = (event: React.PointerEvent, id: string) => {
    startPointerDrag({
      event,
      axis: 'x',
      onActivate: () => {
        // pos/layout 用于跟手（客户端坐标差 − 布局差）；
        // grab 是抓取点在被拖元素内的偏移（容器坐标），size 是元素宽，用于边缘判定
        const strip = stripRef.current
        const el = strip?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
        const pointer = strip ? event.clientX - strip.getBoundingClientRect().left + strip.scrollLeft : 0
        tabDragStart.current = {
          pos: event.clientX,
          layout: el?.offsetLeft ?? 0,
          grab: pointer - (el?.offsetLeft ?? 0),
          size: el?.offsetWidth ?? 0
        }
        setDragTabId(id)
        setDragOffset(0)
      },
      onMove: (x) => {
        pointerX.current = x
        const next = tabDropOrder(x, id)
        if (next && stripRef.current) {
          capturePositions(stripRef.current, 'data-tab-id', 'x', prevLeft.current)
          reorderTabs(next)
        }
        followPointer(id)
      },
      onEnd: () => {
        // 拖完会补一个 click，不能当成选中/关闭。排序只留在内存，不持久化
        suppressTabClick.current = true
        prevLeft.current.clear()
        setDragTabId(null)
        setDragOffset(0)
      }
    })
  }

  const startMenuDrag = (event: React.PointerEvent, key: string) => {
    startPointerDrag({
      event,
      axis: 'y',
      onActivate: () => {
        const content = menuContentRef.current
        const el = content?.querySelector<HTMLElement>(`[data-menu-key="${key}"]`)
        const pointer = content ? event.clientY - content.getBoundingClientRect().top + content.scrollTop : 0
        menuDragStart.current = {
          pos: event.clientY,
          layout: el?.offsetTop ?? 0,
          grab: pointer - (el?.offsetTop ?? 0),
          size: el?.offsetHeight ?? 0
        }
        setDragMenuKey(key)
        setMenuDragOffset(0)
      },
      onMove: (y) => {
        pointerY.current = y
        const next = menuDropOrder(y, key)
        if (next && menuContentRef.current) {
          capturePositions(menuContentRef.current, 'data-menu-key', 'y', prevMenuTop.current)
          updateMenuOrder(next)
        }
        followMenuPointer(key)
      },
      onEnd: () => {
        // 拖完菜单项会补一次 select，不能当成打开
        suppressMenuSelect.current = true
        prevMenuTop.current.clear()
        setDragMenuKey(null)
        setMenuDragOffset(0)
        writeMenuOrder(menuOrderRef.current)
      }
    })
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
      <button
        type="button"
        className={cn(topBtn, settingsOpen && 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary')}
        style={noDrag}
        title="设置"
        onClick={() => setSettingsOpen(true)}
      >
        <Menu className="size-4" strokeWidth={2} />
      </button>
      {overflowing && (
        <button type="button" className={topBtn} style={noDrag} disabled={!canLeft} onClick={() => scrollStrip(-1)}>
          <ChevronLeft className="size-4" strokeWidth={2} />
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
        className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* 主机标签：固定在标签条最前，和其他标签同一套三档背景，没有右键 */}
        <button
          type="button"
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-3 text-[14px] font-semibold text-muted-foreground transition-colors hover:bg-accent',
            (hostsOpen || !activeTabId) && !settingsOpen && 'bg-primary/15 text-primary hover:bg-primary/15'
          )}
          style={noDrag}
          onClick={() => setHostsOpen(true)}
        >
          <Server className="size-4 shrink-0" strokeWidth={2} />
          Host
        </button>
        {tabs.map((t) => {
          const active = t.id === activeTabId && !hostsOpen && !settingsOpen
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
                    'group/tab flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md bg-muted/60 px-3 text-[14px] font-semibold text-muted-foreground transition-colors hover:bg-accent',
                    active && 'bg-primary/15 text-primary hover:bg-primary/15',
                    dragTabId === t.id && 'relative z-10 shadow-lg ring-1 ring-foreground/30',
                    renamingId === t.id && 'max-w-none'
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
                  {renamingId === t.id ? (
                    <InlineRename
                      tabId={t.id}
                      initial={windowLabel(t.title, t.kind === 'local' ? shellLabel(t.shell) : session?.name)}
                      done={() => setRenamingId(null)}
                    />
                  ) : (
                    <span className={cn('min-w-0 truncate', active && 'text-primary')}>
                      {windowLabel(t.title, t.kind === 'local' ? shellLabel(t.shell) : session?.name)}
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={renameMenu.keepFocusOnClose}
              >
                <ContextMenuItem
                  onClick={() => void copyAgentPrompt(agentOnboardPrompt(), setNotice)}
                >
                  <Bot />
                  复制 Agent 提示词
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => void copyAgentPrompt(termAgentPrompt(t, session), setNotice, '终端信息')}
                >
                  <Info />
                  复制终端信息
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => renameMenu.openFromMenu(() => setRenamingId(t.id))}
                >
                  <Pencil />
                  重命名
                </ContextMenuItem>
                {(termState[t.id]?.status === 'disconnected' || termState[t.id]?.status === 'error') ? (
                  <ContextMenuItem onClick={() => reconnectTab(t.id)}>
                    <RefreshCw />
                    重新连接
                  </ContextMenuItem>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => closeTab(t.id)}>
                  <X />
                  关闭
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            </Fragment>
          )
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(topBtn, 'shrink-0')} style={noDrag} title="新建终端">
              <Plus className="size-4" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" ref={menuContentRef} className="relative">
            {orderedShellKeys.map((key) => {
              const shell = shellById.get(key)!
              return (
                <DropdownMenuItem
                  key={key}
                  data-menu-key={key}
                  className={cn(dragMenuKey === key && 'relative z-10 shadow-lg ring-1 ring-foreground/30')}
                  style={dragMenuKey === key ? { transform: `translateY(${menuDragOffset}px)` } : undefined}
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
                  className={cn(dragMenuKey === key && 'relative z-10 shadow-lg ring-1 ring-foreground/30')}
                  style={dragMenuKey === key ? { transform: `translateY(${menuDragOffset}px)` } : undefined}
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
          <ChevronRight className="size-4" strokeWidth={2} />
        </button>
      )}
      {terminalActive && (
        <>
          <button
            type="button"
            className={topBtn}
            style={noDrag}
            title="截取当前终端画面"
            onClick={() => shoot('viewport')}
          >
            <Camera className="size-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            className={topBtn}
            style={noDrag}
            title="截取滚动缓冲"
            onClick={() => shoot('scrollback')}
          >
            <GalleryVertical className="size-4" strokeWidth={2} />
          </button>
        </>
      )}
      {window.api.platform === 'win32' && <WindowControls terminalActive={terminalActive} />}
    </div>
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

/**
 * 标签原地改名：透明输入框、进入时全选。右键菜单路径已在菜单关闭时阻止 Radix 归还焦点
 * （见 useMenuAction），所以这里挂载时一次聚焦全选即可；退出靠 Enter 保存 / Esc 取消 / 点别处保存。
 */
function InlineRename(props: { tabId: string; initial: string; done: () => void }) {
  const renameTab = useAppStore((s) => s.renameTab)
  const ref = useRef<HTMLInputElement>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mountedAt = Date.now()
    el.focus()
    el.select()
    const onPointerDown = (e: PointerEvent) => {
      if (el.contains(e.target as Node)) return
      // 挂载后 250ms 内的 pointerdown 是打开菜单那次手势的残留，不算"点别处"
      if (Date.now() - mountedAt < 250) return
      renameTab(latest.current.tabId, el.value)
      latest.current.done()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [renameTab])

  return (
    <input
      ref={ref}
      className="min-w-0 flex-1 bg-transparent px-0 outline-none selection:bg-primary/25 selection:text-primary"
      defaultValue={props.initial}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          renameTab(props.tabId, e.currentTarget.value)
          props.done()
        }
        if (e.key === 'Escape') props.done()
      }}
    />
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
