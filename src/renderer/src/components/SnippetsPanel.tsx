import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '../stores/useAppStore'
import type { Snippet } from '../../../shared/types'

/** 发到当前活跃终端执行。没有活跃终端时静默不做事。 */
export function sendToActiveTerminal(command: string): void {
  const activeTabId = useAppStore.getState().activeTabId
  if (!activeTabId) return
  window.api.term.input(activeTabId, `${command}\r`)
}

/** 指令片段：常用命令存起来，点一下就发到当前终端。 */
export function SnippetsPanel() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<false | { id?: string }>(false)
  const [name, setName] = useState('')
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

  const openEditor = (snippet?: Snippet) => {
    setEditing({ id: snippet?.id })
    setName(snippet?.name ?? '')
    setCommand(snippet?.command ?? '')
    setError('')
  }

  const save = async () => {
    if (!name.trim()) {
      setError('名称不能为空')
      return
    }
    if (!command.trim()) {
      setError('命令不能为空')
      return
    }
    try {
      if (editing && editing.id) await window.api.snippets.update(editing.id, name, command)
      else await window.api.snippets.create(name, command)
      setEditing(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (snippet: Snippet) => {
    if (!confirm(`删除片段「${snippet.name}」？`)) return
    await window.api.snippets.remove(snippet.id)
    await load()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 py-1.5">
        <button
          type="button"
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-muted text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={() => openEditor()}
        >
          <Plus className="size-3.5" />
          新建片段
        </button>
      </div>
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
                title={`${snippet.command}（点击发到当前终端执行）`}
                className="group flex h-8 cursor-pointer items-center rounded-md px-2 hover:bg-foreground/5"
                onClick={() => sendToActiveTerminal(snippet.command)}
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{snippet.name}</span>
                <button
                  type="button"
                  title="编辑"
                  className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground group-hover:flex"
                  onClick={(e) => {
                    e.stopPropagation()
                    openEditor(snippet)
                  }}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  title="删除"
                  className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-destructive group-hover:flex"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(snippet)
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog open={editing !== false} onOpenChange={(open) => !open && setEditing(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing && editing.id ? '编辑片段' : '新建片段'}</DialogTitle>
            <DialogDescription>点片段会把命令发到当前活跃终端执行。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label className="grid gap-1 text-xs text-muted-foreground">
              名称
              <Input value={name} placeholder="这条命令是干什么的" onChange={(e) => setName(e.target.value)} />
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              命令
              <textarea
                value={command}
                placeholder="可以写多行"
                rows={4}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                onChange={(e) => setCommand(e.target.value)}
              />
            </Label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button onClick={() => void save()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
