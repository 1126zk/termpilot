import { useEffect, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { NetworkReport } from '../../../../shared/types'
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

function formatRange(report: NetworkReport | null): string {
  if (!report || report.latencyMinMs < 0 || report.latencyMaxMs < 0) return '—'
  return `${formatMs(report.latencyMinMs)}～${formatMs(report.latencyMaxMs)}`
}

function formatSampleRetrans(report: NetworkReport | null, compact = false): string {
  if (!report) return '—'
  if (report.sampleSegments === 0) return '无新数据'
  const pct = (report.sampleRetrans * 100) / report.sampleSegments
  const counts = `${report.sampleRetrans}/${report.sampleSegments}`
  return compact ? `${counts}（${pct.toFixed(1)}%）` : `${counts} 段（${pct.toFixed(1)}%）`
}

function formatTotalRetrans(report: NetworkReport | null, compact = false): string {
  if (!report || report.totalSegments === 0) return '—'
  const pct = (report.totalRetrans * 100) / report.totalSegments
  const counts = `${report.totalRetrans}/${report.totalSegments}`
  return compact ? `${counts}（${pct.toFixed(1)}%）` : `${counts} 段（${pct.toFixed(1)}%）`
}

function formatWhen(at?: number): string {
  if (!at) return ''
  const date = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function formatTime(at: number): string {
  const date = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

type Tone = 'good' | 'warn' | 'bad' | 'unknown'
type Assessment = { label: string; reason: string; tone: Tone }

function assess(report: NetworkReport | null): Assessment {
  if (!report || report.latencyMs < 0) {
    return { label: '无法完整判断', reason: '没有采到有效的延迟数据', tone: 'unknown' }
  }
  const severe: string[] = []
  const caution: string[] = []
  const min = report.latencyMinMs >= 0 ? report.latencyMinMs : report.latencyMs
  const max = report.latencyMaxMs >= 0 ? report.latencyMaxMs : report.latencyMs
  const spread = Math.max(0, max - min)
  if (min >= 250 || report.latencyMs >= 400) severe.push(`延迟高（当前 ${formatMs(report.latencyMs)}）`)
  else if (min >= 120 || report.latencyMs >= 250) caution.push(`延迟偏高（当前 ${formatMs(report.latencyMs)}）`)
  if (report.jitterMs >= 100 || spread >= 300) severe.push(`延迟波动大（${formatMs(report.jitterMs)}）`)
  else if (report.jitterMs >= 30 || spread >= 80) caution.push(`延迟有波动（${formatMs(report.jitterMs)}）`)

  const retransRate = report.sampleSegments > 0 ? report.sampleRetrans / report.sampleSegments : 0
  const severeRetrans =
    (report.sampleRetrans >= 2 && retransRate >= 0.1) || (report.sampleRetrans >= 3 && retransRate >= 0.05)
  if (severeRetrans) {
    severe.push(`本次重传严重（${formatSampleRetrans(report)}），可能存在丢包或拥塞`)
  } else if (report.sampleRetrans > 0) {
    caution.push(`本次出现重传（${formatSampleRetrans(report)}）`)
  }

  if (severe.length > 0) {
    return { label: '卡', reason: [...severe, ...caution].join('；'), tone: 'bad' }
  }
  if (caution.length > 0) {
    return { label: '可能卡', reason: caution.join('；'), tone: 'warn' }
  }
  if (report.sampleSegments === 0) {
    return { label: '无法完整判断', reason: '延迟和波动正常，但本次没有新数据，无法判断当前重传', tone: 'unknown' }
  }
  return { label: '不卡', reason: '延迟低且稳定，本次没有重传', tone: 'good' }
}

const toneText: Record<Tone, string> = {
  good: 'text-primary',
  warn: 'text-amber-500',
  bad: 'text-destructive',
  unknown: 'text-muted-foreground'
}

const toneBox: Record<Tone, string> = {
  good: 'border-primary/30 bg-primary/5',
  warn: 'border-amber-500/30 bg-amber-500/5',
  bad: 'border-destructive/40 bg-destructive/5',
  unknown: 'bg-muted/20'
}

const columns = [
  { label: '时间', help: '本次检测完成的时间' },
  { label: '延迟', help: '最近一次采样的往返延迟（RTT），由服务器 TCP 内核平滑计算' },
  { label: '采样范围', help: '本次约 10 秒采样中，RTT 的最低值和最高值' },
  { label: '延迟波动', help: 'TCP 内核维护的 RTT 平均偏差，越大表示延迟越不稳定' },
  { label: '采样期重传', help: '本次检测新增的重传数据段 / 新增发送数据段；无新数据时不能判断当前重传' },
  { label: '历史最低', help: '这条连接建立以来观察到的最低 RTT' },
  { label: '累计重传', help: '这条连接建立以来的累计重传数据段 / 累计发送数据段，只作历史参考' },
  { label: '结论', help: '根据本次延迟、波动和重传分别判断；重传不等同于物理链路丢包' }
]

function HeaderCell({ label, help }: { label: string; help: string }) {
  return (
    <th scope="col" className="px-2 py-2 font-medium">
      <Tooltip delayDuration={1000}>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="outline-none">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" sideOffset={4} className="w-max max-w-none whitespace-nowrap">
          {help}
        </TooltipContent>
      </Tooltip>
    </th>
  )
}

type NetworkState = {
  sessionId: string
  report: NetworkReport | null
  histories: Record<string, NetworkReport[]>
  running: boolean
  ratio: number
}

let snapshot: NetworkState = {
  sessionId: '',
  report: null,
  histories: {},
  running: false,
  ratio: 0
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function patch(next: Partial<NetworkState>) {
  snapshot = { ...snapshot, ...next }
  listeners.forEach((listener) => listener())
}

function useNetworkState() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

async function run() {
  const current = snapshot
  if (!current.sessionId || current.running) return
  let settled = false
  patch({ running: true, ratio: 0, report: null })
  const off = window.api.sessions.onNetworkProgress(current.sessionId, (tick) => {
    if (settled || !snapshot.running) return
    patch({ report: tick.report, ratio: Math.max(0, Math.min(1, tick.ratio)) })
  })
  try {
    const result = await window.api.sessions.network(current.sessionId)
    settled = true
    const history = snapshot.histories[current.sessionId] ?? []
    patch({
      report: result,
      ratio: 1,
      histories: { ...snapshot.histories, [current.sessionId]: [result, ...history] }
    })
  } catch (e) {
    settled = true
    useAppStore.getState().setNotice(errText(e))
    patch({ report: null })
  } finally {
    off()
    patch({ running: false })
  }
}

export function NetworkTool() {
  const sessions = useAppStore((s) => s.sessions)
  const { sessionId, report, histories, running, ratio } = useNetworkState()

  useEffect(() => {
    if (sessionId && !sessions.some((s) => s.id === sessionId)) patch({ sessionId: '', report: null })
  }, [sessions, sessionId])

  const history = histories[sessionId] ?? []
  const shown = report ?? history[0] ?? null
  const assessment = assess(shown)
  const when = formatWhen(shown?.at)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Select
          value={sessionId || undefined}
          onValueChange={(id) => {
            if (id === snapshot.sessionId || snapshot.running) return
            patch({ sessionId: id, report: null, ratio: 0 })
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
        <span className="flex-1 text-center text-sm whitespace-nowrap tabular-nums text-muted-foreground">{when}</span>
        <Button
          type="button"
          size="sm"
          className="h-8 w-48 shrink-0 gap-1.5"
          disabled={!sessionId || running}
          onClick={() => void run()}
        >
          {running && <RefreshCw className="size-3.5 animate-spin" />}
          本机到服务器
        </Button>
      </div>
        <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', !running && 'invisible')}>
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round((running ? ratio : 0) * 100)}%` }}
          />
        </div>
        {shown && (
          <div className={cn('rounded-lg border px-4 py-3', toneBox[assessment.tone])}>
            <div className={cn('text-lg font-medium', toneText[assessment.tone])}>{assessment.label}</div>
            <div className="mt-1 text-sm text-muted-foreground">{assessment.reason}</div>
          </div>
        )}
        {history.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  {columns.map((column) => (
                    <HeaderCell key={column.label} {...column} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((item) => {
                  const result = assess(item)
                  return (
                    <tr key={item.at} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatTime(item.at)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatMs(item.latencyMs)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatRange(item)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatMs(item.jitterMs)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatSampleRetrans(item, true)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatMs(item.baseLatencyMs)}</td>
                      <td className="px-2 py-2 whitespace-nowrap tabular-nums">{formatTotalRetrans(item, true)}</td>
                      <td className={cn('px-2 py-2 whitespace-nowrap font-medium', toneText[result.tone])}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0} className="cursor-help outline-none">
                              {result.label}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={4} className="w-max max-w-none whitespace-nowrap">
                            {result.reason}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
