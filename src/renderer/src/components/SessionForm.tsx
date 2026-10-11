import { useEffect, useRef, useState } from 'react'
import { ArrowRightToLine, Eye, EyeOff, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppStore, type EditingState } from '../stores/useAppStore'
import type { ForwardRule, ForwardType, SessionConfig, SessionInput } from '../../../shared/types'

const empty = () => ({
  name: '',
  host: '',
  port: 22,
  username: '',
  secret: ''
})

/** 表单里端口先用字符串存，空值留着，保存时再校验转换。左边永远是本机，右边永远是服务器。 */
interface ForwardDraft {
  type: ForwardType
  localPort: string
  remotePort: string
}

const emptyRule = (): ForwardDraft => ({
  type: 'local',
  localPort: '',
  remotePort: ''
})

const ruleHint: Record<ForwardType, string> = {
  local: '访问本机的本地端口 = 访问服务器的远程端口',
  remote: '访问服务器的远程端口 = 回本机的本地端口'
}

/**
 * 新建 / 编辑主机，在右侧面板里展示。没有保存按钮：
 * 改动 600ms 防抖自动入库（字段没齐就静默等着）；字段齐了的第一次保存把
 * 新建面板切成编辑（editing 换成 {action:'edit'}），之后改动走 update。
 */
export function SessionFormPanel(props: { frozen?: EditingState }) {
  const liveEditing = useAppStore((s) => s.editing)
  // 面板收起动画期间 store 已清空，用冻结的最后一份表单把内容撑到动画结束
  const editing = liveEditing ?? props.frozen ?? null
  const setEditing = useAppStore((s) => s.setEditing)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const openSessionTab = useAppStore((s) => s.openSessionTab)

  const creating = editing?.action !== 'edit'
  const session = editing?.action === 'edit' ? editing.session : null

  const [form, setForm] = useState(empty())
  const [forwards, setForwards] = useState<ForwardDraft[]>([])
  const [showSecret, setShowSecret] = useState(false)
  /** 用户改过才自动保存。初始化填充（含 revealSecret 回填）不算脏 */
  const dirty = useRef(false)
  /** create 在飞时不要并发再建 */
  const creatingRef = useRef(false)
  /** 自动建出来的记录切换成编辑时，跳过那次初始化（表单里已经是这些值） */
  const skipInit = useRef<string | null>(null)

  // 初始化只在编辑对象的身份（id / 新建）变化时做：sessions 刷新会让 editing.session
  // 换成新对象，不能因此重跑初始化把用户正在打的字冲掉
  const editKey = !editing ? null : editing.action === 'edit' ? `edit:${editing.session.id}` : 'create'
  useEffect(() => {
    if (!editing || !editKey) return
    if (skipInit.current === editKey) {
      skipInit.current = null
      return
    }
    dirty.current = false
    setShowSecret(false)
    if (editing.action === 'edit') {
      const s = editing.session
      setForm({
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        secret: ''
      })
      // 编辑时把已存的密码填进密码框，可查看可复制。回填不标脏，不会触发自动保存
      void window.api.sessions
        .revealSecret(s.id)
        .then((secret) => setForm((f) => ({ ...f, secret: secret ?? '' })))
        .catch(() => undefined)
      setForwards(
        (s.forwards ?? []).map((rule) => ({
          type: rule.type,
          localPort: String(rule.type === 'local' ? rule.listenPort : rule.targetPort),
          remotePort: String(rule.type === 'local' ? rule.targetPort : rule.listenPort)
        }))
      )
    } else {
      setForm({
        ...empty(),
        host: editing.host ?? '',
        port: editing.port ?? 22
      })
      setForwards([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey])

  const set = <K extends keyof ReturnType<typeof empty>>(k: K, v: ReturnType<typeof empty>[K]) => {
    dirty.current = true
    setForm((f) => ({ ...f, [k]: v }))
  }

  const setRule = (index: number, patch: Partial<ForwardDraft>) => {
    dirty.current = true
    setForwards((list) => list.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }

  /** 全空的规则直接丢弃；任何一条端口不合法就整体跳过这次保存（静默，等用户继续改） */
  const collectForwards = (): ForwardRule[] | null => {
    const rules: ForwardRule[] = []
    for (const draft of forwards) {
      if (!draft.localPort.trim() && !draft.remotePort.trim()) continue
      const localPort = Number(draft.localPort)
      const remotePort = Number(draft.remotePort)
      const valid = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535
      if (!valid(localPort) || !valid(remotePort)) return null
      // 数据模型按监听/目标存：本地转发听本机，远程转发听服务器
      rules.push(
        draft.type === 'local'
          ? { type: 'local', listenPort: localPort, targetPort: remotePort }
          : { type: 'remote', listenPort: remotePort, targetPort: localPort }
      )
    }
    return rules
  }

  const autosave = async () => {
    if (!editing) return
    const name = form.name.trim()
    const host = form.host.trim()
    const username = form.username.trim()
    if (!name || !host || !username) return
    const rules = collectForwards()
    if (!rules) return
    // 编辑时跳板、备注、sshOptions 传 undefined，保持原值，不清掉老数据
    const patch: SessionInput = {
      name,
      group: '',
      host,
      port: form.port,
      username,
      secret: form.secret ? form.secret : undefined,
      jumpHost: creating ? '' : undefined,
      sshOptions: creating ? null : undefined,
      forwards: rules
    }
    if (session) {
      dirty.current = false
      await window.api.sessions.update(session.id, patch).catch(() => undefined)
      await loadSessions()
      return
    }
    // 新建：密码没填不建记录，等用户继续填
    if (!form.secret || creatingRef.current) return
    creatingRef.current = true
    try {
      const created = (await window.api.sessions.create(patch)) as SessionConfig
      dirty.current = false
      // 切成编辑模式。表单里已经是这些值，跳过紧接着的那次初始化
      skipInit.current = `edit:${created.id}`
      setEditing({ action: 'edit', session: created })
      await loadSessions()
    } catch {
      /* 建失败就等下一次改动再试 */
    } finally {
      creatingRef.current = false
    }
  }

  // 任何字段改动后 600ms 防抖自动保存；表单再动就重置计时
  useEffect(() => {
    if (!dirty.current) return
    const timer = setTimeout(() => void autosave(), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, forwards])

  const connect = () => {
    if (!session) return
    openSessionTab(session)
    setEditing(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <p className="text-[13px] font-medium text-muted-foreground">{creating ? '新建主机' : '主机信息'}</p>
        <button
          type="button"
          title="关闭"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
          onClick={() => setEditing(null)}
        >
          <ArrowRightToLine className="size-4" />
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-3 px-3 py-3">
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="主机">
              <Input value={form.host} placeholder="IP 或域名" onChange={(e) => set('host', e.target.value)} />
            </Field>
            <Field label="端口">
              <Input
                type="number"
                value={form.port}
                onChange={(e) => set('port', Number(e.target.value) || 22)}
              />
            </Field>
          </div>
          <Field label="标签">
            <Input
              value={form.name}
              placeholder="给这条连接取的名字"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="用户名">
            <Input value={form.username} onChange={(e) => set('username', e.target.value)} />
          </Field>
          <Field label="密码">
            <div className="flex gap-1.5">
              <Input
                type={showSecret ? 'text' : 'password'}
                value={form.secret}
                onChange={(e) => set('secret', e.target.value)}
              />
              <button
                type="button"
                title={showSecret ? '隐藏密码' : '显示密码'}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                onClick={() => setShowSecret((v) => !v)}
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>

          {forwards.map((rule, index) => (
            <div key={index} className="grid gap-1">
              <div className="flex items-center gap-1.5">
                <Select
                  value={rule.type}
                  onValueChange={(value) => setRule(index, { type: value as ForwardType })}
                >
                  <SelectTrigger className="h-8 w-24 shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">本地转发</SelectItem>
                    <SelectItem value="remote">远程转发</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 min-w-0 flex-1 text-xs"
                  type="number"
                  placeholder="本地端口"
                  value={rule.localPort}
                  onChange={(e) => setRule(index, { localPort: e.target.value })}
                />
                <Input
                  className="h-8 min-w-0 flex-1 text-xs"
                  type="number"
                  placeholder="远程端口"
                  value={rule.remotePort}
                  onChange={(e) => setRule(index, { remotePort: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  title="删除这条映射"
                  onClick={() => {
                    dirty.current = true
                    setForwards((list) => list.filter((_, i) => i !== index))
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{ruleHint[rule.type]}</p>
            </div>
          ))}
          <button
            type="button"
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-muted text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            onClick={() => {
              dirty.current = true
              setForwards((list) => [...list, emptyRule()])
            }}
          >
            <Plus className="size-3.5" />
            添加端口映射
          </button>
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t p-3">
        <button
          type="button"
          disabled={!session}
          className="h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground transition hover:brightness-125 disabled:opacity-40"
          onClick={connect}
        >
          连接
        </button>
      </div>
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
