import { useEffect, useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SessionConfig, Tab } from '../../../../shared/types'
import { useAppStore } from '../../stores/useAppStore'
import { FileTree } from '../FileTree'
import type { ToolProps } from '../ToolsPage'

type Track = {
  key: string
  fromId: string
  toId: string
  fromName: string
  toName: string
  name?: string
  settled: boolean
}

type RelayMode = 'skip' | 'overwrite'

type Bound = { relayId?: string }

const sameName = '目标里已经有同名的文件或文件夹'

type Pending = {
  key: string
  from: { path: string; tree: string }
  toHost: string
  dir: string
  name: string
}

function baseName(path: string): string {
  const norm = path.replaceAll('\\', '/')
  const slash = norm.lastIndexOf('/')
  const name = slash >= 0 ? norm.slice(slash + 1) : norm
  return name || path
}

// 进度不跟组件走。切到别的标签会卸掉互传页，传输本身还在，回来要能对上。
const relayTracks: Track[] = []
const relayBound = new Map<string, Bound>()
const relayListeners = new Set<() => void>()

function updateTracks(updater: (list: Track[]) => Track[]) {
  const next = updater(relayTracks)
  if (next === relayTracks) return
  relayTracks.length = 0
  relayTracks.push(...next)
  relayListeners.forEach((notify) => notify())
}

function relayError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    ''
  )
  return raw || '传输失败'
}

const paneHost: Record<'left' | 'right', string> = { left: '', right: '' }

function usePane(side: 'left' | 'right') {
  const sessions = useAppStore((s) => s.sessions)
  const [hostId, setHostId] = useState(paneHost[side])
  const selectHost = (id: string) => {
    paneHost[side] = id
    setHostId(id)
  }
  const session = sessions.find((item) => item.id === hostId)
  const tab: Tab | null = session
    ? {
        id: `transfer-${side}`,
        sessionId: session.id,
        kind: 'ssh',
        title: session.name
      }
    : null
  return { sessions, hostId: session ? hostId : '', setHostId: selectHost, tab }
}

function HostSelect(props: {
  sessions: SessionConfig[]
  hostId: string
  onChange: (id: string) => void
}) {
  return (
    <Select value={props.hostId || undefined} onValueChange={props.onChange}>
      <SelectTrigger className="h-8 w-full text-sm">
        <SelectValue placeholder="选择主机" />
      </SelectTrigger>
      <SelectContent>
        {props.sessions.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name || `${item.username}@${item.host}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function sessionName(sessions: SessionConfig[], id: string): string {
  const item = sessions.find((session) => session.id === id)
  return item?.name || (item ? `${item.username}@${item.host}` : '')
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatEta(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** 左右各挂一棵文件树。拖到另一边时，经本机复制过去。进度在底部一行，标明方向。 */
export function TransferTool(props: ToolProps & { shown?: boolean }) {
  const left = usePane('left')
  const right = usePane('right')
  const setNotice = useAppStore((s) => s.setNotice)
  const dismissTransfer = useAppStore((s) => s.dismissSftpTransfer)
  const transfersBySession = useAppStore((s) => s.transfersBySession)
  const [tracks, setTracks] = useState<Track[]>(() => relayTracks.slice())
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    const sync = () => setTracks(relayTracks.slice())
    relayListeners.add(sync)
    return () => {
      relayListeners.delete(sync)
    }
  }, [])
  const hostOf = (tree: string) => (tree === 'transfer-left' ? left.hostId : right.hostId)
  const nameOf = (id: string) => sessionName(left.sessions, id)
  const dropTrack = (key: string) => {
    relayBound.delete(key)
    updateTracks((list) => list.filter((item) => item.key !== key))
  }
  const send = (from: { path: string; tree: string }, toHost: string, dir: string, mode?: RelayMode) => {
    const fromHost = hostOf(from.tree)
    if (!fromHost || !toHost) {
      setNotice('先选择两边的主机')
      return
    }
    const key = `${Date.now()}-${fromHost}-${toHost}`
    updateTracks((list) => [
      ...list,
      { key, fromId: fromHost, toId: toHost, fromName: nameOf(fromHost), toName: nameOf(toHost), settled: false }
    ])
    let asked = false
    void window.api.sftp
      .relay(fromHost, from.path, toHost, dir, mode)
      .catch((error) => {
        const msg = relayError(error)
        if (!mode && msg === sameName) {
          asked = true
          const name = baseName(from.path)
          updateTracks((list) => list.map((item) => (item.key === key ? { ...item, name } : item)))
          setPending({ key, from, toHost, dir, name })
          return
        }
        if (msg && msg !== '已取消') setNotice(msg)
      })
      .finally(() => {
        if (asked) return
        const slot = relayBound.get(key)
        if (!slot?.relayId) {
          dropTrack(key)
          return
        }
        updateTracks((list) => list.map((item) => (item.key === key ? { ...item, settled: true } : item)))
      })
  }
  useEffect(() => {
    updateTracks((list) => {
      const next = list.filter((track) => {
        if (!track.settled) return true
        const slot = relayBound.get(track.key)
        if (!slot?.relayId) return true
        const alive = (transfersBySession[track.toId] ?? []).some((item) => item.id === slot.relayId)
        if (!alive) {
          relayBound.delete(track.key)
          return false
        }
        return true
      })
      return next.length === list.length ? list : next
    })
  }, [transfersBySession])
  const claimed = new Set<string>()
  const rows = tracks.flatMap((track) => {
    const slot = relayBound.get(track.key) ?? {}
    const toList = transfersBySession[track.toId] ?? []
    if (!track.settled && !slot.relayId) {
      const found = toList.find((item) => item.direction === 'relay' && !claimed.has(item.id))
      if (found) slot.relayId = found.id
    }
    if (slot.relayId) claimed.add(slot.relayId)
    relayBound.set(track.key, slot)
    const current = toList.find((item) => item.id === slot.relayId)
    if (pending?.key === track.key) return [{ track, current }]
    if (track.settled && !current) return []
    return [{ track, current }]
  })
  const dismissAsk = () => {
    if (!pending) return
    dropTrack(pending.key)
    setPending(null)
  }
  const choose = (mode: RelayMode) => {
    if (!pending) return
    const next = pending
    dropTrack(next.key)
    setPending(null)
    send(next.from, next.toHost, next.dir, mode)
  }
  const progress = rows.map(({ track, current }) => {
        const percent =
          current && current.total > 0
            ? Math.min(100, Math.round((current.transferred / current.total) * 100))
            : current?.done
              ? 100
              : 0
        return (
          <div key={track.key} className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="flex shrink-0 items-center gap-1 text-foreground">
                {track.fromName}
                <ArrowRight className="size-3 text-muted-foreground" />
                {track.toName}
              </span>
              <span className="min-w-0 flex-1 truncate">{current?.name || track.name || ''}</span>
              {current?.error ? (
                <span className="shrink-0 text-destructive">{current.error}</span>
              ) : current?.done ? (
                <span className="shrink-0 text-primary">完成</span>
              ) : current ? (
                <span className="shrink-0 tabular-nums">
                  {formatSize(current.transferred)} / {formatSize(current.total)}
                  {current.speed > 0 &&
                    ` · ${formatSize(Math.round(current.speed))}/s · 剩余 ${formatEta((current.total - current.transferred) / current.speed)}`}
                </span>
              ) : (
                <span className="shrink-0">准备中</span>
              )}
              <button
                type="button"
                title={current?.done ? '关闭' : '取消传输'}
                className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10 hover:text-foreground"
                onClick={() => {
                  if (!current) return
                  if (current.done) dismissTransfer(current.sessionId, current.id)
                  else void window.api.sftp.cancelTransfer(current.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
            <div className="mt-1.5 h-0.5 rounded-full bg-foreground/10">
              <div
                className={`h-full rounded-full ${current?.error ? 'bg-destructive' : current?.done ? 'bg-primary' : 'bg-foreground/40'}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )
      })
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex">
        <div className="min-w-0 flex-1 px-3 pt-3 pb-2">
          <HostSelect sessions={left.sessions} hostId={left.hostId} onChange={left.setHostId} />
        </div>
        <div className="min-w-0 flex-1 px-3 pt-3 pb-2">
          <HostSelect sessions={right.sessions} hostId={right.hostId} onChange={right.setHostId} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          <FileTree
            tab={left.tab}
            detached
            shown={props.shown}
            onForeignDrop={(from, dir) => send(from, left.hostId, dir)}
          />
        </div>
        <div className="mb-4 mt-1 w-0.5 shrink-0 bg-foreground/40" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          <FileTree
            tab={right.tab}
            detached
            shown={props.shown}
            onForeignDrop={(from, dir) => send(from, right.hostId, dir)}
          />
        </div>
      </div>
      {progress}
      {pending && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-3"
          onClick={dismissAsk}
        >
          <div
            className="h-fit w-full max-w-sm rounded-xl border bg-card shadow-lg shadow-black/30"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between rounded-t-xl border-b bg-muted-foreground/10 px-3 py-2">
              <p className="text-[13px] font-medium text-muted-foreground">已有同名</p>
              <button
                type="button"
                title="关闭"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                onClick={dismissAsk}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="grid gap-3 p-3">
              <p className="text-sm break-all text-muted-foreground">{pending.name}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => choose('skip')}>
                  跳过
                </Button>
                <Button onClick={() => choose('overwrite')}>
                  覆盖
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
