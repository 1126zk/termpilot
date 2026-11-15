import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, Copy, Plus, Search, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '../stores/useAppStore'
import { cn } from '@/lib/utils'
import { agentOnboardPrompt, copyAgentPrompt } from '../agentPrompt'
import { hostKeyOf } from '../../../shared/host-key'
import { OsIcon, osIconProps } from './OsIcon'
import { capturePoints, gridNeighborSwap, startPointerDrag, useFlipMove, type FlipPoint } from './flip'
import type { SessionConfig } from '../../../shared/types'

/** 主机页：没有终端标签时的主页。卡片网格列出全部连接，点开即连。 */
export function HostsPage() {
  const sessions = useAppStore((s) => s.sessions)
  const hostNotes = useAppStore((s) => s.hostNotes)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const setEditing = useAppStore((s) => s.setEditing)
  const reorderSessions = useAppStore((s) => s.reorderSessions)
  const saveSessionOrder = useAppStore((s) => s.saveSessionOrder)

  const kw = search.trim().toLowerCase()
  const filtered = kw
    ? sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(kw) ||
          s.host.toLowerCase().includes(kw) ||
          (s.remark ?? '').toLowerCase().includes(kw) ||
          (hostNotes[hostKeyOf(s.host)] ?? '').toLowerCase().includes(kw)
      )
    : sessions

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-3 py-5 pr-6 pl-25">
        <div className="flex items-center gap-1.5">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-3 text-muted-foreground">
            <Search className="size-4 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主机"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button
            type="button"
            title="新建主机"
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setEditing({ action: 'create' })}
          >
            <Plus className="size-5" strokeWidth={2} />
          </button>
        </div>

        <p className="text-xs text-muted-foreground">主机</p>
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {kw ? '没有匹配的主机' : '还没有主机，点上面的 + 新建'}
          </p>
        ) : (
          <HostGrid sessions={filtered} sortable={!kw} onReorder={reorderSessions} onSave={saveSessionOrder} />
        )}
      </div>
    </div>
  )
}

function HostGrid(props: {
  sessions: SessionConfig[]
  sortable: boolean
  onReorder: (ids: string[]) => void
  onSave: () => Promise<void>
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const suppressClick = useRef(false)
  const prev = useRef(new Map<string, FlipPoint>())
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 })
  const pointer = useRef({ x: 0, y: 0 })
  const ids = props.sessions.map((session) => session.id)
  const idsRef = useRef(ids)
  idsRef.current = ids

  const follow = (id: string) => {
    const grid = gridRef.current
    const el = grid?.querySelector<HTMLElement>(`[data-host-id="${id}"]`)
    if (!grid || !el) return
    let x = pointer.current.x - dragStart.current.x - (el.offsetLeft - dragStart.current.layoutX)
    let y = pointer.current.y - dragStart.current.y - (el.offsetTop - dragStart.current.layoutY)
    const cards = grid.querySelectorAll<HTMLElement>('[data-host-id]')
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const card of cards) {
      minX = Math.min(minX, card.offsetLeft)
      minY = Math.min(minY, card.offsetTop)
      maxX = Math.max(maxX, card.offsetLeft + card.offsetWidth)
      maxY = Math.max(maxY, card.offsetTop + card.offsetHeight)
    }
    if (minX !== Infinity) {
      x = Math.min(maxX - el.offsetWidth - el.offsetLeft, Math.max(minX - el.offsetLeft, x))
      y = Math.min(maxY - el.offsetHeight - el.offsetTop, Math.max(minY - el.offsetTop, y))
    }
    setDragOffset((prev) => (prev.x === x && prev.y === y ? prev : { x, y }))
  }

  const dropOrder = (id: string): string[] | null => {
    const grid = gridRef.current
    const el = grid?.querySelector<HTMLElement>(`[data-host-id="${id}"]`)
    if (!grid || !el) return null
    const x = pointer.current.x - dragStart.current.x - (el.offsetLeft - dragStart.current.layoutX)
    const y = pointer.current.y - dragStart.current.y - (el.offsetTop - dragStart.current.layoutY)
    return gridNeighborSwap(
      grid,
      'data-host-id',
      el.offsetLeft + x,
      el.offsetTop + y,
      el.offsetWidth,
      el.offsetHeight,
      id,
      idsRef.current
    )
  }

  useFlipMove(dragId !== null, gridRef, 'data-host-id', dragId, prev, [props.sessions, dragId])
  useLayoutEffect(() => {
    if (dragId) follow(dragId)
    // follow 读的是 ref，顺序变了才需要按新格子重算跟手位移
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessions, dragId])

  const startDrag = (event: ReactPointerEvent, id: string) => {
    if (!props.sortable) return
    pointer.current = { x: event.clientX, y: event.clientY }
    const track = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY }
    }
    window.addEventListener('pointermove', track)
    const stopTrack = () => {
      window.removeEventListener('pointermove', track)
      window.removeEventListener('pointerup', stopTrack)
      window.removeEventListener('pointercancel', stopTrack)
    }
    window.addEventListener('pointerup', stopTrack)
    window.addEventListener('pointercancel', stopTrack)
    startPointerDrag({
      event,
      axis: 'both',
      onActivate: () => {
        const grid = gridRef.current
        const el = grid?.querySelector<HTMLElement>(`[data-host-id="${id}"]`)
        dragStart.current = {
          x: event.clientX,
          y: event.clientY,
          layoutX: el?.offsetLeft ?? 0,
          layoutY: el?.offsetTop ?? 0
        }
        setDragId(id)
        setDragOffset({ x: 0, y: 0 })
      },
      onMove: () => {
        const next = dropOrder(id)
        if (next && gridRef.current) {
          capturePoints(gridRef.current, 'data-host-id', prev.current)
          props.onReorder(next)
        }
        follow(id)
      },
      onEnd: () => {
        suppressClick.current = true
        prev.current.clear()
        setDragId(null)
        setDragOffset({ x: 0, y: 0 })
        void props.onSave()
      }
    })
  }

  return (
    <div ref={gridRef} className="relative grid max-w-5xl grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {props.sessions.map((session) => (
        <HostCard
          key={session.id}
          session={session}
          draggable={props.sortable}
          dragging={dragId === session.id}
          offset={dragId === session.id ? dragOffset : { x: 0, y: 0 }}
          suppressClick={suppressClick}
          onPointerDown={(event) => startDrag(event, session.id)}
        />
      ))}
    </div>
  )
}

function HostCard(props: {
  session: SessionConfig
  draggable: boolean
  dragging: boolean
  offset: { x: number; y: number }
  suppressClick: { current: boolean }
  onPointerDown: (event: ReactPointerEvent) => void
}) {
  const session = props.session
  const openSessionTab = useAppStore((s) => s.openSessionTab)
  const editing = useAppStore((s) => s.editing)
  const setEditing = useAppStore((s) => s.setEditing)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const setNotice = useAppStore((s) => s.setNotice)
  const clickTimer = useRef<number>(0)

  // 单击 = 主机信息面板滑出/滑回；双击 = 新开一扇终端（每次都新开）
  const open = () => {
    if (eaten()) return
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      if (editing?.action === 'edit' && editing.session.id === session.id) setEditing(null)
      else setEditing({ action: 'edit', session })
    }, 250)
  }

  const eaten = () => {
    if (!props.suppressClick.current) return false
    window.setTimeout(() => {
      props.suppressClick.current = false
    }, 0)
    return true
  }

  const openFresh = () => {
    if (eaten()) return
    window.clearTimeout(clickTimer.current)
    openSessionTab(session, true)
  }

  const duplicate = async () => {
    const created = await window.api.sessions.duplicate(session.id).catch(() => null)
    if (!created) {
      setNotice('复制失败')
      return
    }
    await loadSessions()
    setEditing({ action: 'edit', session: created })
    setNotice('已复制，改用户名即可')
  }

  return (
    <div className="min-w-0" data-host-id={session.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            className={cn(
              'group flex w-full min-w-0 items-center gap-3 rounded-lg bg-muted-foreground/10 px-4 py-3.5 text-left transition-colors hover:bg-muted-foreground/15',
              props.draggable ? 'cursor-grab' : 'cursor-pointer',
              props.dragging && 'relative z-10 cursor-grabbing shadow-lg ring-1 ring-foreground/30',
              editing?.action === 'edit' && editing.session.id === session.id && 'ring-2 ring-primary/50'
            )}
            style={props.dragging ? { transform: `translate(${props.offset.x}px, ${props.offset.y}px)` } : undefined}
            onPointerDown={props.onPointerDown}
            onClick={open}
            onDoubleClick={openFresh}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted-foreground/15 text-muted-foreground [&_svg]:size-5">
              <OsIcon {...osIconProps(session.os)} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-muted-foreground">{session.name}</span>
              <span className="block truncate text-xs text-muted-foreground">ssh, {session.username}</span>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void duplicate()}>
            <Copy />
            复制主机
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyAgentPrompt(agentOnboardPrompt(), setNotice)}>
            <Bot />
            复制 Agent 提示词
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => deleteSession(session.id)}>
            <Trash2 />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
