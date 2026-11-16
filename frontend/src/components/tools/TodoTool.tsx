import { useEffect, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'termpilot.tool.todo'

interface TodoItem {
  id: string
  text: string
  done: boolean
}

function readItems(): TodoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as TodoItem[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string').map((item) => ({
      id: item.id,
      text: item.text,
      done: Boolean(item.done)
    }))
  } catch {
    return []
  }
}

/** 待办：本地记下的事项，勾完可清掉。 */
export function TodoTool() {
  const [items, setItems] = useState<TodoItem[]>(readItems)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  }, [items])

  const add = () => {
    const text = draft.trim()
    if (!text) return
    setItems((current) => [...current, { id: crypto.randomUUID(), text, done: false }])
    setDraft('')
  }

  const hasDone = items.some((item) => item.done)

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <Input value={draft} placeholder="添加待办" className="h-8" onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={!draft.trim()}>
          <Plus className="size-3.5" />
          添加
        </Button>
      </form>
      {items.length > 0 && (
        <div className="flex flex-col">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 border-b border-border py-2 last:border-b-0">
              <button
                type="button"
                aria-label={item.done ? '标为未完成' : '标为完成'}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                  item.done ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                )}
                onClick={() =>
                  setItems((current) => current.map((row) => (row.id === item.id ? { ...row, done: !row.done } : row)))
                }
              >
                {item.done && <Check className="size-3" strokeWidth={2.5} />}
              </button>
              <span className={cn('min-w-0 flex-1 text-sm break-all', item.done && 'text-muted-foreground line-through')}>
                {item.text}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="删除"
                onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {hasDone && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => setItems((current) => current.filter((item) => !item.done))}>
            清除已完成
          </Button>
        </div>
      )}
    </div>
  )
}
