import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { MoreHorizontal, RefreshCw, X } from 'lucide-react'
import type { DockerInfo, ProcInfo, ServerMetrics } from '../../../shared/types'
import { newTermId } from '../../../shared/ids'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
  const setNotice = useAppStore((s) => s.setNotice)
  // 两个榜各先显示 5 个，可展开到 10 个
  const [cpuShown, setCpuShown] = useState(5)
  const [memShown, setMemShown] = useState(5)
  // 杀进程两步确认：第一次点进入确认态，3 秒不点第二次就恢复
  const [confirmKill, setConfirmKill] = useState<number | null>(null)
  // 内容区选项卡：进程 / Docker，以后再加
  const [opsTab, setOpsTab] = useState<'proc' | 'docker'>('proc')

  const killProc = (pid: number) => {
    if (confirmKill !== pid) {
      setConfirmKill(pid)
      window.setTimeout(() => setConfirmKill((cur) => (cur === pid ? null : cur)), 3000)
      return
    }
    setConfirmKill(null)
    if (!sessionId) return
    void window.api.sessions.killProc(sessionId, pid).catch((e) => {
      setNotice(e instanceof Error ? e.message : String(e))
    })
  }

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
  // Go 端给的是 CPU top30 ∪ 内存 top30 的合集，两个榜各自排序取用
  const cpuProcs = metrics ? [...metrics.procs].sort((a, b) => b.cpu - a.cpu) : []
  const memProcs = metrics ? [...metrics.procs].sort((a, b) => b.mem - a.mem) : []

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      {/* 左栏是给人读的信息，允许选中复制；右栏终端的选择归 xterm 管 */}
      <div
        className="flex shrink-0 flex-col gap-4 overflow-hidden p-4 select-text"
        style={{ width: leftWidth }}
      >
        {/* 信息条：没采到的用 — 占位，有缓存的直接显示，不等第一笔数据 */}
        <div className="flex flex-col gap-0.5 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
            <InfoItem label="主机名" value={serverInfo?.hostname ?? '—'} />
            <InfoItem label="系统" value={serverInfo?.osPretty ?? '—'} />
            <InfoItem label="内核" value={serverInfo?.kernel ?? '—'} />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
            <InfoItem
              label="已运行"
              value={metrics && metrics.uptimeSec > 0 ? formatUptime(metrics.uptimeSec) : '—'}
            />
            <InfoItem label="内网" value={serverInfo ? serverInfo.lanIps.join(' ') || '—' : '—'} />
            <InfoItem label="外网" value={serverInfo ? serverInfo.wanIp || '—' : '—'} />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">采集失败：{error}</p>}

        <div className="flex items-start gap-6 px-1">
          <Ring label="CPU" percent={metrics?.cpuPercent ?? 0} center={metrics ? `${metrics.cpuPercent.toFixed(0)}%` : '—'}>
            {metrics ? (
              <>
                <div>使用率 {metrics.cpuPercent.toFixed(1)}%</div>
                <div className="text-muted-foreground">{metrics.cores} 核</div>
              </>
            ) : (
              <div className="text-muted-foreground">—</div>
            )}
          </Ring>
          <Ring label="内存" percent={memPercent} center={metrics ? `${memPercent.toFixed(0)}%` : '—'}>
            {metrics ? (
              <>
                <div>
                  {formatBytes(memUsed)} / {formatBytes(metrics.memTotal)}
                </div>
                <div className="text-muted-foreground">已用 {memPercent.toFixed(1)}%</div>
              </>
            ) : (
              <div className="text-muted-foreground">—</div>
            )}
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
              <div className="text-muted-foreground">—</div>
            )}
          </Ring>
          <Ring label="负载" percent={loadPercent} center={metrics ? metrics.load1.toFixed(2) : '—'}>
            {metrics ? (
              <>
                <div>
                  {metrics.load1.toFixed(2)} · {metrics.load5.toFixed(2)} · {metrics.load15.toFixed(2)}
                </div>
                <div className="text-muted-foreground">1 / 5 / 15 分钟 · {metrics.cores} 核</div>
              </>
            ) : (
              <div className="text-muted-foreground">—</div>
            )}
          </Ring>
        </div>

        {/* 内容切换：进程 / Docker，以后加网络/服务/日志等 */}
        <div className="flex items-center gap-1 text-sm">
          {([
            ['proc', '进程'],
            ['docker', 'Docker']
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={cn(
                'rounded-md px-2.5 py-1',
                opsTab === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setOpsTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {opsTab === 'proc' ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
            <ProcSection
              title="CPU 占用最高"
              procs={cpuProcs}
              shown={cpuShown}
              onToggle={() => setCpuShown(cpuShown === 5 ? 10 : 5)}
              confirmKill={confirmKill}
              onKill={killProc}
              loaded={metrics !== null}
            />
            <ProcSection
              title="内存占用最高"
              procs={memProcs}
              shown={memShown}
              onToggle={() => setMemShown(memShown === 5 ? 10 : 5)}
              confirmKill={confirmKill}
              onKill={killProc}
              loaded={metrics !== null}
              divider
            />
          </div>
        ) : (
          <DockerSection sessionId={sessionId} />
        )}
      </div>
      {/* 分隔条：按住左右拖，调整左侧信息区宽度 */}
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

/** 进程榜一节：标题栏（含展开/收起）+ 前 N 名表格。杀进程按钮两步确认。
    高度跟着内容走，卡片外壳和滚动由父级统一提供，divider 给第二节加分隔线。 */
function ProcSection(props: {
  title: string
  procs: ProcInfo[]
  shown: number
  onToggle: () => void
  confirmKill: number | null
  onKill: (pid: number) => void
  /** 第一笔数据还没回来时是 false，空表先不显示「没有采集到」 */
  loaded: boolean
  divider?: boolean
}) {
  const list = props.procs.slice(0, props.shown)
  return (
    <div>
      <div
        className={cn(
          'flex items-center justify-between border-b bg-accent/40 px-3 py-1.5',
          props.divider && 'border-t'
        )}
      >
        <span className="text-sm text-muted-foreground">{props.title}</span>
        {props.procs.length > 5 && (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={props.onToggle}
          >
            {props.shown === 5 ? '展开到 10 个' : '收起'}
          </button>
        )}
      </div>
      <div>
        {/* 定宽列给死窄宽度，剩下的全给命令列，长命令能多看一截 */}
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="w-20 px-3 py-1.5 text-right font-medium">PID</th>
              <th className="w-20 px-3 py-1.5 text-left font-medium">USER</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">%CPU</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">%MEM</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">RSS</th>
              <th className="px-3 py-1.5 text-left font-medium">命令</th>
              <th className="w-10 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.pid} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 text-right tabular-nums">{p.pid}</td>
                <td className="truncate px-3 py-1.5">{p.user}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.cpu.toFixed(1)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.mem.toFixed(1)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatRss(p.rss)}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  <Tip text={formatCmd(p.cmd)}>{p.cmd}</Tip>
                </td>
                <td className="px-1 py-1.5 text-center">
                  <button
                    type="button"
                    title={props.confirmKill === p.pid ? '再点一次确认杀死' : '杀死进程（SIGTERM）'}
                    className={cn(
                      'inline-flex h-6 min-w-6 items-center justify-center rounded px-0.5 text-sm',
                      props.confirmKill === p.pid
                        ? 'bg-destructive/15 text-destructive'
                        : 'text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive'
                    )}
                    onClick={() => props.onKill(p.pid)}
                  >
                    {props.confirmKill === p.pid ? '确认' : <X className="size-3.5" />}
                  </button>
                </td>
              </tr>
            ))}
            {props.loaded && list.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                  没有采集到进程
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 操作列单元格：平时是 ⋯ 下拉菜单；删除被选过后变成红色「确认」按钮，点了才真删。 */
function ActionCell(props: { confirming: boolean; onConfirm: () => void; children: ReactNode }) {
  if (props.confirming) {
    return (
      <button
        type="button"
        title="再点一次确认删除"
        className="inline-flex h-6 min-w-6 items-center justify-center rounded bg-destructive/15 px-1 text-sm text-destructive"
        onClick={props.onConfirm}
      >
        确认
      </button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="操作"
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-accent hover:text-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{props.children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Docker 页：一个大卡片，上容器下镜像，中间分隔线。结果走 store 缓存，
    切进来先显示缓存；页面开着每 15 秒后台更新，右上角图标手动刷新。 */
function DockerSection(props: { sessionId: string }) {
  const cached = useAppStore((s) => s.dockerBySession[props.sessionId])
  const loadDockerInfo = useAppStore((s) => s.loadDockerInfo)
  const setNotice = useAppStore((s) => s.setNotice)
  // 删除两步确认：菜单里点了删除，该行 ⋯ 变成红色「确认」，3 秒不点恢复
  const [confirmDel, setConfirmDel] = useState<{ action: string; id: string } | null>(null)

  useEffect(() => {
    loadDockerInfo(props.sessionId)
    const timer = window.setInterval(() => loadDockerInfo(props.sessionId), 15000)
    return () => window.clearInterval(timer)
  }, [props.sessionId, loadDockerInfo])

  const act = (action: string, target: string, name = '') => {
    const destructive = action === 'rm' || action === 'rmi'
    if (destructive) {
      if (confirmDel?.action === action && confirmDel.id === target) {
        setConfirmDel(null)
      } else {
        setConfirmDel({ action, id: target })
        window.setTimeout(
          () => setConfirmDel((cur) => (cur?.action === action && cur.id === target ? null : cur)),
          3000
        )
        return
      }
    }
    if (action === 'save') setNotice(`正在导出 ${name}.tar 到服务器，大镜像要等一会…`, true)
    void window.api.sessions
      .dockerAction(props.sessionId, action, target, name)
      .then((out) => {
        if (action === 'save' && out) setNotice(`已导出到服务器 ${out}，从文件面板下载`)
        loadDockerInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
  }

  const info = cached?.info ?? null
  if (info && !info.available) {
    return <div className="py-8 text-center text-sm text-muted-foreground">这台服务器没有安装 Docker</div>
  }
  // 没缓存也直接渲染卡片，表格先空着，第一笔数据到了填上

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
      <div className="flex items-center justify-between border-b bg-accent/40 px-3 py-1.5">
        <span className="text-sm text-muted-foreground">容器</span>
        <button
          type="button"
          title="刷新"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={() => loadDockerInfo(props.sessionId, true)}
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
      <div>
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="w-[18%] px-3 py-1.5 text-left font-medium">名称</th>
              <th className="w-[30%] px-3 py-1.5 text-left font-medium">镜像</th>
              <th className="w-[24%] px-3 py-1.5 text-left font-medium">状态</th>
              <th className="w-[18%] px-3 py-1.5 text-left font-medium">端口</th>
              <th className="w-10 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(info?.containers ?? []).map((c) => (
              <tr key={c.id} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5">
                  <Tip text={c.name}>{c.name}</Tip>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  <Tip text={c.image}>{c.image}</Tip>
                </td>
                <td className="px-3 py-1.5">
                  <Tip text={c.status}>
                    <span className={c.state === 'running' ? 'text-primary' : 'text-muted-foreground'}>
                      {c.status}
                    </span>
                  </Tip>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  <Tip text={formatPorts(c.ports)}>{c.ports || '—'}</Tip>
                </td>
                <td className="px-1 py-1.5 text-center">
                  <ActionCell
                    confirming={confirmDel?.action === 'rm' && confirmDel.id === c.id}
                    onConfirm={() => act('rm', c.id)}
                  >
                    {c.state === 'running' ? (
                      <>
                        <DropdownMenuItem onSelect={() => act('stop', c.id)}>停止</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => act('restart', c.id)}>重启</DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem onSelect={() => act('start', c.id)}>启动</DropdownMenuItem>
                    )}
                    <DropdownMenuItem variant="destructive" onSelect={() => act('rm', c.id)}>
                      删除
                    </DropdownMenuItem>
                  </ActionCell>
                </td>
              </tr>
            ))}
            {info && info.containers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                  没有容器
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-y bg-accent/40 px-3 py-1.5 text-sm text-muted-foreground">镜像</div>
      <div>
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="w-[38%] px-3 py-1.5 text-left font-medium">仓库</th>
              <th className="w-[14%] px-3 py-1.5 text-left font-medium">标签</th>
              <th className="w-[14%] px-3 py-1.5 text-right font-medium">大小</th>
              <th className="w-[24%] px-3 py-1.5 text-left font-medium">创建</th>
              <th className="w-10 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(info?.images ?? []).map((im) => (
              <tr key={`${im.repository}:${im.tag}@${im.id}`} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5">
                  <Tip text={im.repository}>{im.repository}</Tip>
                </td>
                <td className="truncate px-3 py-1.5 text-muted-foreground">{im.tag}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{im.size}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  <Tip text={im.created}>{im.created}</Tip>
                </td>
                <td className="px-1 py-1.5 text-center">
                  <ActionCell
                    confirming={confirmDel?.action === 'rmi' && confirmDel.id === im.id}
                    onConfirm={() => act('rmi', im.id)}
                  >
                    <DropdownMenuItem onSelect={() => act('save', im.id, `${im.repository}_${im.tag}`)}>
                      导出
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => act('rmi', im.id)}>
                      删除
                    </DropdownMenuItem>
                  </ActionCell>
                </td>
              </tr>
            ))}
            {info && info.images.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                  没有镜像
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 截断文本的悬停提示，替代丑陋的原生 title：主题色浮层、下方弹出、零延迟。 */
function Tip(props: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-default truncate">{props.children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={4} className="max-w-md break-words whitespace-pre-wrap">
        {props.text}
      </TooltipContent>
    </Tooltip>
  )
}

/** 命令行格式化：程序路径一行，每个参数独占一行并缩进，比一坨硬折行好读。 */
function formatCmd(cmd: string): string {
  const parts = cmd.split(/\s+/)
  if (parts.length <= 1) return cmd
  return parts[0] + '\n' + parts.slice(1).map((p) => '  ' + p).join('\n')
}

/** 端口映射格式化：docker 的 "0.0.0.0:80->80/tcp, [::]:80->80/tcp"
    拆成每行一条，行首带协议族提示。 */
function formatPorts(ports: string): string {
  if (!ports) return '未映射端口'
  const lines = ports.split(', ').map((m) => {
    const match = m.match(/^(\S+):(\S+)->(\S+)$/)
    if (!match) return m
    const [, ip, hostPort, containerPort] = match
    const family = ip === '0.0.0.0' ? 'IPv4' : ip === '[::]' ? 'IPv6' : ip
    return `${family}  ${ip}:${hostPort} → ${containerPort}`
  })
  return `端口映射（宿主机 → 容器）\n${lines.join('\n')}`
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

/** 环形进度：圆环弧度=百分比，中间放数值，≥85% 变红。hover 弹出细节浮层。 */
function Ring(props: { label: string; percent: number; center: string; children: ReactNode }) {
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
              'absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums',
              hot && 'text-destructive'
            )}
          >
            {props.center}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">{props.label}</div>
      </div>
      <div className="invisible absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-sm whitespace-nowrap shadow-md group-hover:visible">
        {props.children}
      </div>
    </div>
  )
}
