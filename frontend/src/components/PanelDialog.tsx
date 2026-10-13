import { useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 右键菜单关掉之后再打开，避免弹层立刻被收掉。 */
export function openAfterMenu(open: () => void): void {
  window.setTimeout(open, 0)
}

/**
 * 右键菜单里打开弹层/原地重命名的配套：菜单项 onClick 调 openFromMenu，
 * ContextMenuContent 的 onCloseAutoFocus 挂 keepFocusOnClose —— 菜单关闭时阻止 Radix
 * 把焦点还给列表项，否则紧接着打开的输入框会被顶得失焦。文件树的弹层和标签栏的
 * 原地重命名共用这一套。
 */
export function useMenuAction(): {
  keepFocusOnClose: (e: Event) => void
  openFromMenu: (open: () => void) => void
} {
  const afterMenu = useRef(false)
  return {
    keepFocusOnClose: (e) => {
      if (afterMenu.current) {
        afterMenu.current = false
        e.preventDefault()
      }
    },
    openFromMenu: (open) => {
      afterMenu.current = true
      openAfterMenu(open)
    }
  }
}

/**
 * 面板局部弹层：只盖住右侧面板，不锁全屏、不抢焦点，终端主界面照常可用。
 * 文件树的重命名 / 新建文件夹用它；终端标签的重命名在标签上原地改，不走弹层。
 */
export function PanelDialog(props: {
  open: boolean
  title: string
  initial: string
  placeholder: string
  error?: string
  onClose: () => void
  onSave: (value: string) => void
}) {
  if (!props.open) return null
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3"
      onClick={props.onClose}
    >
      <PanelForm
        key={props.initial}
        title={props.title}
        initial={props.initial}
        placeholder={props.placeholder}
        error={props.error}
        onClose={props.onClose}
        onSave={props.onSave}
      />
    </div>
  )
}

/** 和 PanelDialog 同一个外观的确认弹层，删除这类不可撤销的操作用。Enter 确认，Esc 取消。 */
export function PanelConfirm(props: {
  open: boolean
  title: string
  message: string
  confirmText?: string
  error?: string
  onClose: () => void
  onConfirm: () => void
}) {
  if (!props.open) return null
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3"
      onClick={props.onClose}
    >
      <PanelCard title={props.title} onClose={props.onClose}>
        <p className="text-sm break-all text-muted-foreground">{props.message}</p>
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button
            autoFocus
            onClick={props.onConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Escape') props.onClose()
            }}
          >
            {props.confirmText ?? '删除'}
          </Button>
        </div>
      </PanelCard>
    </div>
  )
}

function PanelCard(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="h-fit w-full rounded-xl border bg-card shadow-lg shadow-black/30"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between rounded-t-xl border-b bg-muted-foreground/10 px-3 py-2">
        <p className="text-[13px] font-medium text-muted-foreground">{props.title}</p>
        <button
          type="button"
          title="关闭"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
          onClick={props.onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid gap-3 p-3">{props.children}</div>
    </div>
  )
}

function PanelForm(props: {
  title: string
  initial: string
  placeholder: string
  error?: string
  onClose: () => void
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(props.initial)

  const save = () => props.onSave(value)

  return (
    <PanelCard title={props.title} onClose={props.onClose}>
        {/* 不用共享 Input：弹窗的输入框只要描边不要填充底，自带样式避免覆盖顺序问题 */}
        <input
          autoFocus
          className="h-10 w-full rounded-lg border border-muted-foreground/25 bg-transparent px-2.5 text-sm text-muted-foreground transition-colors outline-none selection:bg-primary/25 selection:text-primary placeholder:text-muted-foreground/60 focus-visible:border-ring"
          spellCheck={false}
          autoComplete="off"
          value={value}
          placeholder={props.placeholder}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') props.onClose()
          }}
        />
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        <div className="flex justify-end">
          <Button onClick={save}>保存</Button>
        </div>
    </PanelCard>
  )
}
