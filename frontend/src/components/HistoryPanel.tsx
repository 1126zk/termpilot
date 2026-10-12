import { useCallback, useEffect, useState } from 'react'
import { Play, Search, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { sendToActiveTerminal } from './SnippetsPanel'
import { useAppStore } from '../stores/useAppStore'
import type { HistoryEntry } from '../../../shared/types'

/** 历史指令：按窗口隔离，只显示当前活跃终端跑过的命令，新的在前。点击填入当前终端，自己按回车执行。 */
export function HistoryPanel() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [kw, setKw] = useState('')

  const load = useCallback(async () => {
    if (!activeTabId) {
      setItems([])
      return
    }
    try {
      setItems(await window.api.history.list(activeTabId))
    } catch {
      setItems([])
    }
  }, [activeTabId])

  // 切窗口重载；当前窗口有新命令时主进程推 historyChanged 实时刷新
  useEffect(() => void load(), [load])
  useEffect(
    () =>
      window.api.history.onChanged((termId) => {
        if (termId === activeTabId) void load()
      }),
    [load, activeTabId]
  )

  const clear = async () => {
    if (!activeTabId || !confirm('清空当前窗口的历史指令？')) return
    await window.api.history.clear(activeTabId)
    setItems([])
  }

  const needle = kw.trim().toLowerCase()
  const filtered = needle ? items.filter((item) => item.command.toLowerCase().includes(needle)) : items

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted px-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={items.length === 0} onClick={() => void clear()}>
          清空
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
            {items.length === 0 ? '在终端里跑过的命令会记在这里' : '没有匹配的历史指令'}
          </p>
        ) : (
          <div className="grid gap-0.5 px-1 pb-2">
            {filtered.map((item) => (
              <div
                key={item.id}
                role="button"
                title="点击填入当前终端，自己按回车执行"
                className="group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-2.5 font-mono text-xs break-all text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                onClick={() => sendToActiveTerminal(item.command, false)}
              >
                <span className="min-w-0 flex-1 truncate">{item.command}</span>
                <button
                  type="button"
                  title="填入终端（自己回车执行）"
                  className="invisible flex size-6 shrink-0 items-center justify-center rounded bg-muted-foreground/10 text-muted-foreground hover:text-primary group-hover:visible"
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToActiveTerminal(item.command, false)
                  }}
                >
                  <SquareTerminal className="size-4" />
                </button>
                <button
                  type="button"
                  title="直接执行"
                  className="invisible flex size-6 shrink-0 items-center justify-center rounded bg-muted-foreground/10 text-muted-foreground hover:text-primary group-hover:visible"
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToActiveTerminal(item.command, true)
                  }}
                >
                  <Play className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
