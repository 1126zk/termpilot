import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { sendToActiveTerminal } from './SnippetsPanel'
import type { HistoryEntry } from '../../../shared/types'

/** 历史指令：从终端按键流里结算出来的命令，新的在前。点击发到当前终端执行。 */
export function HistoryPanel() {
  const [items, setItems] = useState<HistoryEntry[]>([])

  const load = useCallback(async () => {
    try {
      setItems(await window.api.history.list())
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => void load(), [load])

  // 主进程写入新命令后推 historyChanged，开着面板也能看到最新记录
  useEffect(() => window.api.history.onChanged(() => void load()), [load])

  const clear = async () => {
    if (!confirm('清空全部历史指令？')) return
    await window.api.history.clear()
    setItems([])
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <p className="text-xs text-muted-foreground">按回车结算，只留最近 200 条</p>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={items.length === 0} onClick={() => void clear()}>
          清空
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
            在终端里跑过的命令会记在这里
          </p>
        ) : (
          <div className="grid gap-0.5 px-1 pb-2">
            {items.map((item) => (
              <div
                key={item.id}
                role="button"
                title="点击发到当前终端执行"
                className="cursor-pointer rounded-md px-2 py-1 font-mono text-xs break-all hover:bg-foreground/5"
                onClick={() => sendToActiveTerminal(item.command)}
              >
                {item.command}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
