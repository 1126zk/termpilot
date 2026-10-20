import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRightToLine,
  ArrowUp,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Plus,
  Tag,
  User,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useAppStore, type EditingState } from '../stores/useAppStore'
import type { ForwardRule, ForwardType, SessionConfig, SessionInput } from '../../../shared/types'
import type { SshHopInput } from '../../../shared/ssh-options'

const empty = () => ({
  name: '',
  host: '',
  port: 22,
  username: '',
  secret: '',
  useKey: false
})

/** 表单里端口先用字符串存，空值留着，保存时再校验转换。左边永远是本机，右边永远是服务器。 */
interface ForwardDraft {
  type: ForwardType
  localPort: string
  remotePort: string
}

interface JumpDraft {
  id: number
  host: string
  port: number
  username: string
  secret: string
  hasSecret?: boolean
  showSecret: boolean
}

const newJumpDraft = (id: number): JumpDraft => ({
  id,
  host: '',
  port: 22,
  username: '',
  secret: '',
  showSecret: false
})

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
  const [jumps, setJumps] = useState<JumpDraft[]>([])
  const [showSecret, setShowSecret] = useState(false)
  const nextJumpID = useRef(1)
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
        secret: '',
        useKey: Boolean(s.useKey)
      })
      setJumps(
        (s.jumps ?? []).map((hop) => ({
          id: nextJumpID.current++,
          host: hop.host,
          port: hop.port,
          username: hop.username,
          secret: '',
          hasSecret: hop.hasSecret,
          showSecret: false
        }))
      )
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
      setJumps([])
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

  const setJump = (id: number, patch: Partial<JumpDraft>, persist = true) => {
    if (persist) dirty.current = true
    setJumps((list) => list.map((jump) => (jump.id === id ? { ...jump, ...patch } : jump)))
  }

  const addJump = () => {
    dirty.current = true
    const id = nextJumpID.current++
    setJumps((list) => [...list, newJumpDraft(id)])
  }

  const moveJump = (id: number, offset: -1 | 1) => {
    dirty.current = true
    setJumps((list) => {
      const from = list.findIndex((jump) => jump.id === id)
      const to = from + offset
      if (from < 0 || to < 0 || to >= list.length) return list
      const next = [...list]
      const [jump] = next.splice(from, 1)
      next.splice(to, 0, jump)
      return next
    })
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

  const collectJumps = (): SshHopInput[] | null => {
    const collected: SshHopInput[] = []
    for (const draft of jumps) {
      const host = draft.host.trim()
      const username = draft.username.trim()
      if (!host && !username && !draft.secret) continue
      if (!host || !username || !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) return null
      collected.push({ host, port: draft.port, username, secret: draft.secret || undefined })
    }
    return collected
  }

  const autosave = async () => {
    if (!editing) return
    const name = form.name.trim()
    const host = form.host.trim()
    const username = form.username.trim()
    if (!name || !host || !username) return
    const rules = collectForwards()
    if (!rules) return
    const nextJumps = collectJumps()
    if (!nextJumps) return
    const patch: SessionInput = {
      name,
      group: '',
      host,
      port: form.port,
      username,
      secret: form.useKey ? '' : form.secret ? form.secret : undefined,
      useKey: form.useKey,
      jumps: nextJumps,
      sshOptions: creating ? null : undefined,
      forwards: rules
    }
    if (session) {
      dirty.current = false
      await window.api.sessions.update(session.id, patch).catch(() => undefined)
      await loadSessions()
      return
    }
    // 新建：密码登录要等密码。密钥登录和 ssh 用户名@主机一样，不另指定私钥
    if (creatingRef.current) return
    if (!form.useKey && !form.secret) return
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
  }, [form, forwards, jumps])

  const connect = () => {
    if (!session) return
    // 每次都新开一扇终端，不复用已打开的
    openSessionTab(session, true)
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
        <div className="grid gap-4 px-3 py-4">
          <div className="grid grid-cols-[1fr_6rem] gap-2.5">
            <IconInput
              icon={<Globe />}
              value={form.host}
              placeholder="IP 或主机名"
              onChange={(e) => set('host', e.target.value)}
            />
            <Input
              className="h-10"
              type="number"
              placeholder="22"
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value) || 22)}
            />
          </div>
          <IconInput
            icon={<Tag />}
            value={form.name}
            placeholder="标签"
            onChange={(e) => set('name', e.target.value)}
          />
          <IconInput
            icon={<User />}
            value={form.username}
            placeholder="用户名"
            onChange={(e) => set('username', e.target.value)}
          />
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
              <KeyRound />
            </span>
            <Input
              className="h-10 pr-16 pl-8"
              type={showSecret ? 'text' : 'password'}
              value={form.secret}
              placeholder="密码"
              disabled={form.useKey}
              onChange={(e) => set('secret', e.target.value)}
            />
            <button
              type="button"
              title={form.useKey ? '改用密码' : '用密钥登录'}
              className={cn(
                'absolute top-1/2 right-8 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground',
                form.useKey && 'text-primary hover:text-primary'
              )}
              onClick={() => {
                dirty.current = true
                setForm((f) => ({ ...f, useKey: !f.useKey, secret: f.useKey ? f.secret : '' }))
              }}
            >
              <KeyRound className="size-4" />
            </button>
            <button
              type="button"
              title={showSecret ? '隐藏密码' : '显示密码'}
              className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

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
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
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

          <div className="grid gap-2.5">
            {jumps.length > 0 && (
              <p className="text-xs text-muted-foreground">按本机 → 第 1 跳 → 第 2 跳 → 目标主机的顺序排列</p>
            )}

            {jumps.map((jump, index) => (
              <div key={jump.id} className="grid gap-2.5 rounded-lg bg-muted/45 p-2.5">
                <div className="flex h-6 items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">第 {index + 1} 跳</p>
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      title="上移"
                      disabled={index === 0}
                      onClick={() => moveJump(jump.id, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      title="下移"
                      disabled={index === jumps.length - 1}
                      onClick={() => moveJump(jump.id, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      title="删除这一跳"
                      onClick={() => {
                        dirty.current = true
                        setJumps((list) => list.filter((item) => item.id !== jump.id))
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_5rem] gap-2">
                  <IconInput
                    icon={<Globe />}
                    value={jump.host}
                    placeholder="跳板主机"
                    onChange={(e) => setJump(jump.id, { host: e.target.value })}
                  />
                  <Input
                    className="h-10"
                    type="number"
                    placeholder="22"
                    value={jump.port}
                    onChange={(e) => setJump(jump.id, { port: Number(e.target.value) || 22 })}
                  />
                </div>
                <IconInput
                  icon={<User />}
                  value={jump.username}
                  placeholder="跳板用户名"
                  onChange={(e) => setJump(jump.id, { username: e.target.value })}
                />
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
                    <KeyRound />
                  </span>
                  <Input
                    className="h-10 pr-9 pl-8"
                    type={jump.showSecret ? 'text' : 'password'}
                    value={jump.secret}
                    placeholder={jump.hasSecret ? '留空则不修改' : '跳板密码'}
                    onChange={(e) => setJump(jump.id, { secret: e.target.value })}
                  />
                  <button
                    type="button"
                    title={jump.showSecret ? '隐藏密码' : '显示密码'}
                    className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                    onClick={() => setJump(jump.id, { showSecret: !jump.showSecret }, false)}
                  >
                    {jump.showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-muted text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              onClick={addJump}
            >
              <Plus className="size-3.5" />
              添加跳板机
            </button>
          </div>
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

/** 输入框内嵌图标：图标在左，placeholder 是字段名，不再要上面的文字标签 */
function IconInput(props: React.ComponentProps<typeof Input> & { icon: React.ReactNode }) {
  const { icon, className, ...rest } = props
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <Input className={cn('h-10 pl-8', className)} {...rest} />
    </div>
  )
}
