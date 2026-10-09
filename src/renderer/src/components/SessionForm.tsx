import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppStore } from '../stores/useAppStore'
import type { ForwardRule, ForwardType, SessionInput } from '../../../shared/types'

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

/** 新建 / 编辑连接。表单控件全部来自 shadcn。认证只用密码。 */
export function SessionForm() {
  const editing = useAppStore((s) => s.editing)
  const setEditing = useAppStore((s) => s.setEditing)
  const saveSession = useAppStore((s) => s.saveSession)

  const creating = editing?.action === 'create'
  const session = editing?.action === 'edit' ? editing.session : null
  const lockedHost = creating && editing.host ? editing.host : ''

  const [form, setForm] = useState(empty())
  const [forwards, setForwards] = useState<ForwardDraft[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!editing) return
    if (editing.action === 'edit') {
      const s = editing.session
      setForm({
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        secret: ''
      })
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
    setError('')
  }, [editing])

  const set = <K extends keyof ReturnType<typeof empty>>(k: K, v: ReturnType<typeof empty>[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const setRule = (index: number, patch: Partial<ForwardDraft>) =>
    setForwards((list) => list.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))

  /** 全空的规则直接丢弃；非空的校验两个端口。返回 null 表示校验失败，错误已写好。 */
  const collectForwards = (): ForwardRule[] | null => {
    const rules: ForwardRule[] = []
    for (let i = 0; i < forwards.length; i++) {
      const draft = forwards[i]!
      if (!draft.localPort.trim() && !draft.remotePort.trim()) continue
      const localPort = Number(draft.localPort)
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        setError(`端口映射第 ${i + 1} 条：本地端口需要在 1–65535`)
        return null
      }
      const remotePort = Number(draft.remotePort)
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        setError(`端口映射第 ${i + 1} 条：远程端口需要在 1–65535`)
        return null
      }
      // 数据模型按监听/目标存：本地转发听本机，远程转发听服务器
      rules.push(
        draft.type === 'local'
          ? { type: 'local', listenPort: localPort, targetPort: remotePort }
          : { type: 'remote', listenPort: remotePort, targetPort: localPort }
      )
    }
    return rules
  }

  const submit = async () => {
    const name = form.name.trim()
    const host = lockedHost || form.host.trim()
    const username = form.username.trim()
    if (!name) {
      setError('标签不能为空')
      return
    }
    if (!host) {
      setError('主机不能为空')
      return
    }
    if (!username) {
      setError('用户名不能为空')
      return
    }
    if (creating && !form.secret) {
      setError('新建连接需要填写密码')
      return
    }
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
    try {
      await saveSession(creating ? null : session!.id, patch)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {lockedHost ? `在 ${lockedHost} 上新建连接` : creating ? '新建连接' : '编辑连接'}
          </DialogTitle>
          <DialogDescription>
            {lockedHost
              ? '主机已经确定，只要填写这条连接的账号。'
              : '本机作为客户端，主动 SSH 到有地址的服务器。'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className={lockedHost ? '' : 'grid grid-cols-[1fr_6rem] gap-2'}>
            {!lockedHost && (
              <Field label="主机">
                <Input
                  value={form.host}
                  placeholder="IP 或域名"
                  onChange={(e) => set('host', e.target.value)}
                />
              </Field>
            )}
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
            <Input
              type="password"
              value={form.secret}
              placeholder={creating ? '' : '留空则不修改'}
              onChange={(e) => set('secret', e.target.value)}
            />
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
                  onClick={() => setForwards((list) => list.filter((_, i) => i !== index))}
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
            onClick={() => setForwards((list) => [...list, emptyRule()])}
          >
            <Plus className="size-3.5" />
            添加端口映射
          </button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button onClick={submit}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
