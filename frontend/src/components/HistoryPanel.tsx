import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Play, Search, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PanelConfirm } from './PanelDialog'
import { sendToActiveTerminal } from './SnippetsPanel'
import { useAppStore } from '../stores/useAppStore'
import type { HistoryEntry } from '../../../shared/types'

/** 历史指令：按窗口隔离，只显示当前活跃终端跑过的命令，新的在前。点击填入当前终端，自己按回车执行。
    不带滚动，排在指令片段下面，共用「命令」栏的滚动条。 */
export function HistorySection() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [kw, setKw] = useState('')
  const [clearing, setClearing] = useState(false)

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
    if (!activeTabId) return
    setClearing(false)
    await window.api.history.clear(activeTabId)
    setItems([])
  }

  const needle = kw.trim().toLowerCase()
  const filtered = needle ? items.filter((item) => item.command.toLowerCase().includes(needle)) : items

  return (
    <section>
      <div className="flex items-center gap-1 px-2 pt-3 pb-1">
        <h3 className="shrink-0 pl-1 text-xs font-medium text-muted-foreground">历史指令</h3>
        <label className="ml-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted px-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索"
            className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-sm" disabled={items.length === 0} onClick={() => setClearing(true)}>
          清空
        </Button>
      </div>
      {filtered.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm leading-5 text-muted-foreground">
          {items.length === 0 ? '在终端里跑过的命令会记在这里' : '没有匹配的历史指令'}
        </p>
      ) : (
        <div className="grid min-w-0 gap-0.5 px-1 pb-2">
          {filtered.map((item) => (
            <div
              key={item.id}
              role="button"
              className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-2.5 font-mono text-sm text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
              onClick={() => sendToActiveTerminal(item.command, false)}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 flex-1 truncate">{item.command}</span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-sm whitespace-pre-wrap break-all text-left font-mono">
                  {item.command}
                </TooltipContent>
              </Tooltip>
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
      {clearing &&
        createPortal(
          <PanelConfirm
            open
            title="清空历史指令"
            message="清空当前窗口的历史指令？"
            confirmText="清空"
            onClose={() => setClearing(false)}
            onConfirm={() => void clear()}
          />,
          document.querySelector('[data-right-panel]') ?? document.body
        )}
    </section>
  )
}
