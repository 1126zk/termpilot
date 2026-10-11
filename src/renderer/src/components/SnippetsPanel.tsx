import { useCallback, useEffect, useState } from 'react'
import { Check, Play, SquareTerminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '../stores/useAppStore'
import { terminalPool } from '../terminal/TerminalPool'
import type { Snippet } from '../../../shared/types'

/** 发到当前活跃终端并把焦点还给终端。execute 为 true 时补回车直接执行，false 只填入等用户自己回车。没有活跃终端时静默不做事。 */
export function sendToActiveTerminal(command: string, execute = true): void {
  const activeTabId = useAppStore.getState().activeTabId
  if (!activeTabId) return
  window.api.term.input(activeTabId, execute ? `${command}\r` : command)
  terminalPool.focus(activeTabId)
}

/** 指令片段：顶部输入框直接写命令，保存即入列；每条可编辑、填入、直接执行、删除。 */
export function SnippetsPanel() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setSnippets(await window.api.snippets.list())
    } catch {
      setSnippets([])
    }
  }, [])

  useEffect(() => void load(), [load])

  const reset = () => {
    setCommand('')
    setError('')
  }

  const save = async () => {
    const text = command.trim()
    if (!text) {
      setError('命令不能为空')
      return
    }
    try {
      // 名称不再单独收集，用首行兜底（表结构里这列还在）
      const name = text.split('\n')[0].slice(0, 50)
      await window.api.snippets.create(name, text)
      reset()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (snippet: Snippet) => {
    if (!confirm(`删除片段「${snippet.command.split('\n')[0]}」？`)) return
    await window.api.snippets.remove(snippet.id)
    await load()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-1.5 px-2 pt-2 pb-1">
        <textarea
          value={command}
          placeholder="写一条命令，可以写多行"
          rows={2}
          spellCheck={false}
          className="min-h-9 min-w-0 flex-1 resize-none rounded-md bg-muted px-2 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground"
          onChange={(e) => setCommand(e.target.value)}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          title="保存为片段"
          className="mt-0.5 text-primary"
          disabled={!command.trim()}
          onClick={() => void save()}
        >
          <Check />
        </Button>
      </div>
      {error && <p className="px-3 pb-1 text-xs text-destructive">{error}</p>}
      <ScrollArea className="min-h-0 flex-1">
        {snippets.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
            把常用命令存成片段，一键复用
          </p>
        ) : (
          <div className="grid gap-0.5 px-1 pb-2">
            {snippets.map((snippet) => (
              <div
                key={snippet.id}
                role="button"
                title={snippet.command}
                className="group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-2.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                onClick={() => sendToActiveTerminal(snippet.command, false)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {snippet.command.split('\n')[0]}
                </span>
                <button
                  type="button"
                  title="填入终端（自己回车执行）"
                  className="invisible flex size-6 shrink-0 items-center justify-center rounded bg-muted-foreground/10 text-muted-foreground hover:text-primary group-hover:visible"
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToActiveTerminal(snippet.command, false)
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
                    sendToActiveTerminal(snippet.command, true)
                  }}
                >
                  <Play className="size-4" />
                </button>
                <button
                  type="button"
                  title="删除"
                  className="invisible flex size-6 shrink-0 items-center justify-center rounded bg-muted-foreground/10 text-muted-foreground hover:text-primary group-hover:visible"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(snippet)
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
