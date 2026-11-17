import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from './flip'
import { PasswordGenerator } from './tools/PasswordGenerator'
import { PreviewViewer } from './tools/PreviewViewer'
import { NetworkTool } from './tools/NetworkTool'
import { SshKeyTool } from './tools/SshKeyTool'
import { TodoTool } from './tools/TodoTool'

const ORDER_KEY = 'termpilot.toolOrder'
const LAST_KEY = 'termpilot.toolLast'
const DEFAULT_TOOL = 'todo'

export interface ToolProps {
  /** 当前是否只显示这一个工具 */
  solo?: boolean
  /** 切换「只显示这个工具 / 显示全部工具」 */
  onSolo?: () => void
  /** 切换「整个主界面只看渲染图」 */
  onFullDiagram?: (full: boolean) => void
}

interface ToolDef {
  id: string
  name: string
  component: ComponentType<ToolProps>
}

const tools: ToolDef[] = [
  { id: 'todo', name: '待办', component: TodoTool },
  { id: 'password', name: '密码生成器', component: PasswordGenerator },
  { id: 'sshkey', name: '密钥管理', component: SshKeyTool },
  { id: 'speed', name: '网络状态', component: NetworkTool },
  { id: 'preview', name: '预览', component: PreviewViewer }
]

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return tools.map((tool) => tool.id)
    const saved = JSON.parse(raw) as string[]
    const known = new Set(tools.map((tool) => tool.id))
    const ordered = saved.filter((id) => known.has(id))
    for (const tool of tools) {
      if (ordered.includes(tool.id)) continue
      if (tool.id === DEFAULT_TOOL) ordered.unshift(tool.id)
      else ordered.push(tool.id)
    }
    return ordered
  } catch {
    return tools.map((tool) => tool.id)
  }
}

function readLast(): string {
  try {
    const id = localStorage.getItem(LAST_KEY)
    if (id && tools.some((tool) => tool.id === id)) return id
  } catch {
    // 读不到就当没打开过
  }
  return DEFAULT_TOOL
}

/** 工具页：一次只显示一个工具。没打开过先看到待办，打开过回到上次的工具。标签可拖拽排序。 */
export function ToolsPage() {
  const [order, setOrder] = useState<string[]>(readOrder)
  const [activeId, setActiveId] = useState(readLast)
  const [fullDiagram, setFullDiagram] = useState(false)
  const orderRef = useRef(order)
  const listRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const prevLeft = useRef(new Map<string, number>())
  const dragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerX = useRef(0)
  const suppressClick = useRef(false)

  const updateOrder = (next: string[]) => {
    orderRef.current = next
    setOrder(next)
  }

  const followPointer = (id: string) => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>(`[data-tool-id="${id}"]`)
    if (!list || !el) return
    const offset = pointerX.current - dragStart.current.pos - (el.offsetLeft - dragStart.current.layout)
    const items = list.querySelectorAll<HTMLElement>('[data-tool-id]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetLeft - el.offsetLeft
    const max = last.offsetLeft + last.offsetWidth - el.offsetWidth - el.offsetLeft
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }

  const dropOrder = (clientX: number, id: string): string[] | null => {
    const list = listRef.current
    if (!list) return null
    const raw = clientX - list.getBoundingClientRect().left + list.scrollLeft - dragStart.current.grab
    const items = list.querySelectorAll<HTMLElement>('[data-tool-id]')
    const first = items[0]
    const last = items[items.length - 1]
    const start =
      first && last
        ? Math.min(last.offsetLeft + last.offsetWidth - dragStart.current.size, Math.max(first.offsetLeft, raw))
        : raw
    return moveTo(
      orderRef.current,
      id,
      dropIndex(list, 'data-tool-id', 'x', start, start + dragStart.current.size, id, orderRef.current)
    )
  }

  const startDrag = (event: React.PointerEvent, id: string) => {
    startPointerDrag({
      event,
      axis: 'x',
      onActivate: () => {
        const list = listRef.current
        const el = list?.querySelector<HTMLElement>(`[data-tool-id="${id}"]`)
        const pointer = list ? event.clientX - list.getBoundingClientRect().left + list.scrollLeft : 0
        dragStart.current = {
          pos: event.clientX,
          layout: el?.offsetLeft ?? 0,
          grab: pointer - (el?.offsetLeft ?? 0),
          size: el?.offsetWidth ?? 0
        }
        setDragId(id)
        setDragOffset(0)
      },
      onMove: (x) => {
        pointerX.current = x
        const next = dropOrder(x, id)
        if (next && listRef.current) {
          capturePositions(listRef.current, 'data-tool-id', 'x', prevLeft.current)
          updateOrder(next)
        }
        followPointer(id)
      },
      onEnd: () => {
        suppressClick.current = true
        prevLeft.current.clear()
        setDragId(null)
        setDragOffset(0)
        localStorage.setItem(ORDER_KEY, JSON.stringify(orderRef.current))
      }
    })
  }

  useFlipSlide(dragId !== null, listRef, 'data-tool-id', 'x', dragId, prevLeft, [order, dragId])
  useLayoutEffect(() => {
    if (dragId) followPointer(dragId)
  }, [order, dragId])

  const selected = order.includes(activeId) ? activeId : DEFAULT_TOOL
  const active = tools.find((tool) => tool.id === selected) ?? tools[0]
  const ActiveTool = active.component

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', fullDiagram ? 'overflow-hidden' : 'overflow-y-auto')}>
      <div className={cn('flex w-full flex-col', fullDiagram ? 'min-h-0 flex-1' : 'gap-6 px-6 py-5')}>
        {!fullDiagram && (
          <div
            ref={listRef}
            className="relative mx-auto flex w-full max-w-3xl flex-nowrap items-center gap-1.5 overflow-x-auto"
          >
            {order.map((id) => {
              const tool = tools.find((item) => item.id === id)
              if (!tool) return null
              const on = tool.id === selected
              return (
                <button
                  key={id}
                  type="button"
                  data-tool-id={id}
                  className={cn(
                    'flex h-7 shrink-0 items-center rounded-md px-3 text-[13px] font-medium transition-colors',
                    on ? 'bg-primary/15 text-primary' : 'bg-muted/60 text-muted-foreground hover:bg-accent',
                    dragId === id && 'relative z-10 shadow-lg ring-1 ring-foreground/30'
                  )}
                  style={dragId === id ? { transform: `translateX(${dragOffset}px)` } : undefined}
                  title="拖拽排序"
                  onPointerDown={(event) => startDrag(event, id)}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false
                      return
                    }
                    setActiveId(id)
                    localStorage.setItem(LAST_KEY, id)
                  }}
                >
                  {tool.name}
                </button>
              )
            })}
          </div>
        )}
        <div className={cn('flex w-full flex-col', fullDiagram ? 'min-h-0 flex-1' : 'mx-auto max-w-3xl')}>
          <ActiveTool
            solo
            onFullDiagram={(full) => {
              setFullDiagram(full)
            }}
          />
        </div>
      </div>
    </div>
  )
}
