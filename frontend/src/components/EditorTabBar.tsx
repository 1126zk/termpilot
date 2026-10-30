import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { ArrowRightToLine, ChevronLeft, ChevronRight, Eye, FilePenLine, RefreshCw, Save, SquareTerminal, WrapText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { readBuffer } from '../editor/editorBuffers'
import { useAppStore, type EditorTab } from '../stores/useAppStore'
import { FileIcon } from './FileIcon'
import { ImageTools, isImage, isMarkdown, reloadTextFile, saveTextFile } from './RemoteEditor'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from './flip'

const TOOL_BUTTON =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

const STRIP_BUTTON =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40'

function unsaved(tab: EditorTab): boolean {
  if (tab.dirty) return true
  const buffer = readBuffer(tab.key)
  return !!buffer?.loaded && buffer.text !== buffer.saved
}

/** 连接标签下面的文件标签。点 × 关闭；没保存会先确认。 */
export function EditorTabBar(props: { tabs: EditorTab[]; activeKey: string | null }) {
  const closeEditorTab = useAppStore((s) => s.closeEditorTab)
  const activateEditorTab = useAppStore((s) => s.activateEditorTab)
  const setEditorReadOnly = useAppStore((s) => s.setEditorReadOnly)
  const pinEditorTab = useAppStore((s) => s.pinEditorTab)
  const wrap = useAppStore((s) => s.editorWrap)
  const toggleEditorWrap = useAppStore((s) => s.toggleEditorWrap)
  const setNotice = useAppStore((s) => s.setNotice)
  const activeTab = props.tabs.find((t) => t.key === props.activeKey)
  const reorderEditorTabs = useAppStore((s) => s.reorderEditorTabs)
  const [pending, setPending] = useState<EditorTab | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshPending, setRefreshPending] = useState<EditorTab | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // 拖动排序，和顶部会话标签同一套（见 TabBar）：被拖标签跟手，其余 FLIP 让位
  const stripRef = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const suppressClick = useRef(false)
  const prevLeft = useRef(new Map<string, number>())
  const dragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerX = useRef(0)
  const keys = props.tabs.map((t) => t.key)

  /** 被拖标签跟手，限制在首尾文件标签之间，不盖住终端标签，也不飞到空白处 */
  const followPointer = (key: string) => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"]`)
    if (!strip || !el) return
    const offset = pointerX.current - dragStart.current.pos - (el.offsetLeft - dragStart.current.layout)
    const items = strip.querySelectorAll<HTMLElement>('[data-file-key]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetLeft - el.offsetLeft
    const max = last.offsetLeft + last.offsetWidth - el.offsetWidth - el.offsetLeft
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }
  useFlipSlide(dragKey !== null, stripRef, 'data-file-key', 'x', dragKey, prevLeft, [keys.join(), dragKey])
  useLayoutEffect(() => {
    if (dragKey) followPointer(dragKey)
  }, [keys.join(), dragKey])

  const startDrag = (event: PointerEvent, key: string) => {
    startPointerDrag({
      event,
      axis: 'x',
      onActivate: () => {
        const strip = stripRef.current
        const el = strip?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"]`)
        const pointer = strip ? event.clientX - strip.getBoundingClientRect().left + strip.scrollLeft : 0
        dragStart.current = {
          pos: event.clientX,
          layout: el?.offsetLeft ?? 0,
          grab: pointer - (el?.offsetLeft ?? 0),
          size: el?.offsetWidth ?? 0
        }
        setDragKey(key)
        setDragOffset(0)
      },
      onMove: (x) => {
        pointerX.current = x
        const strip = stripRef.current
        if (strip) {
          // 闭包里的 props 停在拖动开始那一刻，重排后要从 store 取最新顺序
          const termId = props.tabs.find((t) => t.key === key)?.termId
          const ids = useAppStore
            .getState()
            .editorTabs.filter((t) => t.termId === termId)
            .map((t) => t.key)
          // 交换判定也按限位后的视觉位置算，指针拖出范围时不会来回乱换
          const items = strip.querySelectorAll<HTMLElement>('[data-file-key]')
          const first = items[0]
          const last = items[items.length - 1]
          const raw = x - strip.getBoundingClientRect().left + strip.scrollLeft - dragStart.current.grab
          const start =
            first && last
              ? Math.min(last.offsetLeft + last.offsetWidth - dragStart.current.size, Math.max(first.offsetLeft, raw))
              : raw
          const next = moveTo(
            ids,
            key,
            dropIndex(strip, 'data-file-key', 'x', start, start + dragStart.current.size, key, ids)
          )
          if (next) {
            capturePositions(strip, 'data-file-key', 'x', prevLeft.current)
            reorderEditorTabs(next)
          }
        }
        followPointer(key)
      },
      onEnd: () => {
        // 拖完会补一个 click，不能当成切换/关闭
        suppressClick.current = true
        prevLeft.current.clear()
        setDragKey(null)
        setDragOffset(0)
      }
    })
  }
  const clickAllowed = () => {
    if (!suppressClick.current) return true
    suppressClick.current = false
    return false
  }

  const toolsRef = useRef<HTMLDivElement>(null)
  const normalToolsWidth = useRef(0)
  const [overflowing, setOverflowing] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const [compactTools, setCompactTools] = useState(false)
  const imageOpen = Boolean(activeTab && isImage(activeTab.name))

  const measureStrip = () => {
    const el = stripRef.current
    if (!el) return
    const overflow = el.scrollWidth - el.clientWidth
    setOverflowing(overflow > 1)
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    const tools = toolsRef.current
    if (!imageOpen || !tools) {
      setCompactTools(false)
      return
    }
    setCompactTools((prev) => {
      if (!prev) return overflow > 1
      const extra = Math.max(0, normalToolsWidth.current - tools.offsetWidth)
      return overflow > -(Math.max(extra, 8) - 4)
    })
  }

  useLayoutEffect(() => {
    if (!compactTools && toolsRef.current) normalToolsWidth.current = toolsRef.current.offsetWidth
  })

  useEffect(() => {
    measureStrip()
    const el = stripRef.current
    if (!el) return
    const observer = new ResizeObserver(measureStrip)
    observer.observe(el)
    if (toolsRef.current) observer.observe(toolsRef.current)
    return () => observer.disconnect()
  }, [props.tabs.length, props.activeKey, compactTools, imageOpen])

  useEffect(() => {
    if (!props.activeKey) return
    stripRef.current
      ?.querySelector(`[data-file-key="${CSS.escape(props.activeKey)}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [props.activeKey])

  const scrollStrip = (dir: -1 | 1) => {
    stripRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' })
  }

  const close = (tab: EditorTab) => {
    if (unsaved(tab)) {
      setPending(tab)
      return
    }
    closeEditorTab(tab.key)
  }

  const discard = () => {
    if (!pending) return
    closeEditorTab(pending.key)
    setPending(null)
  }

  const saveAndClose = async () => {
    if (!pending) return
    const buffer = readBuffer(pending.key)
    if (!buffer?.loaded) {
      discard()
      return
    }
    setSaving(true)
    try {
      if (pending.sessionId) {
        await window.api.sftp.write(pending.sessionId, pending.path, buffer.text)
      } else {
        await window.api.localfs.write(pending.path, buffer.text)
      }
      closeEditorTab(pending.key)
      setPending(null)
    } catch (e) {
      const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(e)
      setNotice(message)
    } finally {
      setSaving(false)
    }
  }

  const reload = async (tab: EditorTab, force = false) => {
    if (!force && unsaved(tab)) {
      setRefreshPending(tab)
      return
    }
    setRefreshing(true)
    try {
      await reloadTextFile(tab.key)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2">
      {overflowing && (
        <button type="button" className={STRIP_BUTTON} disabled={!canLeft} title="向左" onClick={() => scrollStrip(-1)}>
          <ChevronLeft className="size-4" strokeWidth={2} />
        </button>
      )}
      <div
        ref={stripRef}
        onScroll={measureStrip}
        onWheel={(e) => {
          const el = stripRef.current
          if (!el) return
          el.scrollLeft += e.deltaY + e.deltaX
        }}
        className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button
          type="button"
          title="回到终端，已打开的文件保留"
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent',
            props.activeKey === null && 'bg-primary/15 text-primary hover:bg-primary/15'
          )}
          onClick={() => activateEditorTab(null)}
        >
          <SquareTerminal className="size-4" />
          终端
        </button>
        <span className="mx-1 h-4 w-px shrink-0 bg-border" />
        {props.tabs.map((tab) => {
          const active = tab.key === props.activeKey
          return (
            <div
              key={tab.key}
              data-file-key={tab.key}
              title={tab.path}
              className={cn(
                'flex h-7 max-w-52 min-w-0 shrink-0 items-center gap-1 rounded-md bg-muted/60 pl-2.5 pr-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent',
                active && 'bg-primary/15 text-primary hover:bg-primary/15',
                dragKey === tab.key && 'relative z-10 shadow-lg ring-1 ring-foreground/30'
              )}
              style={dragKey === tab.key ? { transform: `translateX(${dragOffset}px)` } : undefined}
              onPointerDown={(e) => startDrag(e, tab.key)}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={() => clickAllowed() && activateEditorTab(tab.key)}
              >
                <FileIcon name={tab.name} kind="file" />
                <span className={cn('truncate', tab.preview && 'italic')}>{tab.name}</span>
                {tab.readOnly && <Eye className="size-3 shrink-0 opacity-70" />}
                {tab.dirty && <span className="size-2 shrink-0 rounded-full bg-current" />}
              </button>
              <button
                type="button"
                title="关闭"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
                onClick={() => clickAllowed() && close(tab)}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      {overflowing && (
        <button type="button" className={STRIP_BUTTON} disabled={!canRight} title="向右" onClick={() => scrollStrip(1)}>
          <ChevronRight className="size-4" strokeWidth={2} />
        </button>
      )}
      {activeTab && isImage(activeTab.name) && (
        <div ref={toolsRef} className="flex shrink-0">
          <ImageTools tabKey={activeTab.key} compact={compactTools} />
        </div>
      )}
      {activeTab && !isImage(activeTab.name) && (
        <button
          type="button"
          title="重新读取原文件"
          className={cn(TOOL_BUTTON, 'disabled:opacity-40')}
          disabled={refreshing}
          onClick={() => void reload(activeTab)}
        >
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          刷新
        </button>
      )}
      {activeTab && !isImage(activeTab.name) && !activeTab.readOnly && (
        <button
          type="button"
          title="保存到原文件"
          className={cn(TOOL_BUTTON, 'disabled:opacity-40')}
          disabled={saving || !unsaved(activeTab)}
          onClick={() => {
            const key = activeTab.key
            setSaving(true)
            void Promise.resolve(saveTextFile(key)).finally(() => setSaving(false))
          }}
        >
          <Save className="size-4" />
          保存
        </button>
      )}
      {activeTab && !isImage(activeTab.name) && (
        <button
          type="button"
          title={activeTab.readOnly ? '切换到编辑' : '切换到查看'}
          className={TOOL_BUTTON}
          onClick={() => {
            if (activeTab.readOnly) pinEditorTab(activeTab.key)
            setEditorReadOnly(activeTab.key, !activeTab.readOnly)
          }}
        >
          {activeTab.readOnly ? <FilePenLine className="size-4" /> : <Eye className="size-4" />}
          {activeTab.readOnly ? '编辑' : '查看'}
        </button>
      )}
      {activeTab && !isImage(activeTab.name) && !(activeTab.readOnly && isMarkdown(activeTab.name)) && (
        <button
          type="button"
          title={wrap ? '长行不折行，横向滚动' : '长行按窗口宽度折行'}
          className={TOOL_BUTTON}
          onClick={toggleEditorWrap}
        >
          {wrap ? <ArrowRightToLine className="size-4" /> : <WrapText className="size-4" />}
          {wrap ? '取消换行' : '自动换行'}
        </button>
      )}
    </div>
    <Dialog open={pending !== null} onOpenChange={(open) => !open && !saving && setPending(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>文件尚未保存</DialogTitle>
          <DialogDescription>
            {pending?.name} 有未保存的修改。关闭后这些内容会丢失。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
            取消
          </Button>
          <Button variant="destructive" disabled={saving} onClick={discard}>
            不保存
          </Button>
          <Button disabled={saving} onClick={() => void saveAndClose()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={refreshPending !== null} onOpenChange={(open) => !open && !refreshing && setRefreshPending(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重新读取文件？</DialogTitle>
          <DialogDescription>
            {refreshPending?.name} 有未保存的修改，刷新后这些内容会丢失。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={refreshing} onClick={() => setRefreshPending(null)}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={refreshing}
            onClick={() => {
              const tab = refreshPending
              setRefreshPending(null)
              if (tab) void reload(tab, true)
            }}
          >
            放弃修改并刷新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
