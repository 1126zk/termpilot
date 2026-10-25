import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { CircleHelp, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import type { CronEntry, DockerInfo, ProcInfo, ServerMetrics, WebConfFile } from '../../../shared/types'
import { newTermId } from '../../../shared/ids'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from './flip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { terminalPool } from '../terminal/TerminalPool'
import { TerminalView } from './TerminalView'
import { MANUAL_TOPICS } from './manualData'
import { TRIAGE_SCENARIOS } from './troubleshootData'
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
  // 内容区选项卡：进程 / Docker / 网站 / 脚本
  const [opsTab, setOpsTab] = useState<'proc' | 'docker' | 'web' | 'script' | 'manual' | 'triage'>('proc')
  // 面板终端的 id 提到这一层：脚本页的"交互式"脚本要往它里面发命令
  const [panelTermId] = useState(() => newTermId())

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
          <div className="flex items-baseline gap-x-4 overflow-hidden">
            <InfoItem label="主机名" value={serverInfo?.hostname ?? '—'} truncate />
            <InfoItem label="系统" value={serverInfo?.osPretty ?? '—'} />
            <InfoItem label="内核" value={serverInfo?.kernel ?? '—'} truncate />
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

        {/* 内容切换：进程 / Docker / 网站 / 脚本 / 手册 / 排查 */}
        <div className="flex items-center gap-1 text-sm">
          {([
            ['proc', '进程'],
            ['docker', 'Docker'],
            ['web', '网站'],
            ['script', '脚本'],
            ['manual', '手册'],
            ['triage', '排查']
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
        ) : opsTab === 'docker' ? (
          <DockerSection sessionId={sessionId} />
        ) : opsTab === 'web' ? (
          <WebSection sessionId={sessionId} />
        ) : opsTab === 'script' ? (
          <ScriptSection sessionId={sessionId} panelTermId={panelTermId} />
        ) : opsTab === 'manual' ? (
          <ManualSection />
        ) : (
          <TriageSection />
        )}
      </div>
      {/* 分隔条：按住左右拖，调整左侧信息区宽度 */}
      <div
        className="w-1 shrink-0 cursor-col-resize bg-border transition-colors select-none hover:bg-primary/40 active:bg-primary/60"
        onPointerDown={startDrag}
      />
      {/* 右侧命令区：同一台服务器再开一路真终端，面板关掉就断开销毁 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <OpsTerminal sessionId={sessionId} termId={panelTermId} />
      </div>
    </div>
  )
}

/** 面板右侧的终端：挂载时在同一 SSH 会话上开一路新终端，卸载时断开销毁。
    渲染复用 TerminalView：右键菜单（复制/三种截图/粘贴）和主终端一致。
    顺序和主流程保持一致：先 create 成功再挂 TerminalView（attach 里的 bindView 要在 create 之后）。 */
function OpsTerminal(props: { sessionId: string; termId: string }) {
  const termId = props.termId
  const setNotice = useAppStore((s) => s.setNotice)
  const [ready, setReady] = useState(false)
  // StrictMode 开发模式会假卸载一次（清理后立刻重新挂载）：清理延迟一拍，
  // 假卸载的清理被取消，真卸载才 close；否则双跑会建出两只 shell，提示符出现两次
  const cleanupTimer = useRef(0)

  useEffect(() => {
    window.clearTimeout(cleanupTimer.current)
    let dead = false
    window.api.term
      .create({
        termId,
        kind: 'ssh',
        sessionId: props.sessionId,
        title: '面板终端',
        cols: 80,
        rows: 24
      })
      .then(() => {
        if (!dead) setReady(true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
    return () => {
      dead = true
      cleanupTimer.current = window.setTimeout(() => {
        window.api.term.close(termId)
        terminalPool.dispose(termId)
      }, 100)
    }
  }, [termId, props.sessionId, setNotice])

  if (!ready) return <div className="min-h-0 flex-1" style={{ background: 'var(--terminal-background)' }} />
  return <TerminalView termId={termId} />
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

// 默认 docker 安装源：国内权威源优先，官方兜底。面板可编辑（名称+地址），存 localStorage。
type DockerMirror = { name: string; url: string }
const DEFAULT_DOCKER_MIRRORS: DockerMirror[] = [
  { name: '阿里云', url: 'https://mirrors.aliyun.com/docker-ce' },
  { name: '清华', url: 'https://mirrors.tuna.tsinghua.edu.cn/docker-ce' },
  { name: '中科大', url: 'https://mirrors.ustc.edu.cn/docker-ce' },
  { name: '华为云', url: 'https://mirrors.huaweicloud.com/docker-ce' },
  { name: '腾讯云', url: 'https://mirrors.tencent.com/docker-ce' },
  { name: 'Docker 官方', url: 'https://download.docker.com' }
]
const DOCKER_MIRRORS_KEY = 'termpilot.dockerMirrors'

// 老版本存的是纯地址数组，迁移时按这张表认领名字，认不出的归「自定义」
const LEGACY_MIRROR_NAMES: Record<string, string> = Object.fromEntries(
  DEFAULT_DOCKER_MIRRORS.map((m) => [m.url, m.name])
)

function loadDockerMirrors(): DockerMirror[] {
  try {
    const raw = localStorage.getItem(DOCKER_MIRRORS_KEY)
    const list = raw ? JSON.parse(raw) : null
    if (Array.isArray(list) && list.length > 0) {
      if (list.every((x) => typeof x === 'string')) {
        return list.map((url) => ({ name: LEGACY_MIRROR_NAMES[url] ?? '自定义', url }))
      }
      if (list.every((x) => x && typeof x.url === 'string')) return list
    }
  } catch {
    // 坏数据回落默认
  }
  return DEFAULT_DOCKER_MIRRORS
}

/** 可点击的文件路径：点击切到现成的远程编辑器打开（可编辑、固定 tab），和文件面板同一通道。 */
function PathLink(props: { sessionId: string; path: string; className?: string }) {
  const openRemoteEditor = useAppStore((s) => s.openRemoteEditor)
  const termId = useAppStore((s) => s.opsPanelTermId)
  return (
    <button
      type="button"
      title="点击编辑"
      className={cn('cursor-pointer text-left hover:underline', props.className)}
      onClick={() => {
        if (!termId) return
        const name = props.path.split('/').pop() ?? props.path
        openRemoteEditor(termId, props.sessionId, { path: props.path, name }, true, false)
      }}
    >
      {props.path}
    </button>
  )
}

/** 没装 Docker 的空态 + 一键安装。源列表可编辑（删/加/恢复默认），存面板本地，所有服务器共用。 */
function DockerInstallSection(props: { sessionId: string }) {
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const [mirrors, setMirrors] = useState<DockerMirror[]>(loadDockerMirrors)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const setNotice = useAppStore((s) => s.setNotice)
  const loadDockerInfo = useAppStore((s) => s.loadDockerInfo)
  const loadWebInfo = useAppStore((s) => s.loadWebInfo)

  // 拖拽闭包要拿最新顺序（move 事件闭包里的 state 是拖拽开始时的旧快照），镜像一份到 ref
  const mirrorsRef = useRef(mirrors)
  const updateMirrors = (list: DockerMirror[]) => {
    mirrorsRef.current = list
    setMirrors(list)
    localStorage.setItem(DOCKER_MIRRORS_KEY, JSON.stringify(list))
  }
  const addMirror = () => {
    const name = newName.trim() || '自定义'
    let url = newUrl.trim()
    if (!url) return
    // 没带协议头就补 https://（后端只收 https）
    if (!/^https?:\/\//.test(url)) url = 'https://' + url
    if (mirrors.some((m) => m.url === url)) {
      setNotice('这个源已经在列表里了')
      return
    }
    updateMirrors([...mirrors, { name, url }])
    setNewName('')
    setNewUrl('')
  }

  // 拖拽排序：复用 flip.ts 那套（TabBar 标签/菜单同款手感）
  const listRef = useRef<HTMLDivElement>(null)
  const [dragMirror, setDragMirror] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const dragStart = useRef({ grab: 0, size: 0 })
  const pointerY = useRef(0)
  const prevTop = useRef(new Map<string, number>())

  useFlipSlide(dragMirror !== null, listRef, 'data-mirror', 'y', dragMirror, prevTop, [mirrors, dragMirror])

  // 重排后被拖行的布局位置变了，按抓取点重新算位移，保证跟手不跳；
  // 位移夹在首尾行之间（TabBar 同款），防止跟手行飞出列表
  const followPointer = (m: string) => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>(`[data-mirror="${CSS.escape(m)}"]`)
    if (!list || !el) return
    const pointer = pointerY.current - list.getBoundingClientRect().top + list.scrollTop
    const offset = pointer - dragStart.current.grab - el.offsetTop
    const items = list.querySelectorAll<HTMLElement>('[data-mirror]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetTop - el.offsetTop
    const max = last.offsetTop + last.offsetHeight - el.offsetHeight - el.offsetTop
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }
  useLayoutEffect(() => {
    if (dragMirror) followPointer(dragMirror)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirrors, dragMirror])

  const startMirrorDrag = (e: ReactPointerEvent, m: string) => {
    // 拦 pointerdown 的默认行为，防止左栏继承来的 select-text 开始文字选择
    //（只拦 pointerdown，行内 × 按钮的 click 照常触发）
    if (e.button === 0) e.preventDefault()
    startPointerDrag({
      event: e,
      axis: 'y',
      onActivate: () => {
        const list = listRef.current
        const el = list?.querySelector<HTMLElement>(`[data-mirror="${CSS.escape(m)}"]`)
        const pointer = list ? e.clientY - list.getBoundingClientRect().top + list.scrollTop : 0
        dragStart.current = {
          grab: pointer - (el?.offsetTop ?? 0),
          size: el?.offsetHeight ?? 0
        }
        setDragMirror(m)
        setDragOffset(0)
      },
      onMove: (y) => {
        pointerY.current = y
        // 视觉边缘一律用「指针 - 抓取点」算（和 TabBar 一致）；起始布局位重排后就过期，不能用
        const list = listRef.current
        if (list) {
          const cur = mirrorsRef.current.map((x) => x.url)
          const pointer = y - list.getBoundingClientRect().top + list.scrollTop
          const raw = pointer - dragStart.current.grab
          // 判定也用限位后的视觉位置：拖出首尾行外沿不会乱换（tabDropOrder 同款）
          const size = dragStart.current.size
          const items = list.querySelectorAll<HTMLElement>('[data-mirror]')
          const first = items[0]
          const last = items[items.length - 1]
          const start =
            first && last
              ? Math.min(last.offsetTop + last.offsetHeight - size, Math.max(first.offsetTop, raw))
              : raw
          const insert = dropIndex(list, 'data-mirror', 'y', start, start + size, m, cur)
          const next = moveTo(cur, m, insert)
          if (next) {
            capturePositions(list, 'data-mirror', 'y', prevTop.current)
            // next 是 url 顺序，映射回对象数组
            updateMirrors(next.map((url) => mirrorsRef.current.find((x) => x.url === url)!))
          }
        }
        followPointer(m)
      },
      onEnd: () => {
        setDragMirror(null)
        setDragOffset(0)
        prevTop.current.clear()
      }
    })
  }
  const install = () => {
    setInstalling(true)
    setLog([])
    setNotice('正在安装 Docker（按源顺序尝试），装系统包要等一会…', true)
    void window.api.sessions
      .dockerInstall(props.sessionId, mirrors.map((m) => m.url))
      .then(() => {
        setNotice('Docker 安装完成')
        loadDockerInfo(props.sessionId, true)
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstalling(false))
  }

  // 安装过程的逐行输出：安装期间订阅，退订随安装结束；最多留 200 行，自动滚到底
  useEffect(() => {
    if (!installing) return
    return window.api.sessions.onDockerInstallProgress(props.sessionId, (line) =>
      setLog((cur) => [...cur.slice(-199), line])
    )
  }, [installing, props.sessionId])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
      <p>这台服务器没有安装 Docker</p>
      <Button size="sm" disabled={installing || mirrors.length === 0} onClick={install}>
        {installing ? '安装中…' : '一键安装 Docker'}
      </Button>
      {log.length > 0 && (
        <div
          ref={logRef}
          className="max-h-44 w-full max-w-md overflow-auto rounded-md bg-muted p-2 font-mono text-sm select-text"
        >
          {log.map((line, i) => (
            <div key={i} className="break-all whitespace-pre-wrap">
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 w-full max-w-md text-sm">
        <div className="mb-1 flex items-center justify-between">
          <span>源（按顺序尝试）</span>
          <button type="button" className="hover:text-foreground" onClick={() => updateMirrors(DEFAULT_DOCKER_MIRRORS)}>
            恢复默认
          </button>
        </div>
        <div ref={listRef} className="relative select-none">
          {mirrors.map((m) => (
            <div
              key={m.url}
              data-mirror={m.url}
              className={cn(
                'flex cursor-grab items-center gap-2 py-0.5',
                dragMirror === m.url && 'relative z-10 cursor-grabbing bg-background shadow-lg ring-1 ring-foreground/30'
              )}
              style={dragMirror === m.url ? { transform: `translateY(${dragOffset}px)` } : undefined}
              onPointerDown={(e) => startMirrorDrag(e, m.url)}
            >
              <span className="w-20 shrink-0">{m.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{m.url.replace(/^https:\/\//, '')}</span>
              <button
                type="button"
                className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                onClick={() => updateMirrors(mirrors.filter((x) => x.url !== m.url))}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1.5">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="名称" className="h-7 w-24 text-sm" />
          <Input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://…/docker-ce"
            className="h-7 font-mono text-sm"
          />
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={addMirror}>
            添加
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Docker 页：一个大卡片，容器、镜像、卷、网络、daemon.json 五节，中间分隔线。结果走 store 缓存，
    切进来先显示缓存；页面开着每 15 秒后台更新，右上角图标手动刷新。 */
function DockerSection(props: { sessionId: string }) {
  const cached = useAppStore((s) => s.dockerBySession[props.sessionId])
  const loadDockerInfo = useAppStore((s) => s.loadDockerInfo)
  const loadWebInfo = useAppStore((s) => s.loadWebInfo)
  const setNotice = useAppStore((s) => s.setNotice)
  // 删除两步确认：菜单里点了删除，该行 ⋯ 变成红色「确认」，3 秒不点恢复
  const [confirmDel, setConfirmDel] = useState<{ action: string; id: string } | null>(null)
  // docker 服务操作（停止/重启/卸载）两步确认，同上
  const [confirmOp, setConfirmOp] = useState<string | null>(null)
  // 操作在飞时的反馈：提示条常驻 + 按钮禁用
  const [opBusy, setOpBusy] = useState<string | null>(null)
  // 手动刷新反馈：数据在飞就转圈
  const [refreshing, setRefreshing] = useState(false)
  // 镜像加速输入框和生效中状态
  const [mirrorInput, setMirrorInput] = useState('')
  const [mirrorBusy, setMirrorBusy] = useState(false)

  useEffect(() => {
    loadDockerInfo(props.sessionId)
    const timer = window.setInterval(() => loadDockerInfo(props.sessionId), 15000)
    return () => window.clearInterval(timer)
  }, [props.sessionId, loadDockerInfo])

  const act = (action: string, target: string, name = '') => {
    const destructive = ['rm', 'rmi', 'volume-rm', 'network-rm'].includes(action)
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
        // 容器增删/启停直接影响网站页的"装没装、跑没跑"，顺手刷新它的缓存
        if (['start', 'stop', 'restart', 'rm'].includes(action)) loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
  }

  const info = cached?.info ?? null
  if (info && !info.available) {
    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
        <DockerInstallSection sessionId={props.sessionId} />
      </div>
    )
  }

  // docker 服务操作：启动直接跑；停止/重启/卸载两步确认（会动到所有容器/整个引擎）
  const dockerOpLabels: Record<string, string> = { start: '启动', stop: '停止', restart: '重启', uninstall: '卸载' }
  const dockerOp = (op: string) => {
    if (op !== 'start') {
      if (confirmOp !== op) {
        setConfirmOp(op)
        window.setTimeout(() => setConfirmOp((cur) => (cur === op ? null : cur)), 3000)
        return
      }
      setConfirmOp(null)
    }
    const label = dockerOpLabels[op] ?? op
    setOpBusy(op)
    setNotice(`正在${label} Docker…`, true)
    void window.api.sessions
      .dockerService(props.sessionId, op)
      .then(() => {
        setNotice(`Docker 已${label}`)
        loadDockerInfo(props.sessionId, true)
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setOpBusy(null))
  }
  const opBtn = (op: string, label: string) => (
    <button
      key={op}
      type="button"
      disabled={opBusy !== null}
      className={cn(
        'rounded px-1.5 py-0.5 text-xs disabled:opacity-40',
        confirmOp === op ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground/70 hover:text-foreground'
      )}
      onClick={() => dockerOp(op)}
    >
      {opBusy === op ? '进行中…' : confirmOp === op ? '确认' : label}
    </button>
  )

  // ---- 镜像加速：读写 daemon.json 的 registry-mirrors，其余字段原样保留；没有文件时第一次添加会创建 ----
  const daemonMirrors: string[] = (() => {
    try {
      const obj = JSON.parse(info?.daemonJson || '{}') as { 'registry-mirrors'?: unknown }
      const list = obj['registry-mirrors']
      return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : []
    } catch {
      return []
    }
  })()

  const setMirrors = (next: string[]) => {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(info?.daemonJson || '{}')
    } catch {
      setNotice('现有 daemon.json 不是合法 JSON，先点路径进编辑器修正')
      return
    }
    if (next.length > 0) obj['registry-mirrors'] = next
    else delete obj['registry-mirrors']
    setMirrorBusy(true)
    void window.api.sessions
      .setDockerMirrors(props.sessionId, JSON.stringify(obj, null, 2))
      .then(() => {
        setNotice('镜像加速已生效')
        setMirrorInput('')
        loadDockerInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setMirrorBusy(false))
  }

  const addMirror = () => {
    const url = mirrorInput.trim().replace(/\/+$/, '')
    if (!/^https:\/\/[a-zA-Z0-9.-]+(\/[a-zA-Z0-9._/-]*)?$/.test(url)) {
      setNotice('镜像源地址要是 https://主机 的形式，比如 https://docker.1panel.live')
      return
    }
    if (daemonMirrors.includes(url)) {
      setNotice('这个源已经在列表里了')
      return
    }
    setMirrors([...daemonMirrors, url])
  }
  // 没缓存也直接渲染卡片，表格先空着，第一笔数据到了填上

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
      <div className="flex items-center justify-between border-b bg-accent/40 px-3 py-1.5">
        <span className="text-sm text-muted-foreground">容器</span>
        <button
          type="button"
          title="刷新"
          disabled={refreshing}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
          onClick={() => {
            setRefreshing(true)
            void loadDockerInfo(props.sessionId, true).finally(() => setRefreshing(false))
          }}
        >
          <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
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
                    {/* restarting（崩溃循环）也算在运行：这时要的是停止打断循环，不是启动 */}
                    {c.state === 'running' || c.state === 'restarting' ? (
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
            {(info?.images ?? []).map((im) => {
              // 悬空镜像（<none>）没有标签可摘，按 id 删；有标签的按 仓库:标签 删，只摘一个标签
              const ref = im.repository === '<none>' ? im.id : `${im.repository}:${im.tag}`
              return (
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
                    confirming={confirmDel?.action === 'rmi' && confirmDel.id === ref}
                    onConfirm={() => act('rmi', ref)}
                  >
                    <DropdownMenuItem onSelect={() => act('save', im.id, `${im.repository}_${im.tag}`)}>
                      导出
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => act('rmi', ref)}>
                      删除
                    </DropdownMenuItem>
                  </ActionCell>
                </td>
              </tr>
              )
            })}
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

      <div className="border-y bg-accent/40 px-3 py-1.5 text-sm text-muted-foreground">卷</div>
      <div>
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="w-[70%] px-3 py-1.5 text-left font-medium">名称</th>
              <th className="px-3 py-1.5 text-left font-medium">驱动</th>
              <th className="w-10 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(info?.volumes ?? []).map((v) => (
              <tr key={v.name} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5">
                  <Tip text={v.name}>{v.name}</Tip>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{v.driver}</td>
                <td className="px-1 py-1.5 text-center">
                  <ActionCell
                    confirming={confirmDel?.action === 'volume-rm' && confirmDel.id === v.name}
                    onConfirm={() => act('volume-rm', v.name)}
                  >
                    <DropdownMenuItem variant="destructive" onSelect={() => act('volume-rm', v.name)}>
                      删除
                    </DropdownMenuItem>
                  </ActionCell>
                </td>
              </tr>
            ))}
            {info && info.volumes.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                  没有卷
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-y bg-accent/40 px-3 py-1.5 text-sm text-muted-foreground">网络</div>
      <div>
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="w-[45%] px-3 py-1.5 text-left font-medium">名称</th>
              <th className="w-[22%] px-3 py-1.5 text-left font-medium">驱动</th>
              <th className="w-[22%] px-3 py-1.5 text-left font-medium">范围</th>
              <th className="w-10 px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(info?.networks ?? []).map((n) => (
              <tr key={n.id} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5">
                  <Tip text={n.name}>{n.name}</Tip>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{n.driver}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{n.scope}</td>
                <td className="px-1 py-1.5 text-center">
                  <ActionCell
                    confirming={confirmDel?.action === 'network-rm' && confirmDel.id === n.name}
                    onConfirm={() => act('network-rm', n.name)}
                  >
                    <DropdownMenuItem variant="destructive" onSelect={() => act('network-rm', n.name)}>
                      删除
                    </DropdownMenuItem>
                  </ActionCell>
                </td>
              </tr>
            ))}
            {info && info.networks.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">
                  没有网络
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-y bg-accent/40 px-3 py-1.5 font-mono text-sm text-muted-foreground">
        {info?.daemonJson ? (
          <PathLink sessionId={props.sessionId} path="/etc/docker/daemon.json" />
        ) : (
          <span>/etc/docker/daemon.json</span>
        )}
        <span className="flex items-center gap-1 font-sans">
          {info?.running
            ? [opBtn('restart', '重启'), opBtn('stop', '停止'), opBtn('uninstall', '删除')]
            : [opBtn('start', '启动'), opBtn('uninstall', '删除')]}
        </span>
      </div>
      <div className="px-3 py-2">
        {info?.daemonJson ? (
          <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-sm break-all whitespace-pre-wrap select-text">
            {info.daemonJson}
          </pre>
        ) : (
          info && <p className="py-2 text-center text-sm text-muted-foreground">没有 /etc/docker/daemon.json</p>
        )}
        {/* 镜像加速：列出 registry-mirrors，可增删；没有 daemon.json 时第一次添加会创建文件 */}
        {info && (
          <div className="mt-2 border-t border-border/50 pt-2">
            <p className="mb-1 text-sm text-muted-foreground">镜像加速（registry-mirrors，改完热生效，不用重启）</p>
            {daemonMirrors.length === 0 ? (
              <p className="py-0.5 text-sm text-muted-foreground">还没有镜像源</p>
            ) : (
              daemonMirrors.map((m) => (
                <div key={m} className="flex items-center gap-2 py-0.5 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
                  <button
                    type="button"
                    disabled={mirrorBusy}
                    className="shrink-0 rounded px-1 text-xs text-muted-foreground/60 hover:text-destructive disabled:opacity-40"
                    onClick={() => setMirrors(daemonMirrors.filter((x) => x !== m))}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
            <div className="mt-1 flex items-center gap-1.5">
              <Input
                value={mirrorInput}
                onChange={(e) => setMirrorInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMirror()}
                placeholder="https://docker.1panel.live"
                className="h-7 flex-1 font-mono text-sm"
              />
              <Button size="sm" className="h-7 px-2" disabled={mirrorBusy || !mirrorInput.trim()} onClick={addMirror}>
                {mirrorBusy ? '生效中…' : '添加'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 从采集到的文件列表解析站点：文件是站点的身份（删除按文件名定位），显示名从内容解析
    ——nginx 取 server_name + listen 端口，caddy 取块首行的站点地址（domain 或 http://domain:port）。
    nginx 剥掉注释行再识别（全注释的种子模板不算站点）；类型和目标尽力识别，认不出标自定义。 */
function parseSites(
  files: WebConfFile[],
  svc: 'nginx' | 'caddy'
): { name: string; domain: string; port: string; proto: 'http' | 'https'; addr: string; kind: string; target: string; targetTitle: string }[] {
  const dir = svc === 'nginx' ? '/conf.d/' : '/sites/'
  const ext = svc === 'nginx' ? '.conf' : '.caddy'
  const sites: { name: string; domain: string; port: string; proto: 'http' | 'https'; addr: string; kind: string; target: string; targetTitle: string }[] = []
  for (const f of files) {
    if (!f.path.includes(dir) || !f.path.endsWith(ext) || f.path.endsWith('/placeholder.caddy')) continue
    const body =
      svc === 'nginx'
        ? f.content
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n')
        : f.content
    if (!body.trim()) continue
    const name = f.path.split('/').pop()!.slice(0, -ext.length)
    let domain = ''
    let port = '80'
    let proto: 'http' | 'https' = 'http'
    let addr = ''
    if (svc === 'nginx') {
      const sn = body.match(/server_name\s+([^;\s]+)/)
      if (!sn) continue
      domain = sn[1]
      port = body.match(/listen\s+(?:\[::\]:)?(\d+)/)?.[1] ?? '80'
      proto = /listen\s+(?:\[::\]:)?\d+\s+ssl\b/.test(body) ? 'https' : 'http'
    } else {
      // caddy 站点地址是块首行：domain（自动 HTTPS）或 http://domain:port（纯 HTTP）
      const firstLine = body.trimStart().split('\n')[0].replace(/\s*\{.*$/, '')
      proto = /^http:\/\//.test(firstLine) ? 'http' : 'https'
      const addrRaw = firstLine.replace(/^https?:\/\//, '')
      const sep = addrRaw.lastIndexOf(':')
      domain = sep > 0 ? addrRaw.slice(0, sep) : addrRaw
      port = sep > 0 ? addrRaw.slice(sep + 1) : proto === 'https' ? '443' : '80'
      // 第一列显示完整地址：协议 + 域名 + 端口（没写端口的按协议默认）
      addr = `${proto}://${domain}:${port}`
    }
    const proxy = body.match(/reverse_proxy\s+(\S+)/) ?? body.match(/proxy_pass\s+https?:\/\/([^;\s]+)/)
    if (proxy) {
      sites.push({ name, domain, port, proto, addr, kind: '反代', target: proxy[1], targetTitle: '' })
      continue
    }
    const root = body.match(/root\s+(?:\*\s+)?([^;\s]+)/)
    if (root && (svc === 'nginx' || body.includes('file_server'))) {
      // 静态站显示宿主机挂载路径（hover 显示容器内路径）；认不出挂载的手写路径原样显示
      const containerPath = root[1]
      const prefix = svc === 'nginx' ? '/usr/share/nginx/html/' : '/srv/'
      const hostRoot = svc === 'nginx' ? '~/.termpilot/nginx/www/' : '~/.termpilot/caddy/www/'
      const mapped = containerPath.startsWith(prefix) ? hostRoot + containerPath.slice(prefix.length) : containerPath
      sites.push({
        name,
        domain,
        port,
        proto,
        addr,
        kind: '静态',
        target: mapped,
        targetTitle: mapped === containerPath ? '' : containerPath
      })
      continue
    }
    sites.push({ name, domain, port, proto, addr, kind: '自定义', target: '', targetTitle: '' })
  }
  return sites
}

/** 网站页：nginx / caddy 左右切换。只管容器化的实例（固定容器名），宿主机直装的不管。
    没装时给一键安装（alpine 小镜像，配置收在 ~/.termpilot/<名字>/ 下）；装了显示配置原文。
    两边都支持站点增删（一站点一文件，写盘 → 校验 → 热加载）；caddy 自动 HTTPS，nginx 只生成 HTTP。
    结果走 store 缓存；页面开着每 15 秒后台更新。 */

type WebTabKey = 'nginx' | 'caddy'
// 页签顺序按服务器分开存（key 带 sessionId）：这台 caddy 在前，那台 nginx 在前，互不干扰
const webTabOrderKey = (sessionId: string) => `termpilot.webTabs.order.${sessionId}`

// 每次进来默认选中排第一个的，不记上次选中
function loadWebTabOrder(sessionId: string): WebTabKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(webTabOrderKey(sessionId)) || '[]') as unknown
    if (Array.isArray(raw)) {
      const order = raw.filter((k): k is WebTabKey => k === 'nginx' || k === 'caddy')
      const all = order.concat((['nginx', 'caddy'] as WebTabKey[]).filter((k) => !order.includes(k)))
      if (all.length === 2) return all
    }
  } catch { /* 解析失败用默认 */ }
  return ['nginx', 'caddy']
}

function WebSection(props: { sessionId: string }) {
  const [webTabs, setWebTabs] = useState<WebTabKey[]>(() => loadWebTabOrder(props.sessionId))
  // 拖动中判定要用最新顺序（闭包里的 state 是按下时的快照），同 TabBar 的 menuOrderRef
  const webTabsRef = useRef(webTabs)
  const updateWebTabs = (next: WebTabKey[]) => {
    webTabsRef.current = next
    setWebTabs(next)
    localStorage.setItem(webTabOrderKey(props.sessionId), JSON.stringify(next))
  }
  const [webTab, setWebTab] = useState<WebTabKey>(() => loadWebTabOrder(props.sessionId)[0])
  // ---- 页签拖拽排序（共用 ./flip 公共件，手感和标签条一致）----
  // 4px 阈值内仍是点击；被拖项 transform 跟手，另一项 FLIP 160ms 让位；顺序持久化
  const stripRef = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<WebTabKey | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const suppressClick = useRef(false)
  const prevLeft = useRef(new Map<string, number>())
  const dragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerX = useRef(0)

  /** 被拖页签跟手，限制在首尾之间 */
  const followPointer = (key: string) => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-web-tab="${key}"]`)
    if (!strip || !el) return
    const offset = pointerX.current - dragStart.current.pos - (el.offsetLeft - dragStart.current.layout)
    const items = strip.querySelectorAll<HTMLElement>('[data-web-tab]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetLeft - el.offsetLeft
    const max = last.offsetLeft + last.offsetWidth - el.offsetWidth - el.offsetLeft
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }

  /** 被拖页签视觉边缘越过另一项中点就交换，返回新顺序；没变返回 null */
  const tabDropOrder = (clientX: number, key: string): WebTabKey[] | null => {
    const strip = stripRef.current
    if (!strip) return null
    const ids = webTabsRef.current
    const items = strip.querySelectorAll<HTMLElement>('[data-web-tab]')
    const first = items[0]
    const last = items[items.length - 1]
    const raw = clientX - strip.getBoundingClientRect().left - dragStart.current.grab
    const start =
      first && last
        ? Math.min(last.offsetLeft + last.offsetWidth - dragStart.current.size, Math.max(first.offsetLeft, raw))
        : raw
    return moveTo(ids, key, dropIndex(strip, 'data-web-tab', 'x', start, start + dragStart.current.size, key, ids)) as WebTabKey[] | null
  }

  useFlipSlide(dragKey !== null, stripRef, 'data-web-tab', 'x', dragKey, prevLeft, [webTabs, dragKey])
  useLayoutEffect(() => {
    if (dragKey) followPointer(dragKey)
  }, [webTabs, dragKey])

  const startTabDrag = (event: ReactPointerEvent, key: WebTabKey) => {
    startPointerDrag({
      event,
      axis: 'x',
      onActivate: () => {
        const strip = stripRef.current
        const el = strip?.querySelector<HTMLElement>(`[data-web-tab="${key}"]`)
        const pointer = strip ? event.clientX - strip.getBoundingClientRect().left : 0
        dragStart.current = {
          pos: event.clientX,
          layout: el?.offsetLeft ?? 0,
          grab: pointer - (el?.offsetLeft ?? 0),
          size: el?.offsetWidth ?? 0
        }
        setDragKey(key)
        setDragOffset(0)
      },
      onMove: (x) => {
        pointerX.current = x
        const next = tabDropOrder(x, key)
        if (next && stripRef.current) {
          capturePositions(stripRef.current, 'data-web-tab', 'x', prevLeft.current)
          updateWebTabs(next)
        }
        followPointer(key)
      },
      onEnd: () => {
        // 拖完会补一个 click，不能当成切换页签
        suppressClick.current = true
        prevLeft.current.clear()
        setDragKey(null)
        setDragOffset(0)
      }
    })
  }
  // 正在安装的服务名（同一时间只跑一个）；按钮和日志只在对应子页显示，切页不串
  const [installing, setInstalling] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const installLogRef = useRef<HTMLDivElement>(null)
  const cached = useAppStore((s) => s.webBySession[props.sessionId])
  const loadWebInfo = useAppStore((s) => s.loadWebInfo)
  const setNotice = useAppStore((s) => s.setNotice)
  // 添加站点内联表单
  const [addOpen, setAddOpen] = useState(false)
  const [siteType, setSiteType] = useState<'proxy' | 'static'>('proxy')
  const [domain, setDomain] = useState('')
  const [target, setTarget] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 删站点两步确认：点了变红「确认」，3 秒不点恢复
  const [confirmDelSite, setConfirmDelSite] = useState<string | null>(null)
  // 开启 HTTPS：签发中标记（按钮变「签发中…」）
  const [sslBusy, setSslBusy] = useState<string | null>(null)

  useEffect(() => {
    loadWebInfo(props.sessionId)
    const timer = window.setInterval(() => loadWebInfo(props.sessionId), 15000)
    return () => window.clearInterval(timer)
  }, [props.sessionId, loadWebInfo])

  const info = cached?.info ?? null
  const svc = info?.[webTab]
  const certs = info?.certs ?? {}
  const file = webTab === 'nginx' ? '~/.termpilot/nginx/conf.d/*.conf' : '~/.termpilot/caddy/Caddyfile + sites/*.caddy'
  const sites = svc ? parseSites(svc.files, webTab) : []
  // 反代目标的候选：host 网络下写 127.0.0.1:宿主机发布端口，只列发布了端口的容器
  //（nginx/caddy 自己不列，IPv4/IPv6 重复映射去重）；name 仅用于显示，填入的是纯地址；
  // Docker 页没采过就在打开表单时补采
  const containers = useAppStore((s) => s.dockerBySession[props.sessionId]?.info?.containers)
  const loadDockerInfo = useAppStore((s) => s.loadDockerInfo)
  const containerOptions = Array.from(
    new Map(
      (containers ?? [])
        .filter((c) => c.name !== 'nginx' && c.name !== 'caddy')
        .flatMap((c) =>
          Array.from(c.ports.matchAll(/(?:0\.0\.0\.0|\[::\]):(\d+)(?:-\d+)?->/g), (m) => [`127.0.0.1:${m[1]}`, c.name] as const)
        )
    ).entries()
  ).map(([value, name]) => ({ value, name }))
  // 候选下拉：聚焦时浮出，按输入过滤（地址和容器名都参与）；点选用 onMouseDown 抢在 blur 前落定
  const [targetFocus, setTargetFocus] = useState(false)
  const targetQuery = target.trim()
  const filteredOptions = containerOptions.filter(
    (o) => (o.value.includes(targetQuery) || o.name.includes(targetQuery)) && o.value !== targetQuery
  )

  const openAdd = () => {
    setAddOpen(true)
    if (!containers) loadDockerInfo(props.sessionId)
  }

  const install = () => {
    const name = webTab
    setInstalling(name)
    setInstallLog([])
    setNotice(`正在拉取 ${name}:alpine 并启动容器，镜像要下载一会…`, true)
    void window.api.sessions
      .webInstall(props.sessionId, name)
      .then(() => {
        setNotice(`${name} 容器已启动，配置在 ~/.termpilot/${name}/ 下`)
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstalling(null))
  }

  // 安装过程的逐行输出：安装期间订阅，退订随安装结束；最多留 200 行，自动滚到底
  useEffect(() => {
    if (installing === null) return
    return window.api.sessions.onWebInstallProgress(props.sessionId, (line) =>
      setInstallLog((cur) => [...cur.slice(-199), line])
    )
  }, [installing, props.sessionId])
  useEffect(() => {
    const el = installLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [installLog])

  const submitSite = () => {
    // 站点地址按 caddy 写法：[http(s)://]名字[:端口]——http:// 是纯 HTTP，https:// 同裸写。
    // 不剥前缀，协议前缀要留给后端当语义
    const raw = domain.trim().replace(/\/+$/, '')
    const m = raw.match(/^(https?:\/\/)?([^:]+)(?::([0-9]+))?$/)
    const d = m ? (m[1] ?? '') + m[2] : raw
    const p = m?.[3] ?? ''
    const t = target.trim()
    setSubmitting(true)
    void window.api.sessions
      .webSite(props.sessionId, webTab, 'add', d, p, siteType, t)
      .then(() => {
        setNotice(`站点 ${d} 已保存${svc?.state === 'running' ? '并生效' : '，容器启动后生效'}`)
        setAddOpen(false)
        setDomain('')
        setTarget('')
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSubmitting(false))
  }

  const setHTTPS = (d: string, op: 'on' | 'renew' | 'off') => {
    setSslBusy(d)
    setNotice(
      op === 'off'
        ? `正在关闭 ${d} 的 HTTPS…`
        : op === 'renew'
          ? `正在为 ${d} 重新签发证书…`
          : `正在为 ${d} 签发证书，要去 Let's Encrypt 走一轮验证…`,
      true
    )
    void window.api.sessions
      .webSSL(props.sessionId, d, op)
      .then(() => {
        setNotice(op === 'off' ? `${d} 的 HTTPS 已关闭` : op === 'renew' ? `${d} 的证书已续期` : `${d} 的 HTTPS 已开启`)
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSslBusy(null))
  }

  const delSite = (siteDomain: string) => {    if (confirmDelSite !== siteDomain) {
      setConfirmDelSite(siteDomain)
      window.setTimeout(() => setConfirmDelSite((cur) => (cur === siteDomain ? null : cur)), 3000)
      return
    }
    setConfirmDelSite(null)
    void window.api.sessions
      .webSite(props.sessionId, webTab, 'del', siteDomain)
      .then(() => loadWebInfo(props.sessionId, true))
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
  }

  // 容器启停/删除：点击即给反馈（按钮变"进行中…" + 顶部提示）；删除是破坏性操作，两步确认
  const [svcOpBusy, setSvcOpBusy] = useState<string | null>(null)
  const [confirmSvcRm, setConfirmSvcRm] = useState(false)
  const svcOpLabels: Record<string, string> = { start: '启动', stop: '停止', restart: '重启', rm: '删除' }
  const svcOp = (op: 'start' | 'stop' | 'restart' | 'rm') => {
    if (op === 'rm' && !confirmSvcRm) {
      setConfirmSvcRm(true)
      window.setTimeout(() => setConfirmSvcRm(false), 3000)
      return
    }
    setConfirmSvcRm(false)
    const label = svcOpLabels[op] ?? op
    setSvcOpBusy(op)
    setNotice(`正在${label} ${webTab}…`, true)
    void window.api.sessions
      .webService(props.sessionId, webTab, op)
      .then(() => {
        setNotice(`${webTab} 已${label}`)
        loadWebInfo(props.sessionId, true)
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSvcOpBusy(null))
  }
  const svcOpBtn = (op: 'start' | 'stop' | 'restart' | 'rm', label: string) => (
    <button
      key={op}
      type="button"
      disabled={svcOpBusy !== null}
      className={cn(
        'rounded px-1.5 py-0.5 text-xs disabled:opacity-40',
        op === 'rm' && confirmSvcRm
          ? 'bg-destructive/15 text-destructive'
          : 'text-muted-foreground/70 hover:text-foreground'
      )}
      onClick={() => svcOp(op)}
    >
      {svcOpBusy === op ? '进行中…' : op === 'rm' && confirmSvcRm ? '确认' : label}
    </button>
  )

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border">
        <div ref={stripRef} className="relative flex items-center gap-1 border-b px-3 py-2 text-sm">
          {webTabs.map((key) => (
            <button
              key={key}
              type="button"
              data-web-tab={key}
              className={cn(
                'cursor-grab rounded-md px-2.5 py-1',
                webTab === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                dragKey === key && 'z-10 shadow-lg ring-1 ring-foreground/30'
              )}
              style={dragKey === key ? { transform: `translateX(${dragOffset}px)` } : undefined}
              onPointerDown={(e) => startTabDrag(e, key)}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                setWebTab(key)
              }}
            >
              {key}
            </button>
          ))}
        </div>
        {info && !info.dockerAvailable ? (
          <div className="py-8 text-center text-sm text-muted-foreground">这台服务器没有安装 Docker</div>
        ) : info && svc && !svc.state ? (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            <p>还没有安装 {webTab}</p>
            <Button size="sm" disabled={installing !== null} onClick={install}>
              {installing === webTab ? '安装中…' : `一键安装 ${webTab}:alpine`}
            </Button>
            {installing === webTab && installLog.length > 0 && (
              <div
                ref={installLogRef}
                className="max-h-44 w-full overflow-auto rounded-md bg-muted p-2 font-mono text-sm select-text"
              >
                {installLog.map((line, i) => (
                  <div key={i} className="break-all whitespace-pre-wrap">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="border-b px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  站点
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleHelp className="size-3.5 cursor-default text-muted-foreground/60 hover:text-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" sideOffset={4} className="w-max max-w-none">
                      {webTab === 'nginx' ? (
                        <div>
                          <div>HTTPS 证书：</div>
                          <div className="grid w-fit grid-cols-[auto_auto_1fr] gap-x-1.5">
                            <span>· IP 站点</span><span>→</span><span>自动自签（10 年有效），浏览器警告属正常</span>
                            <span>· 域名站点</span><span>→</span><span>{"Let's Encrypt 免费签发（域名需先解析过来），临期点\"续期\""}</span>
                            <span>· 买来的证书</span><span>→</span><span>{'传到 ~/.termpilot/nginx/ssl/certs/<域名>/ 后打开开关'}</span>
                          </div>
                          <pre className="whitespace-pre">{`  例：~/.termpilot/nginx/ssl/certs/blog.example.com/
      ├── fullchain.pem
      └── privkey.pem`}</pre>
                        </div>
                      ) : (
                        <div>
                          <div>HTTPS 证书：</div>
                          <div className="grid w-fit grid-cols-[auto_auto_1fr] gap-x-1.5">
                            <span>· IP 站点</span><span>→</span><span>内置 CA 自签，自动续期，浏览器警告属正常</span>
                            <span>· 域名站点</span><span>→</span><span>公网 CA 免费签发，自动续期（域名需先解析过来）</span>
                            <span>· 买来的证书</span><span>→</span><span>{'传到 ~/.termpilot/caddy/ssl/certs/<域名>/ 后，'}</span>
                          </div>
                          <pre className="whitespace-pre">{`  在 sites/<域名>.caddy 里加一行 tls 指向它们（不自动续期）
  例：~/.termpilot/caddy/ssl/certs/blog.example.com/
      ├── fullchain.pem
      └── privkey.pem
      tls /etc/caddy/ssl/certs/blog.example.com/fullchain.pem /etc/caddy/ssl/certs/blog.example.com/privkey.pem`}</pre>
                          <div className="mt-2">站点地址写法：</div>
                          <div className="grid w-fit grid-cols-[auto_1fr] gap-x-1.5">
                            <span>· 标准写法：</span><span>{'协议://域名:端口，如 https://example.com:8080（不写端口默认 443）'}</span>
                            <span>· 只想开 HTTP：</span><span>{'http://域名:端口，如 http://example.com:8080（不写端口默认 80）'}</span>
                            <span>· 协议不写默认 https：</span><span>{'example.com:8080 ≡ https://example.com:8080；端口也不写时默认 443，80 自动跳 443'}</span>
                          </div>
                        </div>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-muted-foreground"
                  onClick={() => (addOpen ? setAddOpen(false) : openAdd())}
                >
                  {addOpen ? '收起' : '+ 添加站点'}
                </Button>
              </div>
              {sites.length === 0 ? (
                <p className="py-1.5 text-sm text-muted-foreground">还没有站点</p>
              ) : (
                sites.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 py-1 text-sm">
                    <span className="w-44 shrink-0 truncate">
                      {webTab === 'caddy' ? s.addr : `${s.domain}:${s.port}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {s.kind}
                      {s.target ? ' → ' : ''}
                      {s.target &&
                        (s.targetTitle ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">{s.target}</span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="start" sideOffset={4}>
                              {s.targetTitle}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          s.target
                        ))}
                    </span>
                    {/* Switch 在 http/https 前面；仅 nginx 的 80 端口站点可开关；证书与续期也是 nginx 专属，caddy 行整段不渲染不占位 */}
                    {webTab === 'nginx' && (
                      <>
                        <span className="flex w-8 shrink-0 justify-center">
                          {s.port === '80' && (
                            <Switch
                              size="sm"
                              checked={s.proto === 'https'}
                              disabled={sslBusy === s.domain || (s.proto === 'http' && svc?.state !== 'running')}
                              onCheckedChange={(checked) => setHTTPS(s.domain, checked ? 'on' : 'off')}
                            />
                          )}
                        </span>
                        <span className="w-10 shrink-0 text-left text-muted-foreground">{s.proto}</span>
                        <span
                          className={cn(
                            'w-24 shrink-0 text-right text-xs',
                            s.proto === 'https' && certs[s.domain] !== undefined && certs[s.domain] < 30
                              ? 'text-amber-500'
                              : 'text-muted-foreground'
                          )}
                        >
                          {s.proto === 'https' && certs[s.domain] !== undefined ? `证书剩 ${certs[s.domain]} 天` : ''}
                        </span>
                        <span className="w-10 shrink-0 text-center">
                          {s.proto === 'https' && certs[s.domain] !== undefined && (
                            <button
                              type="button"
                              className="rounded px-1 text-xs text-muted-foreground/60 hover:text-foreground disabled:opacity-40"
                              disabled={sslBusy === s.domain}
                              onClick={() => setHTTPS(s.domain, 'renew')}
                            >
                              续期
                            </button>
                          )}
                        </span>
                      </>
                    )}
                    <span className="w-10 shrink-0 text-center">
                      <button
                        type="button"
                        className={cn(
                          'rounded px-1 text-xs',
                          confirmDelSite === s.name
                            ? 'bg-destructive/15 text-destructive'
                            : 'text-muted-foreground/60 hover:text-destructive'
                        )}
                        onClick={() => delSite(s.name)}
                      >
                        {confirmDelSite === s.name ? '确认' : '删除'}
                      </button>
                    </span>
                  </div>
                ))
              )}
              {/* 内联添加表单：就地展开一行，不用弹窗 */}
              {addOpen && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2">
                  <div className="flex gap-1 text-sm">
                    {([
                      ['proxy', '反代'],
                      ['static', '静态']
                    ] as const).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          'rounded px-1.5 py-0.5',
                          siteType === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setSiteType(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder={webTab === 'caddy' ? '域名 https://example.com:443' : '域名 example.com:80'}
                    className={cn('h-7 text-sm', webTab === 'caddy' ? 'w-56' : 'w-44')}
                  />
                  <div className="relative">
                    <Input
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      onFocus={() => setTargetFocus(true)}
                      onBlur={() => setTargetFocus(false)}
                      placeholder={siteType === 'proxy' ? '目标 127.0.0.1:8080' : '目录名 mysite'}
                      autoComplete="off"
                      className="h-7 w-48 font-mono text-sm"
                    />
                    {siteType === 'proxy' && targetFocus && filteredOptions.length > 0 && (
                      <div className="absolute left-0 top-full z-10 mt-1 max-h-40 w-max min-w-full max-w-72 overflow-auto rounded-md border bg-popover py-1 shadow-md">
                        {filteredOptions.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            className="block w-full px-2.5 py-1 text-left font-mono text-sm whitespace-nowrap hover:bg-accent"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              setTarget(o.value)
                              setTargetFocus(false)
                            }}
                          >
                            {o.value}
                            <span className="text-muted-foreground">（{o.name}）</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button size="sm" className="h-7 px-2" disabled={submitting || !domain.trim() || !target.trim()} onClick={submitSite}>
                    {submitting ? '生效中…' : '确认'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setAddOpen(false)}>
                    取消
                  </Button>
                </div>
              )}
            </div>
            <div className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-sm text-muted-foreground">{file}</p>
                {svc && svc.state !== '' && (
                  <span className="flex shrink-0 items-center gap-1">
                    {svc.state !== 'running' && (
                      <span className="text-sm text-muted-foreground">容器状态：{svc.state}</span>
                    )}
                    {svc.state === 'running'
                      ? [svcOpBtn('restart', '重启'), svcOpBtn('stop', '停止'), svcOpBtn('rm', '删除')]
                      : [svcOpBtn('start', '启动'), svcOpBtn('rm', '删除')]}
                  </span>
                )}
              </div>
              {svc && svc.files.length > 0 ? (
                <div className="mt-2 rounded-md bg-muted p-2 font-mono text-sm">
                  {svc.files.map((f, i) => (
                    <div key={f.path}>
                      {i > 0 && <div className="my-2 border-t border-border" />}
                      {/* 路径可点（点击进编辑器改）；原文保持主题色 */}
                      <PathLink
                        sessionId={props.sessionId}
                        path={f.path}
                        className="break-all text-neutral-600 select-text dark:text-neutral-200"
                      />
                      <pre className="break-all whitespace-pre-wrap select-text">{f.content || '（空文件）'}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                info &&
                svc && (
                  <p className="py-2 text-center text-sm text-muted-foreground">
                    {webTab === 'nginx' ? '还没有 .conf 配置文件' : '还没有配置文件'}
                  </p>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** 脚本库的一条脚本。存 localStorage：共享库一个 key（全服务器通用），
    这台服务器的脚本一个 key（带 sessionId，换台机器看不到）。
    interactive=true 的脚本发到面板右侧终端里跑（能看过程能输入），否则后台执行日志区看。 */
interface ScriptItem {
  id: string
  name: string
  remark: string
  content: string
  interactive?: boolean
}

type ScriptScope = 'server' | 'shared'

/** 任务 id 是 t+创建时的 Unix 时间戳，翻译回来就是创建时间；不是这个格式的（老数据）返回空串 */
function cronCreatedAt(id: string): string {
  const m = /^t(\d+)$/.exec(id)
  if (!m) return ''
  const d = new Date(Number(m[1]) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const SCRIPTS_KEY = 'termpilot.scripts'
const serverScriptsKey = (sessionId: string) => `termpilot.scripts.${sessionId}`

function loadScripts(key: string): ScriptItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is ScriptItem =>
        typeof s === 'object' && s !== null &&
        typeof (s as ScriptItem).id === 'string' && typeof (s as ScriptItem).name === 'string' &&
        typeof (s as ScriptItem).content === 'string'
    ).map((s) => ({ id: s.id, name: s.name, remark: s.remark ?? '', content: s.content, interactive: s.interactive }))
  } catch {
    return []
  }
}

/** 脚本页三节：这台服务器的脚本 → 这台服务器的定时任务（crontab）→ 共享脚本库。
    定时任务里面板建的行尾带 # termpilot:<id> 标记可删，用户手写的只读展示。 */
function ScriptSection(props: { sessionId: string; panelTermId: string }) {
  const setNotice = useAppStore((s) => s.setNotice)
  const serverKey = serverScriptsKey(props.sessionId)
  const [serverScripts, setServerScripts] = useState<ScriptItem[]>(() => loadScripts(serverKey))
  const [sharedScripts, setSharedScripts] = useState<ScriptItem[]>(() => loadScripts(SCRIPTS_KEY))
  // 脚本表单：editing 为 null 是新增，否则是编辑那条；formScope 决定表单开在哪一节、存进哪个库
  const [formScope, setFormScope] = useState<ScriptScope>('server')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [fName, setFName] = useState('')
  const [fRemark, setFRemark] = useState('')
  const [fContent, setFContent] = useState('')
  const [confirmDelScript, setConfirmDelScript] = useState<string | null>(null)
  // 运行状态：正在跑的脚本 id + 逐行日志（同安装日志的样子）；
  // lastRun 记最近一次的结果，跑完日志不消失，下次运行才清；runScope 决定日志区落在哪一节
  const [running, setRunning] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<string[]>([])
  const [lastRun, setLastRun] = useState<{ name: string; ok: boolean } | null>(null)
  const [runScope, setRunScope] = useState<ScriptScope>('shared')
  const runLogRef = useRef<HTMLDivElement>(null)
  // 定时任务
  const [cronList, setCronList] = useState<CronEntry[] | null>(null)
  const [taskOpen, setTaskOpen] = useState(false)
  const [tSchedule, setTSchedule] = useState('')
  const [tScript, setTScript] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [confirmDelCron, setConfirmDelCron] = useState<string | null>(null)

  const listOf = (scope: ScriptScope) => (scope === 'server' ? serverScripts : sharedScripts)
  const saveScope = (scope: ScriptScope, next: ScriptItem[]) => {
    if (scope === 'server') {
      setServerScripts(next)
      localStorage.setItem(serverKey, JSON.stringify(next))
    } else {
      setSharedScripts(next)
      localStorage.setItem(SCRIPTS_KEY, JSON.stringify(next))
    }
  }

  const refreshCron = () => {
    void window.api.sessions
      .cronList(props.sessionId)
      .then(setCronList)
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
  }
  useEffect(refreshCron, [props.sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (running === null) return
    return window.api.sessions.onScriptRunProgress(props.sessionId, (line) =>
      setRunLog((cur) => [...cur.slice(-199), line])
    )
  }, [running, props.sessionId])
  useEffect(() => {
    runLogRef.current?.scrollTo(0, runLogRef.current.scrollHeight)
  }, [runLog])

  const openAdd = (scope: ScriptScope) => {
    setFormScope(scope)
    setEditing(null)
    setFName('')
    setFRemark('')
    setFContent('')
    setFormOpen(true)
  }
  const openEdit = (scope: ScriptScope, s: ScriptItem) => {
    setFormScope(scope)
    setEditing(s.id)
    setFName(s.name)
    setFRemark(s.remark)
    setFContent(s.content)
    setFormOpen(true)
  }
  const submitScript = () => {
    const name = fName.trim()
    const content = fContent.trim()
    if (!name || !content) return
    // 交互式开关在列表行上直接拨，表单不管它：编辑时保留原值
    const list = listOf(formScope)
    if (editing) {
      saveScope(formScope, list.map((s) => (s.id === editing ? { ...s, name, remark: fRemark.trim(), content: fContent } : s)))
    } else {
      saveScope(formScope, [...list, { id: `s${Date.now()}`, name, remark: fRemark.trim(), content: fContent }])
    }
    setFormOpen(false)
    setNotice(editing ? '脚本已保存' : '脚本已添加')
  }
  const delScript = (scope: ScriptScope, id: string) => {
    if (confirmDelScript !== id) {
      setConfirmDelScript(id)
      window.setTimeout(() => setConfirmDelScript((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmDelScript(null)
    saveScope(scope, listOf(scope).filter((s) => s.id !== id))
    // 定时任务里引用的是内容快照，删库里的脚本不影响已建任务
  }

  const run = (scope: ScriptScope, s: ScriptItem) => {
    if (s.interactive) {
      // 交互式：落成临时文件再跑（不是 echo|bash 管道——管道会占住 stdin，read 没法用），
      // stdin 留给终端，read/select/apt 确认这些都能正常交互；跑完即删不留痕
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(s.content)))
      window.api.term.input(props.panelTermId, `f=$(mktemp); echo ${b64} | base64 -d > "$f"; bash "$f"; rm -f "$f"\n`)
      setNotice(`${s.name} 已在右侧终端运行`)
      return
    }
    setRunning(s.id)
    setRunScope(scope)
    setRunLog([])
    setLastRun(null)
    setNotice(`正在运行 ${s.name}…`, true)
    void window.api.sessions
      .runScript(props.sessionId, s.content)
      .then(() => {
        setNotice(`${s.name} 执行完成`)
        setLastRun({ name: s.name, ok: true })
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e)
        setNotice(message)
        setLastRun({ name: s.name, ok: false })
        setRunLog((cur) => [...cur, `[失败] ${message}`])
      })
      .finally(() => setRunning(null))
  }

  const addTask = () => {
    const script = [...serverScripts, ...sharedScripts].find((s) => s.id === tScript)
    if (!script || !tSchedule.trim()) return
    setTaskBusy(true)
    void window.api.sessions
      .cronAdd(props.sessionId, tSchedule.trim(), script.content, script.name)
      .then(() => {
        setNotice(`已加定时任务：${script.name}（${tSchedule.trim()}）`)
        setTaskOpen(false)
        setTSchedule('')
        refreshCron()
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setTaskBusy(false))
  }
  const delTask = (id: string) => {
    if (confirmDelCron !== id) {
      setConfirmDelCron(id)
      window.setTimeout(() => setConfirmDelCron((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmDelCron(null)
    void window.api.sessions
      .cronDel(props.sessionId, id)
      .then(() => {
        setNotice('定时任务已删除')
        refreshCron()
      })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
  }

  const scriptRows = (scope: ScriptScope) =>
    listOf(scope).map((s) => (
      <div key={s.id} className="flex items-center gap-2 py-1 text-sm">
        <span className="w-32 shrink-0 truncate">{s.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.remark}</span>
        <Switch
          size="sm"
          checked={s.interactive ?? false}
          onCheckedChange={(v) => saveScope(scope, listOf(scope).map((x) => (x.id === s.id ? { ...x, interactive: v } : x)))}
        />
        <span className="shrink-0 text-xs text-muted-foreground">交互式</span>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" disabled={running !== null} className="rounded px-1 text-xs text-primary/80 hover:text-primary disabled:opacity-40" onClick={() => run(scope, s)}>
            {running === s.id ? '运行中…' : '运行'}
          </button>
          <button type="button" className="rounded px-1 text-xs text-muted-foreground/60 hover:text-foreground" onClick={() => openEdit(scope, s)}>
            编辑
          </button>
          <button
            type="button"
            className={cn('rounded px-1 text-xs', confirmDelScript === s.id ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground/60 hover:text-destructive')}
            onClick={() => delScript(scope, s.id)}
          >
            {confirmDelScript === s.id ? '确认' : '删除'}
          </button>
        </span>
      </div>
    ))

  const scriptForm = (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-border/50 pt-2">
      <div className="flex gap-1.5">
        <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="名称 清理日志" className="h-7 w-40 text-sm" />
        <Input value={fRemark} onChange={(e) => setFRemark(e.target.value)} placeholder="备注（可选）" className="h-7 flex-1 text-sm" />
      </div>
      <textarea
        value={fContent}
        onChange={(e) => setFContent(e.target.value)}
        placeholder={'脚本内容，如：\ndocker system prune -f'}
        rows={4}
        className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
      />
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 px-2" disabled={!fName.trim() || !fContent.trim()} onClick={submitScript}>
          确认
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setFormOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  )

  const logArea = (running !== null || runLog.length > 0) && (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        {lastRun ? (
          <p className={cn('text-xs', lastRun.ok ? 'text-muted-foreground' : 'text-destructive')}>
            上次运行：{lastRun.name} · {lastRun.ok ? '成功' : '失败'}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">运行中…</p>
        )}
        <button
          type="button"
          title="关闭日志"
          className="text-muted-foreground/60 hover:text-foreground"
          onClick={() => {
            setRunLog([])
            setLastRun(null)
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div ref={runLogRef} className="max-h-44 overflow-auto rounded-md bg-muted p-2 font-mono text-sm select-text">
        {runLog.map((line, i) => (
          <div key={i} className="break-all whitespace-pre-wrap">
            {line}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
      {/* 一：这台服务器的脚本 */}
      <div>
        <div className="flex items-center justify-between border-b bg-accent/40 px-3 py-1.5">
          <span className="text-sm text-muted-foreground">脚本（这台服务器）</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-muted-foreground"
            onClick={() => (formOpen && formScope === 'server' ? setFormOpen(false) : openAdd('server'))}
          >
            {formOpen && formScope === 'server' ? '收起' : '+ 添加脚本'}
          </Button>
        </div>
        <div className="px-3 py-2">
          {serverScripts.length === 0 && !(formOpen && formScope === 'server') && (
            <p className="py-1.5 text-sm text-muted-foreground">还没有这台服务器的脚本</p>
          )}
          {scriptRows('server')}
          {formOpen && formScope === 'server' && scriptForm}
          {runScope === 'server' && logArea}
        </div>
      </div>
      {/* 二：定时任务（远端 crontab） */}
      <div className="border-t">
        <div className="flex items-center justify-between bg-accent/40 px-3 py-1.5">
          <span className="text-sm text-muted-foreground">定时任务（这台服务器的 crontab）</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setTaskOpen(!taskOpen)}>
            {taskOpen ? '收起' : '+ 添加任务'}
          </Button>
        </div>
        <div className="max-h-44 overflow-auto px-3 pb-2">
          {cronList === null ? (
            <p className="py-1.5 text-sm text-muted-foreground">读取中…</p>
          ) : cronList.length === 0 ? (
            <p className="py-1.5 text-sm text-muted-foreground">还没有定时任务</p>
          ) : (
            cronList.map((c) => (
              <div key={c.id || `${c.schedule} ${c.command}`} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-32 shrink-0 truncate font-mono">{c.schedule}</span>
                {c.ours && c.name ? (
                  // 面板建的显示脚本名（人话），路径收进 hover
                  <span className="min-w-0 flex-1 truncate" title={c.command}>
                    {c.name}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={c.command}>
                    {c.command}
                  </span>
                )}
                {c.ours && cronCreatedAt(c.id) !== '' && (
                  <span className="shrink-0 text-xs text-muted-foreground/60">创建于 {cronCreatedAt(c.id)}</span>
                )}
                {c.ours ? (
                  <button
                    type="button"
                    className={cn('shrink-0 rounded px-1 text-xs', confirmDelCron === c.id ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground/60 hover:text-destructive')}
                    onClick={() => delTask(c.id)}
                  >
                    {confirmDelCron === c.id ? '确认' : '删除'}
                  </button>
                ) : (
                  <span className="shrink-0 px-1 text-xs text-muted-foreground/40">手写</span>
                )}
              </div>
            ))
          )}
          {taskOpen && (
            <div className="mt-1 flex items-center gap-1.5 border-t border-border/50 pt-2">
              <Select value={tScript} onValueChange={setTScript}>
                <SelectTrigger className="h-7 w-44 text-sm">
                  <SelectValue placeholder="选脚本" />
                </SelectTrigger>
                <SelectContent>
                  {/* 交互式脚本不进 crontab：无人值守没有 stdin，read 会拿空值静默跑错 */}
                  {(() => {
                    const candidates = [...serverScripts, ...sharedScripts].filter((s) => !s.interactive)
                    if (candidates.length === 0) {
                      return (
                        <SelectItem value="__none" disabled>
                          没有可定时运行的脚本
                        </SelectItem>
                      )
                    }
                    return candidates.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))
                  })()}
                </SelectContent>
              </Select>
              <Input value={tSchedule} onChange={(e) => setTSchedule(e.target.value)} placeholder="周期 0 3 * * *" className="h-7 w-40 font-mono text-sm" />
              <Button size="sm" className="h-7 px-2" disabled={taskBusy || !tScript || !tSchedule.trim()} onClick={addTask}>
                {taskBusy ? '添加中…' : '确认'}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setTaskOpen(false)}>
                取消
              </Button>
            </div>
          )}
        </div>
      </div>
      {/* 三：共享脚本库（全服务器通用） */}
      <div className="border-t">
        <div className="flex items-center justify-between bg-accent/40 px-3 py-1.5">
          <span className="text-sm text-muted-foreground">共享脚本（全服务器）</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-muted-foreground"
            onClick={() => (formOpen && formScope === 'shared' ? setFormOpen(false) : openAdd('shared'))}
          >
            {formOpen && formScope === 'shared' ? '收起' : '+ 添加脚本'}
          </Button>
        </div>
        <div className="px-3 py-2">
          {sharedScripts.length === 0 && !(formOpen && formScope === 'shared') && (
            <p className="py-1.5 text-sm text-muted-foreground">还没有共享脚本</p>
          )}
          {scriptRows('shared')}
          {formOpen && formScope === 'shared' && scriptForm}
          {runScope === 'shared' && logArea}
        </div>
      </div>
    </div>
  )
}

/** 文档条目：标题 + 自由文本。内置的打包在代码里，自建和覆盖的存 localStorage。 */
const DOCS_WRAP_KEY = 'termpilot.docs.wrap'

interface CustomDoc {
  id: string
  title: string
  content: string
}

/** 每个文档页一个 store：items = 自建的 + 覆盖内置的（同 id 影子），deleted = 被删掉的内置 id。 */
interface DocStore {
  items: CustomDoc[]
  deleted: string[]
}

function loadDocStore(key: string): DocStore {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}') as unknown
    // 旧版是纯数组（只有自建），兼容一下
    if (Array.isArray(raw)) {
      return {
        items: raw.filter(
          (d): d is CustomDoc =>
            typeof d === 'object' && d !== null &&
            typeof (d as CustomDoc).id === 'string' && typeof (d as CustomDoc).title === 'string' &&
            typeof (d as CustomDoc).content === 'string'
        ),
        deleted: []
      }
    }
    const obj = raw as Partial<DocStore>
    return {
      items: Array.isArray(obj.items) ? obj.items : [],
      deleted: Array.isArray(obj.deleted) ? obj.deleted.filter((d): d is string => typeof d === 'string') : []
    }
  } catch {
    return { items: [], deleted: [] }
  }
}

/** 手册/排查共用的文档页：左目录，右内容；查看/编辑两种模式，按钮在右下角。
    所有条目都能编辑删除：编辑内置的 = 存一份同 id 的覆盖版本（变纯文本），删除内置的 = 进黑名单。 */
function DocSection(props: {
  topics: { id: string; title: string }[]
  customKey: string
  /** 内置条目的纯文本版（进编辑模式时预填；手册是原文，排查是步骤拍平） */
  builtinText: (id: string) => string
  renderBuiltin: (id: string, wrap: boolean) => ReactNode
}) {
  const setNotice = useAppStore((s) => s.setNotice)
  const [store, setStore] = useState<DocStore>(() => loadDocStore(props.customKey))
  const [open, setOpen] = useState<string | null>(props.topics[0]?.id ?? null)
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view')
  // 内容换行开关：手册/排查共用一个键（DOCS_WRAP_KEY），两页状态统一；
  // 长行默认折行，关掉变横向滚动（看宽表格/长命令用）
  const [wrap, setWrapState] = useState(() => localStorage.getItem(DOCS_WRAP_KEY) !== '0')
  const setWrap = (v: boolean) => {
    setWrapState(v)
    localStorage.setItem(DOCS_WRAP_KEY, v ? '1' : '0')
  }
  const [fTitle, setFTitle] = useState('')
  const [fContent, setFContent] = useState('')

  const save = (next: DocStore) => {
    setStore(next)
    localStorage.setItem(props.customKey, JSON.stringify(next))
  }

  // 有效条目：内置的去掉被删的、套上覆盖；id 不撞内置的是纯自建，排在后面
  const override = (id: string) => store.items.find((d) => d.id === id)
  const entries: CustomDoc[] = [
    ...props.topics
      .filter((t) => !store.deleted.includes(t.id))
      .map((t) => override(t.id) ?? { id: t.id, title: t.title, content: '' }),
    ...store.items.filter((d) => !props.topics.some((t) => t.id === d.id))
  ]
  const current = entries.find((e) => e.id === open) ?? null
  const currentIsBuiltin = open !== null && props.topics.some((t) => t.id === open)

  const startNew = () => {
    setOpen(null)
    setFTitle('')
    setFContent('')
    setMode('new')
  }
  const startEdit = (d: CustomDoc) => {
    // 内置的没覆盖过时 content 是空的，进编辑模式用它的纯文本版预填
    setFTitle(d.title)
    setFContent(d.content || props.builtinText(d.id))
    setMode('edit')
  }
  const submit = () => {
    const title = fTitle.trim()
    const content = fContent.trim()
    if (!title || !content) return
    if (mode === 'edit' && current) {
      // 同 id 写回：自建的改自建，内置的存覆盖
      const rest = store.items.filter((c) => c.id !== current.id)
      save({ ...store, items: [...rest, { id: current.id, title, content }] })
      setNotice('已保存')
    } else {
      const id = `d${Date.now()}`
      save({ ...store, items: [...store.items, { id, title, content }] })
      setOpen(id)
      setNotice('已添加')
    }
    setMode('view')
  }
  const del = (d: CustomDoc) => {
    if (currentIsBuiltin) {
      // 内置的进黑名单，连带清掉覆盖版本
      save({ items: store.items.filter((c) => c.id !== d.id), deleted: [...store.deleted, d.id] })
    } else {
      save({ ...store, items: store.items.filter((c) => c.id !== d.id) })
    }
    setOpen(props.topics[0]?.id ?? null)
    setMode('view')
    setNotice('已删除')
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border">
      <div className="w-40 shrink-0 overflow-auto border-r pb-1">
        {entries.map((e) => (
          <ContextMenu key={e.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'block w-full truncate px-3 py-1.5 text-left text-sm',
                  open === e.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setOpen(e.id)
                  setMode('view')
                }}
              >
                {e.title}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => startEdit(e)}>编辑</ContextMenuItem>
              <ContextMenuItem onClick={() => setWrap(!wrap)}>{wrap ? '取消换行' : '自动换行'}</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => del(e)}>
                删除
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <button
          type="button"
          className="block w-full px-3 py-1.5 text-left text-sm text-muted-foreground/60 hover:text-foreground"
          onClick={startNew}
        >
          + 新增
        </button>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {mode !== 'view' ? (
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <Input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="标题" className="h-7 w-64 text-sm" />
            <textarea
              value={fContent}
              onChange={(e) => setFContent(e.target.value)}
              placeholder="内容（纯文本，自己排版）"
              rows={14}
              className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
            />
            <div className="flex gap-1.5">
              <Button size="sm" className="h-7 px-2" disabled={!fTitle.trim() || !fContent.trim()} onClick={submit}>
                保存
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setMode('view')}>
                取消
              </Button>
            </div>
          </div>
        ) : current ? (
          // 覆盖过/自建的显示纯文本；内置未覆盖的走结构化渲染。编辑/删除在目录项右键里
          current.content ? (
            <pre
              className={cn(
                'px-4 py-3 font-mono text-[13px] leading-relaxed select-text',
                wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'
              )}
            >
              {current.content}
            </pre>
          ) : (
            props.renderBuiltin(current.id, wrap)
          )
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">左边选一个，或点 + 新增</p>
        )}
      </div>
    </div>
  )
}

/** 手册页：系统讲透一个主题（内置 + 自建），左目录右内容。 */
function ManualSection() {
  return (
    <DocSection
      topics={MANUAL_TOPICS}
      customKey="termpilot.docs.manual"
      builtinText={(id) => MANUAL_TOPICS.find((x) => x.id === id)?.content ?? ''}
      renderBuiltin={(id, wrap) => {
        const t = MANUAL_TOPICS.find((x) => x.id === id)
        return t ? (
          <pre
            className={cn(
              'px-4 py-3 font-mono text-[13px] leading-relaxed select-text',
              wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'
            )}
          >
            {t.content}
          </pre>
        ) : null
      }}
    />
  )
}

/** 排查页：应急 playbook。内置场景也按纯文本渲染（步骤拍平，编号对齐），
    和手册同一套展示，换行开关两页一致。 */
function TriageSection() {
  const flatten = (id: string) => {
    const sc = TRIAGE_SCENARIOS.find((x) => x.id === id)
    if (!sc) return ''
    return sc.steps.map((st, i) => `${i + 1}. ${st.cmd}\n   ${st.note}`).join('\n\n')
  }
  return (
    <DocSection
      topics={TRIAGE_SCENARIOS}
      customKey="termpilot.docs.triage"
      builtinText={flatten}
      renderBuiltin={(id, wrap) => (
        <pre
          className={cn(
            'px-4 py-3 font-mono text-[13px] leading-relaxed select-text',
            wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'
          )}
        >
          {flatten(id)}
        </pre>
      )}
    />
  )
}

/** 截断文本的悬停提示，替代丑陋的原生 title：主题色浮层、下方弹出、零延迟。
    触发区用 w-fit 收缩到文字本身，浮层锚在文字左下角向右展开；
    只给被截断的文本弹，完整可见时不重复显示（同 TabBar 的 MenuLabel）。 */
function Tip(props: { text: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setTruncated(el.scrollWidth > el.clientWidth + 1)
  }, [props.text])
  const label = (
    <span ref={ref} className="block w-fit max-w-full cursor-default truncate">
      {props.children}
    </span>
  )
  if (!truncated) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
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

/** 信息条一项：弱色标签 + 值。值为空不渲染。truncate 时空间不够就省略号（主机名/内核用），
    不开的项（系统）永远完整显示。 */
function InfoItem(props: { label: string; value: string; truncate?: boolean }) {
  if (!props.value) return null
  return (
    <span className={props.truncate ? 'min-w-0 truncate whitespace-nowrap' : 'shrink-0 whitespace-nowrap'}>
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
