import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, ScrollText, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { MCP_DEFAULT_PORT, MCP_HOST, type McpAuditEntry, type McpSettingsInput } from '../../../shared/types'
import { useAppStore } from '../stores/useAppStore'

type Pane = 'mcp' | 'audit'

const panes: { id: Pane; label: string; icon: typeof Server }[] = [
  { id: 'mcp', label: 'MCP 服务', icon: Server },
  { id: 'audit', label: '调用记录', icon: ScrollText }
]

const empty = (): McpSettingsInput => ({
  enabled: false,
  port: MCP_DEFAULT_PORT,
  token: '',
  confirmDangerous: true
})

/** 设置：左侧栏目，右侧是当前项。 */
export function SettingsPage() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const mcp = useAppStore((s) => s.mcp)
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const loadMcp = useAppStore((s) => s.loadMcp)
  const saveMcp = useAppStore((s) => s.saveMcp)
  const runtime = useAppStore((s) => s.mcpRuntime)

  const [pane, setPane] = useState<Pane>('mcp')
  const [form, setForm] = useState<McpSettingsInput>(empty)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [audit, setAudit] = useState<McpAuditEntry[]>([])
  const [themeError, setThemeError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setCopied(null)
    setShowToken(false)
    setThemeError('')
    setPane('mcp')
    void loadMcp().catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void window.api.mcp.audit().then(setAudit).catch(() => setAudit([]))
  }, [open, loadMcp])

  useEffect(() => {
    if (!open || !mcp) return
    setForm({
      enabled: mcp.enabled,
      port: mcp.port,
      token: mcp.token,
      confirmDangerous: mcp.confirmDangerous
    })
  }, [open, mcp])

  const endpoint = `http://${MCP_HOST}:${form.port || 0}/mcp`

  const copy = async (kind: 'endpoint' | 'token', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      window.setTimeout(() => setCopied((cur) => (cur === kind ? null : cur)), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '复制失败')
    }
  }

  const regenerate = () => {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    const token = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    setForm((f) => ({ ...f, token }))
  }

  const persist = async (): Promise<boolean> => {
    if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) {
      setError('端口需要在 1–65535')
      return false
    }
    if (form.token.trim().length < 16) {
      setError('令牌至少 16 位')
      return false
    }
    try {
      await saveMcp(form)
      setError('')
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  const changeAppearance = async (patch: Parameters<typeof setAppearance>[0]) => {
    setThemeError('')
    try {
      await setAppearance(patch)
    } catch (e) {
      setThemeError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-medium">设置</h1>
          <button
            type="button"
            title="关闭"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
        <nav className="flex gap-1">
          {panes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
                pane === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted-foreground/10'
              )}
              onClick={() => {
                setPane(item.id)
                setError('')
                setThemeError('')
              }}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0">
            {pane === 'mcp' && (
              <section className="grid gap-4">
                <div>
                  <h2 className="text-base font-medium">MCP 服务</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    只监听 {MCP_HOST}，Agent 必须带 Bearer 令牌。
                    {runtime.running
                      ? ` 正在监听 ${MCP_HOST}:${runtime.port}${runtime.clients > 0 ? `，${runtime.clients} 个客户端` : ''}。`
                      : runtime.error
                        ? ` ${runtime.error}`
                        : ' 当前没有监听。'}
                  </p>
                </div>

                <Card>
                  <Row
                    title={
                      <span className="inline-flex items-center gap-2">
                        合成算法
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                          实验性算法
                        </span>
                      </span>
                    }
                    detail="打开后，当前画面、滚动缓冲、选中的行，以及助手发起的截图，都按缓冲拼成图片，不滚动正在看的画面。关闭后改为逐屏拍摄。拨动立刻生效。"
                  >
                    <Switch
                      checked={appearance.experimentalScreenshot}
                      onCheckedChange={(experimentalScreenshot) =>
                        void changeAppearance({ experimentalScreenshot })
                      }
                    />
                  </Row>
                </Card>
                {themeError && <p className="text-xs text-destructive">{themeError}</p>}

                <Card>
                  <Row
                    title="启用"
                    detail={`保存后立刻在 ${MCP_HOST} 监听。关掉再保存就停止。`}
                  >
                    <Switch
                      checked={form.enabled}
                      onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
                    />
                  </Row>
                  <Row title="危险操作需确认" detail="Agent 删除文件或写入系统路径时先弹窗。">
                    <Switch
                      checked={form.confirmDangerous}
                      onCheckedChange={(confirmDangerous) => setForm((f) => ({ ...f, confirmDangerous }))}
                    />
                  </Row>
                </Card>

                <Card>
                  <div className="grid gap-3 px-4 py-3">
                    <div className="grid grid-cols-[1fr_6rem] gap-2">
                      <Field label="监听地址">
                        <Input value={MCP_HOST} readOnly />
                      </Field>
                      <Field label="端口">
                        <Input
                          type="number"
                          value={form.port}
                          onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) || 0 }))}
                        />
                      </Field>
                    </div>
                    <Field label="端点">
                      <div className="flex gap-2">
                        <Input className="min-w-0 flex-1" value={endpoint} readOnly />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="复制端点"
                          onClick={() => copy('endpoint', endpoint)}
                        >
                          {copied === 'endpoint' ? <Check /> : <Copy />}
                        </Button>
                      </div>
                    </Field>
                    <Field label="Bearer 令牌">
                      <div className="flex gap-2">
                        <Input
                          className="min-w-0 flex-1"
                          type={showToken ? 'text' : 'password'}
                          value={form.token}
                          onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                        />
                        <Button type="button" variant="outline" size="sm" onClick={() => setShowToken((v) => !v)}>
                          {showToken ? '隐藏' : '显示'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="复制令牌"
                          onClick={() => copy('token', form.token)}
                        >
                          {copied === 'token' ? <Check /> : <Copy />}
                        </Button>
                        <Button type="button" variant="outline" size="icon" title="重新生成" onClick={regenerate}>
                          <RefreshCw />
                        </Button>
                      </div>
                    </Field>
                  </div>
                </Card>

                {error && <p className="text-xs text-destructive">{error}</p>}
                <div className="flex justify-end">
                  <Button onClick={() => void persist()}>保存</Button>
                </div>
              </section>
            )}

            {pane === 'audit' && (
              <section className="grid gap-4">
                <div>
                  <h2 className="text-base font-medium">调用记录</h2>
                  <p className="mt-1 text-xs text-muted-foreground">最近的 MCP 工具调用，失败的会标出来。</p>
                </div>
                <div className="max-h-[28rem] overflow-auto rounded-xl border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {audit.length === 0 && <p className="text-muted-foreground">还没有记录</p>}
                  {audit.map((row, index) => (
                    <p key={`${row.at}-${index}`} className={row.ok ? '' : 'text-destructive'}>
                      {new Date(row.at).toLocaleString()} {row.ok ? '成功' : '失败'} {row.tool}
                      {row.detail ? ` ${row.detail}` : ''}
                    </p>
                  ))}
                </div>
              </section>
            )}
        </div>
      </div>
    </div>
  )
}

function Card(props: { children: React.ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl border">{props.children}</div>
}

function Row(props: { title: React.ReactNode; detail: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm">{props.title}</div>
        <div className="truncate text-xs text-muted-foreground" title={props.detail}>
          {props.detail}
        </div>
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  )
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <Label className="grid gap-1 text-xs text-muted-foreground">
      {props.label}
      {props.children}
    </Label>
  )
}
