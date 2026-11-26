import { useEffect, useRef, useState } from 'react'
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

function oneLine(text: string) {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

function readItems(): TodoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as TodoItem[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string').map((item) => ({
      id: item.id,
      text: oneLine(item.text),
      done: Boolean(item.done)
    }))
  } catch {
    return []
  }
}

function TodoText(props: { text: string; done: boolean; onCommit: (value: string) => void }) {
  const cancelEdit = useRef(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.text)

  return (
    <Input
      value={editing ? draft : props.text}
      aria-label="编辑待办"
      className={cn('h-8 min-w-0 flex-1 cursor-text px-2', props.done && !editing && 'text-muted-foreground line-through')}
      style={{
        backgroundColor: editing ? 'var(--background)' : 'transparent',
        borderColor: editing ? 'var(--foreground)' : 'transparent',
        boxShadow: 'none'
      }}
      onFocus={() => {
        if (!editing) {
          setEditing(true)
          setDraft(props.text)
        }
      }}
      onChange={(event) => {
        setEditing(true)
        setDraft(oneLine(event.target.value))
      }}
      onBlur={(event) => {
        if (cancelEdit.current) {
          cancelEdit.current = false
          setEditing(false)
          return
        }
        setEditing(false)
        const next = oneLine(event.currentTarget.value)
        if (!next || next === props.text) return
        props.onCommit(next)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key === 'Process') return
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          cancelEdit.current = true
          setEditing(false)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** 待办：本地记下的事项，勾完可清掉。 */
export function TodoTool() {
  const [items, setItems] = useState<TodoItem[]>(readItems)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  }, [items])

  const add = () => {
    const text = oneLine(draft)
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
        <Input value={draft} placeholder="添加待办" className="h-8" onChange={(event) => setDraft(oneLine(event.target.value))} />
        <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={!oneLine(draft)}>
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
              <TodoText text={item.text} done={item.done} onCommit={(value) => {
                setItems((current) => current.map((row) => (row.id === item.id ? { ...row, text: value } : row)))
              }} />
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
