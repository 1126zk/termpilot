import { useEffect, useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../stores/useAppStore'
import { captureTerminalView, type CaptureDone } from '../terminal/captureView'
import { normalizeTerminalCopy, terminalPool } from '../terminal/TerminalPool'
import { CaptureDialog } from './CaptureDialog'
import { cn } from '@/lib/utils'
import { DROP_TARGET_STYLE } from '../fileDrop'
import { insertPaths, TREE_PATH_MIME } from '../terminal/dropPath'

/** 终端视图只提供挂载容器；标签切换时组件保活，xterm 不重挂、缓冲不丢。 */
export function TerminalView(props: { termId: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const setNotice = useAppStore((s) => s.setNotice)
  const reconnectTab = useAppStore((s) => s.reconnectTab)
  const status = useAppStore((s) => s.termState[props.termId]?.status)
  const disconnected = status === 'disconnected' || status === 'error'
  const [selection, setSelection] = useState<{ text: string; startLine: number; endLine: number } | null>(null)
  const [shot, setShot] = useState<CaptureDone | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    terminalPool.attach(props.termId, el)

    // 侧边栏收起时宽度会连续变化。等停稳再 fit，避免每一帧都重排终端。
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => terminalPool.fit(props.termId), 120)
    })
    ro.observe(el)

    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      terminalPool.detach(props.termId)
    }
  }, [props.termId])

  useEffect(() => {
    const el = ref.current
    if (!props.active || !el) return
    const frame = requestAnimationFrame(() => {
      terminalPool.attach(props.termId, el)
      terminalPool.focus(props.termId)
    })
    return () => cancelAnimationFrame(frame)
  }, [props.active, props.termId])

  const copy = async () => {
    const text = selection?.text
    if (!text) return
    try {
      await navigator.clipboard.writeText(normalizeTerminalCopy(text))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  // 复制 AI 回复里的命令：去掉缩进，被程序按窗口宽度折开的长命令接回一行，\ 续行和多条命令照旧
  const copyCommand = async () => {
    const text = terminalPool.selectionAsCommand(props.termId)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  // 截图：选区裁剪（右键菜单「截取选区」）
  const shoot = () => {
    if (!selection) return
    const range = selection
    setShotError(null)
    setNotice('正在截图…')
    void (async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      try {
        const done = await captureTerminalView({
          termId: props.termId,
          mode: 'scrollback',
          startLine: range.startLine,
          endLine: range.endLine,
          cropOnly: true
        })
        setNotice(null)
        setShot(done)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message)
        setShotError(message)
      }
    })()
  }

  // 整屏截图：当前画面 / 整个滚动缓冲（顶栏的两个按钮撤了，挪进右键菜单）
  const capture = (mode: 'viewport' | 'scrollback') => {
    setShotError(null)
    setNotice('正在截图…')
    void (async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      try {
        const done = await captureTerminalView({ termId: props.termId, mode })
        setNotice(null)
        setShot(done)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message)
        setShotError(message)
      }
    })()
  }

  const paste = async () => {
    try {
      terminalPool.paste(props.termId, await navigator.clipboard.readText())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            className={cn('relative min-h-0 flex-1 px-3 py-1', dragging && 'ring-2 ring-primary/60 ring-inset')}
            style={{ ...DROP_TARGET_STYLE, background: 'var(--terminal-background)' }}
            data-drop-term={props.termId}
            onContextMenu={() => setSelection(terminalPool.selectionRange(props.termId))}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TREE_PATH_MIME)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
            }}
            onDrop={(e) => {
              setDragging(false)
              const raw = e.dataTransfer.getData(TREE_PATH_MIME)
              if (!raw) return
              e.preventDefault()
              const tab = useAppStore.getState().tabs.find((t) => t.id === props.termId)
              try {
                const item = JSON.parse(raw) as { path: string; local: boolean }
                if (tab) insertPaths(tab, [item.path], item.local)
              } catch {
                /* 不是文件树拖出来的 */
              }
            }}
          >
            {disconnected && (
              <Button className="absolute top-3 right-3 z-10" size="sm" onClick={() => reconnectTab(props.termId)}>
                重新连接
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!selection?.text} onClick={() => void copy()}>
            复制
            <ContextMenuShortcut>{window.api.platform === 'darwin' ? '⌘C' : 'Ctrl+C'}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!selection?.text} onClick={() => void copyCommand()}>
            复制命令
          </ContextMenuItem>
          <ContextMenuItem disabled={!selection} onClick={shoot}>
            截取选区
          </ContextMenuItem>
          <ContextMenuItem onClick={() => capture('viewport')}>截取当前画面</ContextMenuItem>
          <ContextMenuItem onClick={() => capture('scrollback')}>截取滚动缓冲</ContextMenuItem>
          <ContextMenuItem onClick={() => void paste()}>
            粘贴
            <ContextMenuShortcut>{window.api.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <CaptureDialog
        shot={shot}
        error={shotError}
        onClose={() => {
          setShot(null)
          setShotError(null)
        }}
      />
    </>
  )
}
