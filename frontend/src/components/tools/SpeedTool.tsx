import { useEffect, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { SpeedReport } from '../../../../shared/types'
import { useAppStore } from '../../stores/useAppStore'

function errText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function formatMs(ms: number): string {
  if (ms < 0) return '—'
  if (ms < 10) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms)} ms`
}

function formatRate(bps: number): string {
  if (bps < 0) return '—'
  const mbps = (bps * 8) / 1e6
  if (mbps >= 100) return `${mbps.toFixed(0)} Mbps`
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`
  return `${Math.round((bps * 8) / 1e3)} Kbps`
}

function formatLoss(pct: number): string {
  if (pct < 0) return '—'
  return `${pct.toFixed(1)}%`
}

const fields: { key: 'latencyMs' | 'jitterMs' | 'downBps' | 'upBps' | 'lossPct'; label: string; format: (n: number) => string }[] = [
  { key: 'latencyMs', label: '延迟', format: formatMs },
  { key: 'jitterMs', label: '抖动', format: formatMs },
  { key: 'downBps', label: '下载', format: formatRate },
  { key: 'upBps', label: '上传', format: formatRate },
  { key: 'lossPct', label: '丢包', format: formatLoss }
]

/** 测速：本机到服务器，或服务器到外网。外网按出口地址走国内或国外节点。 */
const emptyReport = (kind: 'link' | 'egress'): SpeedReport => ({
  kind,
  latencyMs: -1,
  jitterMs: -1,
  downBps: -1,
  upBps: -1,
  lossPct: -1
})

function formatWhen(at?: number): string {
  if (!at) return ''
  const date = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function egressLabel(report: SpeedReport): string {
  if (report.route === 'cn') return '服务器到外网 · 国内'
  if (report.route === 'intl') return '服务器到外网 · 国外'
  return '服务器到外网'
}

type Kind = 'link' | 'egress'

type SpeedState = {
  sessionId: string
  link: SpeedReport
  egress: SpeedReport
  running: Kind | null
  phase: 'probe' | 'down' | 'up' | null
  ratio: number
}

let snapshot: SpeedState = {
  sessionId: '',
  link: emptyReport('link'),
  egress: emptyReport('egress'),
  running: null,
  phase: null,
  ratio: 0
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function patch(next: Partial<SpeedState>) {
  snapshot = { ...snapshot, ...next }
  listeners.forEach((listener) => listener())
}

function useSpeedState() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

async function run(kind: Kind) {
  const current = snapshot
  if (!current.sessionId || current.running) return
  const previous = kind === 'link' ? current.link : current.egress
  let settled = false
  patch({
    running: kind,
    phase: kind === 'link' ? 'down' : 'probe',
    ratio: 0,
    ...(kind === 'link' ? { link: emptyReport(kind) } : { egress: emptyReport(kind) })
  })
  const off = window.api.sessions.onSpeedProgress(current.sessionId, (tick) => {
    if (settled || snapshot.running !== kind) return
    const prev = kind === 'link' ? snapshot.link : snapshot.egress
    const filled = {
      ...prev,
      downBps: tick.downBps >= 0 ? tick.downBps : prev.downBps,
      upBps: tick.upBps >= 0 ? tick.upBps : prev.upBps
    }
    patch({
      phase: tick.phase,
      ratio: Math.max(0, Math.min(1, tick.ratio)),
      ...(kind === 'link' ? { link: filled } : { egress: filled })
    })
  })
  try {
    const result = await window.api.sessions.speed(current.sessionId, kind)
    settled = true
    patch(kind === 'link' ? { link: result, ratio: 1 } : { egress: result, ratio: 1 })
  } catch (e) {
    settled = true
    useAppStore.getState().setNotice(errText(e))
    patch(kind === 'link' ? { link: previous } : { egress: previous })
  } finally {
    off()
    patch({ running: null, phase: null })
  }
}

export function SpeedTool() {
  const sessions = useAppStore((s) => s.sessions)
  const { sessionId, link, egress, running, phase, ratio } = useSpeedState()

  useEffect(() => {
    if (sessionId && !sessions.some((s) => s.id === sessionId)) patch({ sessionId: '' })
  }, [sessions, sessionId])

  const rows: { kind: Kind; report: SpeedReport; label: string }[] = [
    { kind: 'link', report: link, label: '本机到服务器' },
    { kind: 'egress', report: egress, label: egressLabel(egress) }
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-center">
        <Select
          value={sessionId || undefined}
          onValueChange={(id) => {
            if (id === snapshot.sessionId || snapshot.running) return
            patch({ sessionId: id, link: emptyReport('link'), egress: emptyReport('egress'), ratio: 0, phase: null })
          }}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder={sessions.length === 0 ? '还没有主机' : '选择主机'} />
          </SelectTrigger>
          <SelectContent>
            {sessions.length === 0 ? (
              <SelectItem value="__empty" disabled>
                还没有主机
              </SelectItem>
            ) : (
              sessions.map((session) => (
                <SelectItem key={session.id} value={session.id}>
                  {session.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-8">
        {rows.map(({ kind, report, label }) => {
          const active = running === kind
          const when = formatWhen(report.at)
          const route = report.from && report.to ? `${report.from} -> ${report.to}` : ''
          return (
            <div key={kind} className="flex flex-col gap-3">
              <div className="grid grid-cols-[12.5rem_11.25rem_minmax(0,1fr)] items-center gap-x-3 text-sm text-muted-foreground">
                <Button
                  type="button"
                  size="sm"
                  variant={kind === 'link' ? 'default' : 'outline'}
                  className="h-8 w-full gap-1.5"
                  disabled={!sessionId || running !== null}
                  onClick={() => void run(kind)}
                >
                  {active && <RefreshCw className="size-3.5 animate-spin" />}
                  {label}
                </Button>
                <span className="whitespace-nowrap tabular-nums">{when}</span>
                <span className="truncate font-mono">{route}</span>
              </div>
              <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', !active && 'invisible')}>
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.round((active ? ratio : 0) * 100)}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {fields.map((field) => (
                  <div
                    key={field.key}
                    className={cn(
                      'rounded-lg border px-3 py-2 transition-colors',
                      active &&
                        ((phase === 'probe' && (field.key === 'latencyMs' || field.key === 'jitterMs' || field.key === 'lossPct')) ||
                          (phase === 'down' && field.key === 'downBps') ||
                          (phase === 'up' && field.key === 'upBps')) &&
                        'border-primary'
                    )}
                  >
                    <div className="text-xs text-muted-foreground">{field.label}</div>
                    <div className="mt-1 text-lg tabular-nums">{field.format(report[field.key])}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
