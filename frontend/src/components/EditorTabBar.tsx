import { useState } from 'react'
import { ArrowRightToLine, Eye, FilePenLine, SquareTerminal, WrapText, X } from 'lucide-react'
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
import { isMarkdown } from './RemoteEditor'

const TOOL_BUTTON =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

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
  const [pending, setPending] = useState<EditorTab | null>(null)
  const [saving, setSaving] = useState(false)

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

  return (
    <>
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
              title={tab.path}
              className={cn(
                'flex h-7 max-w-52 min-w-0 shrink-0 items-center gap-1 rounded-md bg-muted/60 pl-2.5 pr-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent',
                active && 'bg-primary/15 text-primary hover:bg-primary/15'
              )}
            >
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => activateEditorTab(tab.key)}>
                <FileIcon name={tab.name} kind="file" />
                <span className={cn('truncate', tab.preview && 'italic')}>{tab.name}</span>
                {tab.readOnly && <Eye className="size-3 shrink-0 opacity-70" />}
                {tab.dirty && <span className="size-2 shrink-0 rounded-full bg-current" />}
              </button>
              <button
                type="button"
                title="关闭"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
                onClick={() => close(tab)}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      {activeTab && !(activeTab.readOnly && isMarkdown(activeTab.name)) && (
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
      {activeTab && (
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
    </>
  )
}
