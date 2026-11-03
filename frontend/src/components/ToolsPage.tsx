import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from './flip'
import { PasswordGenerator } from './tools/PasswordGenerator'
import { MermaidViewer } from './tools/MermaidViewer'
import { MarkdownViewer } from './tools/MarkdownViewer'

const ORDER_KEY = 'termpilot.toolOrder'
const HIDDEN_KEY = 'termpilot.toolHidden'

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
  { id: 'password', name: '密码生成器', component: PasswordGenerator },
  { id: 'mermaid', name: 'Mermaid 查看器', component: MermaidViewer },
  { id: 'markdown', name: 'Markdown 预览', component: MarkdownViewer }
]

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return tools.map((t) => t.id)
    const saved = JSON.parse(raw) as string[]
    const known = new Set(tools.map((t) => t.id))
    const ordered = saved.filter((id) => known.has(id))
    for (const tool of tools) if (!ordered.includes(tool.id)) ordered.push(tool.id)
    return ordered
  } catch {
    return tools.map((t) => t.id)
  }
}

function readHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (raw) return JSON.parse(raw) as string[]
  } catch {
    // 本地数据损坏时当作全部可见
  }
  return []
}

/** 工具页：一行一个工具，可拖拽排序，顺序保存在本地。 */
export function ToolsPage() {
  const [order, setOrder] = useState<string[]>(readOrder)
  const [hiddenIds, setHiddenIds] = useState<string[]>(readHidden)
  const [soloId, setSoloId] = useState<string | null>(null)
  const [fullDiagram, setFullDiagram] = useState(false)
  const orderRef = useRef(order)
  const listRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const prevTop = useRef(new Map<string, number>())
  const dragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerY = useRef(0)

  const updateOrder = (next: string[]) => {
    orderRef.current = next
    setOrder(next)
  }

  const followPointer = (id: string) => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>(`[data-tool-id="${id}"]`)
    if (!list || !el) return
    const offset = pointerY.current - dragStart.current.pos - (el.offsetTop - dragStart.current.layout)
    const items = list.querySelectorAll<HTMLElement>('[data-tool-id]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetTop - el.offsetTop
    const max = last.offsetTop + last.offsetHeight - el.offsetHeight - el.offsetTop
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }

  const dropOrder = (clientY: number, id: string): string[] | null => {
    const list = listRef.current
    if (!list) return null
    const pointer = clientY - list.getBoundingClientRect().top + list.scrollTop
    const start = pointer - dragStart.current.grab
    return moveTo(
      orderRef.current,
      id,
      dropIndex(list, 'data-tool-id', 'y', start, start + dragStart.current.size, id, orderRef.current)
    )
  }

  const startDrag = (event: React.PointerEvent, id: string) => {
    startPointerDrag({
      event,
      axis: 'y',
      onActivate: () => {
        const list = listRef.current
        const el = list?.querySelector<HTMLElement>(`[data-tool-id="${id}"]`)
        const pointer = list ? event.clientY - list.getBoundingClientRect().top + list.scrollTop : 0
        dragStart.current = {
          pos: event.clientY,
          layout: el?.offsetTop ?? 0,
          grab: pointer - (el?.offsetTop ?? 0),
          size: el?.offsetHeight ?? 0
        }
        setDragId(id)
        setDragOffset(0)
      },
      onMove: (y) => {
        pointerY.current = y
        const next = dropOrder(y, id)
        if (next && listRef.current) {
          capturePositions(listRef.current, 'data-tool-id', 'y', prevTop.current)
          updateOrder(next)
        }
        followPointer(id)
      },
      onEnd: () => {
        prevTop.current.clear()
        setDragId(null)
        setDragOffset(0)
        localStorage.setItem(ORDER_KEY, JSON.stringify(orderRef.current))
      }
    })
  }

  useFlipSlide(dragId !== null, listRef, 'data-tool-id', 'y', dragId, prevTop, [order, dragId])
  useLayoutEffect(() => {
    if (dragId) followPointer(dragId)
  }, [order, dragId])

  const toggleHidden = (id: string) => {
    setHiddenIds((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next))
      return next
    })
  }

  const visibleOrder = order.filter((id) => !hiddenIds.includes(id) && (!soloId || id === soloId))

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', fullDiagram ? 'overflow-hidden' : 'overflow-y-auto')}>
      <div className={cn('flex w-full flex-col', fullDiagram ? 'min-h-0 flex-1' : 'gap-3 px-6 py-5')}>
        {!fullDiagram && (
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5">
            {order.map((id) => {
              const tool = tools.find((t) => t.id === id)
              if (!tool) return null
              const hidden = hiddenIds.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  className={cn(
                    'flex h-7 items-center rounded-md px-3 text-[13px] font-medium transition-colors',
                    hidden
                      ? 'bg-muted/60 text-muted-foreground hover:bg-accent'
                      : 'bg-primary/15 text-primary hover:bg-primary/20'
                  )}
                  title={hidden ? '点击显示' : '点击隐藏'}
                  onClick={() => toggleHidden(id)}
                >
                  {tool.name}
                </button>
              )
            })}
          </div>
        )}
        <div
          ref={listRef}
          className={cn('relative flex w-full flex-col', fullDiagram ? 'min-h-0 flex-1' : 'mx-auto max-w-3xl')}
        >
          {visibleOrder.length === 0 && (
            <p className="py-10 text-center text-xs text-muted-foreground">所有工具已隐藏，点上方标签重新打开</p>
          )}
          {visibleOrder.map((id) => {
            const tool = tools.find((t) => t.id === id)
            if (!tool) return null
            const Component = tool.component
            return (
              <div
                key={tool.id}
                data-tool-id={tool.id}
                className={cn(
                  fullDiagram
                    ? 'flex min-h-0 flex-1'
                    : 'flex items-center gap-3 border-b border-border py-4 first:pt-0 last:border-b-0',
                  dragId === tool.id && 'relative z-10 bg-background shadow-lg ring-1 ring-foreground/30'
                )}
                style={dragId === tool.id ? { transform: `translateY(${dragOffset}px)` } : undefined}
              >
                {!fullDiagram && (
                  <div className="flex w-32 shrink-0 items-center">
                    <span
                      className="cursor-grab select-none text-sm font-medium text-foreground active:cursor-grabbing"
                      title="拖拽排序"
                      onPointerDown={(e) => startDrag(e, tool.id)}
                    >
                      {tool.name}
                    </span>
                  </div>
                )}
                <div className={cn('min-w-0 flex-1', fullDiagram && 'flex min-h-0 flex-col')}>
                  <Component
                    solo={soloId === id}
                    onSolo={() => setSoloId((current) => (current === id ? null : id))}
                    onFullDiagram={(full) => {
                      setFullDiagram(full)
                      // 退出全屏时恢复显示全部工具，否则 solo 会把其他工具一直过滤掉
                      if (!full) setSoloId(null)
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
