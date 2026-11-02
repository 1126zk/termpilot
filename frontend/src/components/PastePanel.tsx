import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardPaste, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useAppStore } from '../stores/useAppStore'
import { isImage } from './RemoteEditor'
import { TREE_PATH_MIME } from '../terminal/dropPath'
import { onPasteSaved, PASTE_DIR, uploadPasteImage } from '../terminal/pasteImage'
import type { RemoteFile } from '../../../shared/types'

/** 缩略图缓存：同一张图（路径 + 修改时间）只拉一次 */
const thumbCache = new Map<string, string>()

function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

/**
 * 剪贴板图片：在这一栏按 Ctrl+V 把图片传到服务器 ~/.termpilot/paste，下面列出传过的图。
 * 单击用图片查看器打开，拖到终端填入服务器上的绝对路径（给 Kimi、Claude Code 这类工具读）。
 * 只管 SSH 标签；本机终端里的工具自己能读剪贴板。
 */
export function PastePanel() {
  const tab = useAppStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const openRemoteEditor = useAppStore((s) => s.openRemoteEditor)
  const setNotice = useAppStore((s) => s.setNotice)
  const sessionId = tab?.kind === 'ssh' ? tab.sessionId : null
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // 打开时和上传后各列一次目录，慢的那次后回来不能把新列表盖掉，只认最后一次
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    if (!sessionId) return setFiles([])
    setLoading(true)
    try {
      const listed = await window.api.sftp.list(sessionId, PASTE_DIR)
      if (seq !== loadSeq.current) return
      setFiles(listed.entries.filter((f) => f.kind === 'file' && isImage(f.name)).sort((a, b) => b.mtime - a.mtime))
    } catch {
      // 还没传过图时目录不存在，当空列表
      if (seq === loadSeq.current) setFiles([])
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => void load(), [load])
  // 终端里按 Alt+V 传了图，这一栏开着就跟着刷新
  useEffect(() => onPasteSaved((id) => id === sessionId && void load()), [load, sessionId])
  // 打开这一栏时把焦点放进来，直接按 Ctrl+V 就能传。只在打开时抢一次，
  // 切标签、点分屏另一栏时不能把终端的焦点抢走
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const onPaste = async (event: React.ClipboardEvent) => {
    if (!sessionId || uploading) return
    const item = [...event.clipboardData.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))
    const blob = item?.getAsFile()
    if (!item || !blob) {
      setNotice('剪贴板里没有图片')
      return
    }
    event.preventDefault()
    setUploading(true)
    setNotice('正在上传图片…', true)
    try {
      const path = await uploadPasteImage(sessionId, blob, item.type, files.map((f) => f.name))
      setNotice(`已上传：${path}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  // 粘贴的图本来就是临时文件，点叉或清空都直接删，不再确认
  const remove = async (file: RemoteFile) => {
    if (!sessionId) return
    try {
      await window.api.sftp.remove(sessionId, file.path, 'file')
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const clearAll = async () => {
    if (!sessionId || files.length === 0 || clearing) return
    setClearing(true)
    try {
      const results = await Promise.allSettled(
        files.map((file) => window.api.sftp.remove(sessionId, file.path, 'file'))
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      await load()
      setNotice(failed ? `${failed} 张图片删除失败` : '已清理所有图片')
    } finally {
      setClearing(false)
    }
  }

  if (!tab || !sessionId) {
    return (
      <p className="px-3 py-6 text-center text-sm leading-5 text-muted-foreground">
        {tab ? '本机终端请直接用 Alt+V 粘贴图片' : '打开一个 SSH 终端后可以粘贴图片'}
      </p>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className="group/paste flex min-h-0 flex-1 flex-col outline-none"
      onPaste={(e) => void onPaste(e)}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div
          className={cn(
            'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-dashed px-2 text-sm text-muted-foreground',
            'group-focus-within/paste:border-primary/60 group-focus-within/paste:text-foreground'
          )}
        >
          <ClipboardPaste className="size-3.5 shrink-0" />
          {!uploading && (
            <span className="hidden size-1.5 shrink-0 rounded-full bg-primary group-focus-within/paste:block" />
          )}
          {uploading ? (
            <span className="truncate">正在上传…</span>
          ) : (
            <>
              <span className="truncate group-focus-within/paste:hidden">点击面板后按 Ctrl+V 粘贴图片</span>
              <span className="hidden truncate group-focus-within/paste:inline">面板已激活，按 Ctrl+V 粘贴图片</span>
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          title="刷新"
          disabled={loading || clearing}
          onClick={() => void load()}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          title={clearing ? '正在清理…' : '清理所有图片'}
          disabled={files.length === 0 || clearing}
          onClick={() => void clearAll()}
        >
          <Trash2 className={cn('size-3.5', clearing && 'animate-pulse')} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {files.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm leading-5 text-muted-foreground">
            {loading ? '正在读取…' : '传过的图片会列在这里，拖到终端就填入路径'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 px-2 pb-2">
            {files.map((file) => (
              <div key={file.path} className="group relative">
                <button
                  type="button"
                  draggable
                  title={`${file.path}\n单击查看，拖到终端填入路径`}
                  className="grid w-full gap-1 rounded-md p-1 text-left hover:bg-muted-foreground/10"
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TREE_PATH_MIME, JSON.stringify({ path: file.path, local: false }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => openRemoteEditor(tab.id, sessionId, { path: file.path, name: file.name })}
                >
                  <Thumb sessionId={sessionId} file={file} />
                  <span className="truncate text-xs text-muted-foreground group-hover:text-foreground">{file.name}</span>
                </button>
                <button
                  type="button"
                  title="删除"
                  className="invisible absolute top-2 right-2 flex size-5 items-center justify-center rounded bg-background/80 text-muted-foreground hover:text-destructive group-hover:visible"
                  onClick={() => void remove(file)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function Thumb(props: { sessionId: string; file: RemoteFile }) {
  const key = `${props.sessionId}:${props.file.path}:${props.file.mtime}`
  const [src, setSrc] = useState(() => thumbCache.get(key) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (thumbCache.has(key)) return setSrc(thumbCache.get(key)!)
    let alive = true
    window.api.sftp
      .readImage(props.sessionId, props.file.path)
      .then((base64) => {
        const url = `data:${mimeOf(props.file.name)};base64,${base64}`
        thumbCache.set(key, url)
        if (alive) setSrc(url)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [key, props.sessionId, props.file.path, props.file.name])

  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-muted">
      {src ? (
        // 拖的是外面的按钮，图片本身不单独拖
        <img src={src} alt={props.file.name} draggable={false} className="size-full object-contain" />
      ) : (
        <span className="text-xs text-muted-foreground">{failed ? '读不出来' : '…'}</span>
      )}
    </div>
  )
}
