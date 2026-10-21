import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ServerMetrics } from '../../../shared/types'
import { newTermId } from '../../../shared/ids'
import { cn } from '@/lib/utils'
import { terminalPool } from '../terminal/TerminalPool'
import { useAppStore } from '../stores/useAppStore'

/** 字节 → GiB/MiB 简短文本 */
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`
  return `${n} B`
}

/** RSS 字节 → 进程表里惯用的 MB/G */
function formatRss(bytes: number): string {
  const mb = bytes / 1024 ** 2
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`
}

/** 秒 → 「3天 5小时」式时长，只保留最大两档 */
function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分钟`
  return `${minutes}分钟`
}

/** 运维面板：在共享 SSH 连接上轮询采集，只支持 Linux。 */
export function OpsPanel() {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.sessionId ?? null

  const [metrics, setMetrics] = useState<ServerMetrics | null>(null)
  const [error, setError] = useState('')
  // 上一次采集没回来就不发下一次，避免请求在慢链路上叠起来
  const inFlight = useRef(false)
  // 静态身份（主机名/系统/内核/IP）走 store 缓存：同一会话 10 分钟内只采一次
  const loadServerInfo = useAppStore((s) => s.loadServerInfo)
  const serverInfo = useAppStore((s) => (sessionId ? s.serverInfoBySession[sessionId]?.info : undefined))
  // 终端是主角，吃剩余空间；左栏信息区固定宽度，默认就是最窄宽度，用分隔条加宽
  const [leftWidth, setLeftWidth] = useState(520)
  const containerRef = useRef<HTMLDivElement>(null)

  // 按住分隔条左右拖：左栏在 520 ~（容器宽 - 240，给终端保底）之间调整
  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = leftWidth
    const maxLeft = (containerRef.current?.clientWidth ?? 1440) - 240
    const onMove = (ev: PointerEvent) => {
      setLeftWidth(Math.min(maxLeft, Math.max(520, startWidth + (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    const collect = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const m = await window.api.sessions.metrics(sessionId)
        if (stopped) return
        setMetrics(m)
        setError('')
      } catch (e) {
        // 采集失败保留上一次成功的数据，只提示一句
        if (!stopped) setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
      }
    }
    void collect()
    const timer = window.setInterval(() => void collect(), 3000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId) loadServerInfo(sessionId)
  }, [sessionId, loadServerInfo])

  if (!sessionId) {
    return <div className="flex min-h-0 flex-1" />
  }

  const memUsed = metrics ? metrics.memTotal - metrics.memAvail : 0
  const memPercent = metrics && metrics.memTotal > 0 ? (memUsed / metrics.memTotal) * 100 : 0
  const rootDisk = metrics?.disks.find((d) => d.mount === '/') ?? metrics?.disks[0] ?? null
  const loadPercent = metrics && metrics.cores > 0 ? (metrics.load1 / metrics.cores) * 100 : 0

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      {/* 左栏是给人读的信息，允许选中复制；右栏终端的选择归 xterm 管 */}
      <div
        className="flex shrink-0 flex-col gap-4 overflow-hidden p-4 select-text"
        style={{ width: leftWidth }}
      >
        {metrics ? (
          <div className="flex flex-col gap-0.5 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
              <InfoItem label="主机名" value={serverInfo?.hostname ?? '…'} />
              <InfoItem label="系统" value={serverInfo?.osPretty ?? '…'} />
              <InfoItem label="内核" value={serverInfo?.kernel ?? '…'} />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
              {metrics.uptimeSec > 0 && <InfoItem label="已运行" value={formatUptime(metrics.uptimeSec)} />}
              <InfoItem label="内网" value={serverInfo ? serverInfo.lanIps.join(' ') || '—' : '…'} />
              <InfoItem label="外网" value={serverInfo ? serverInfo.wanIp || '—' : '…'} />
            </div>
          </div>
        ) : (
          !error && <div className="text-xs text-muted-foreground">正在采集…</div>
        )}
        {error && <p className="text-xs text-destructive">采集失败：{error}</p>}

        {metrics && (
          <>
            <div className="flex items-start gap-6 px-1">
              <Ring label="CPU" percent={metrics.cpuPercent} center={`${metrics.cpuPercent.toFixed(0)}%`}>
                <div>使用率 {metrics.cpuPercent.toFixed(1)}%</div>
                <div className="text-muted-foreground">{metrics.cores} 核</div>
              </Ring>
              <Ring label="内存" percent={memPercent} center={`${memPercent.toFixed(0)}%`}>
                <div>
                  {formatBytes(memUsed)} / {formatBytes(metrics.memTotal)}
                </div>
                <div className="text-muted-foreground">已用 {memPercent.toFixed(1)}%</div>
              </Ring>
              <Ring
                label={rootDisk ? `磁盘 ${rootDisk.mount}` : '磁盘'}
                percent={rootDisk?.usePercent ?? 0}
                center={rootDisk ? `${rootDisk.usePercent.toFixed(0)}%` : '—'}
              >
                {rootDisk ? (
                  <>
                    <div>
                      {formatBytes(rootDisk.used)} / {formatBytes(rootDisk.total)}
                    </div>
                    <div className="text-muted-foreground">挂载点 {rootDisk.mount} · 已用 {rootDisk.usePercent.toFixed(1)}%</div>
                  </>
                ) : (
                  <div className="text-muted-foreground">没有采集到</div>
                )}
              </Ring>
              <Ring label="负载" percent={loadPercent} center={metrics.load1.toFixed(2)}>
                <div>
                  {metrics.load1.toFixed(2)} · {metrics.load5.toFixed(2)} · {metrics.load15.toFixed(2)}
                </div>
                <div className="text-muted-foreground">1 / 5 / 15 分钟 · {metrics.cores} 核</div>
              </Ring>
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
              {/* 定宽列给死窄宽度，剩下的全给命令列，长命令能多看一截 */}
              <table className="w-full table-fixed text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-muted-foreground">
                    <th className="w-20 px-3 py-2 text-right font-medium">PID</th>
                    <th className="w-20 px-3 py-2 text-left font-medium">USER</th>
                    <th className="w-16 px-3 py-2 text-right font-medium">%CPU</th>
                    <th className="w-16 px-3 py-2 text-right font-medium">%MEM</th>
                    <th className="w-16 px-3 py-2 text-right font-medium">RSS</th>
                    <th className="px-3 py-2 text-left font-medium">命令</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.procs.map((p) => (
                    <tr key={p.pid} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.pid}</td>
                      <td className="max-w-24 truncate px-3 py-1.5">{p.user}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.cpu.toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.mem.toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatRss(p.rss)}</td>
                      <td className="max-w-0 truncate px-3 py-1.5 text-muted-foreground" title={p.cmd}>
                        {p.cmd}
                      </td>
                    </tr>
                  ))}
                  {metrics.procs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        没有采集到进程
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {/* 分隔条：按住左右拖，调整右侧终端栏宽度 */}
      <div
        className="w-1 shrink-0 cursor-col-resize bg-border transition-colors select-none hover:bg-primary/40 active:bg-primary/60"
        onPointerDown={startDrag}
      />
      {/* 右侧命令区：同一台服务器再开一路真终端，面板关掉就断开销毁 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <OpsTerminal sessionId={sessionId} />
      </div>
    </div>
  )
}

/** 面板右侧的终端：挂载时在同一 SSH 会话上开一路新终端，卸载时断开销毁。 */
function OpsTerminal(props: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [termId] = useState(() => newTermId())

  useEffect(() => {
    const el = ref.current
    if (!el) return
    window.api.term.create({
      termId,
      kind: 'ssh',
      sessionId: props.sessionId,
      title: '面板终端',
      cols: 80,
      rows: 24
    })
    terminalPool.attach(termId, el)

    // 宽度会随窗口调整连续变化，等停稳再 fit，避免每一帧都重排终端
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => terminalPool.fit(termId), 120)
    })
    ro.observe(el)

    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      terminalPool.detach(termId)
      window.api.term.close(termId)
      terminalPool.dispose(termId)
    }
  }, [termId, props.sessionId])

  return <div ref={ref} className="min-h-0 flex-1 p-1" style={{ background: 'var(--terminal-background)' }} />
}

/** 信息条一项：弱色标签 + 值。值为空不渲染。 */
function InfoItem(props: { label: string; value: string }) {
  if (!props.value) return null
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground/60">{props.label} </span>
      <span className="text-muted-foreground">{props.value}</span>
    </span>
  )
}

/** 环形进度：圆环弧度=百分比，中间放数值，≥85% 变红。hover 弹出细节浮层。 */function Ring(props: { label: string; percent: number; center: string; children: ReactNode }) {
  const hot = props.percent >= 85
  const r = 26
  const c = 2 * Math.PI * r
  const filled = (Math.min(100, Math.max(0, props.percent)) / 100) * c
  return (
    <div className="group relative">
      <div className="flex flex-col items-center gap-1 py-1">
        <div className="relative size-16">
          <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
            <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-accent" />
            <circle
              cx="32"
              cy="32"
              r={r}
              fill="none"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${c}`}
              className={hot ? 'stroke-destructive' : 'stroke-primary'}
            />
          </svg>
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums',
              hot && 'text-destructive'
            )}
          >
            {props.center}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{props.label}</div>
      </div>
      <div className="invisible absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-xs whitespace-nowrap shadow-md group-hover:visible">
        {props.children}
      </div>
    </div>
  )
}
