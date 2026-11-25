import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { interpretTotp, totpAt, type TotpAlgorithm, type TotpParams } from '@/lib/totp'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../stores/useAppStore'

const STORAGE_KEY = 'termpilot.tool.totp'

interface SavedTotp {
  id: string
  name: string
  secretText: string
  digits: number
  period: number
  algorithm: TotpAlgorithm
}

function readSaved(): SavedTotp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedTotp[]
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item.secretText !== 'string' || typeof item.id !== 'string') return []
      const checked = interpretTotp(item.secretText)
      if (!checked.params) return []
      const digits = item.digits >= 6 && item.digits <= 8 ? item.digits : checked.params.digits
      const period = item.period >= 1 && item.period <= 300 ? item.period : checked.params.period
      const algorithm = item.algorithm === 'SHA1' || item.algorithm === 'SHA256' || item.algorithm === 'SHA512' ? item.algorithm : checked.params.algorithm
      return [
        {
          id: item.id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '验证码',
          secretText: checked.params.secretText,
          digits,
          period,
          algorithm
        }
      ]
    })
  } catch {
    return []
  }
}

function paramsOf(item: SavedTotp): TotpParams | null {
  const parsed = interpretTotp(item.secretText)
  if (!parsed.params) return null
  return { ...parsed.params, digits: item.digits, period: item.period, algorithm: item.algorithm, label: item.name }
}

function grouped(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`
  return code
}

function Remain({ now, period, large }: { now: number; period: number; large?: boolean }) {
  const elapsed = Math.floor(now / 1000) % period
  const left = period - elapsed
  const radius = 10
  const circ = 2 * Math.PI * radius
  const box = large ? 'size-10' : 'size-8'
  return (
    <div className={cn('relative flex shrink-0 items-center justify-center', box)} title={`剩余 ${left} 秒`}>
      <svg viewBox="0 0 28 28" className={cn('absolute -rotate-90', box)}>
        <circle cx="14" cy="14" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="14"
          cy="14"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={`${(left / period) * circ} ${circ}`}
        />
      </svg>
      <span className={cn('tabular-nums text-muted-foreground', large ? 'text-xs' : 'text-[10px]')}>{left}</span>
    </div>
  )
}

/** 验证码：粘贴密钥或 otpauth 链接，看当前的 6 位码。 */
export function TotpTool() {
  const setNotice = useAppStore((s) => s.setNotice)
  const [secret, setSecret] = useState('')
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<SavedTotp[]>(readSaved)
  const [now, setNow] = useState(() => Date.now())
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [nameFocused, setNameFocused] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const cancelEdit = useRef(false)

  const draft = useMemo(() => interpretTotp(secret), [secret])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  }, [saved])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  const tick = Math.floor(now / 1000)

  useEffect(() => {
    let cancelled = false
    const jobs: [string, TotpParams][] = []
    if (draft.params) jobs.push(['draft', draft.params])
    for (const item of saved) {
      const params = paramsOf(item)
      if (params) jobs.push([item.id, params])
    }
    void Promise.all(jobs.map(async ([id, params]) => [id, await totpAt(params, tick)] as const)).then((rows) => {
      if (cancelled) return
      setCodes(Object.fromEntries(rows))
    })
    return () => {
      cancelled = true
    }
  }, [tick, draft.params, saved])

  const copy = async (id: string, code: string | undefined) => {
    if (!code) return
    await navigator.clipboard.writeText(code)
    setCopied(id)
    setNotice('验证码已复制')
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1500)
  }

  const remember = () => {
    const params = draft.params
    if (!params) return
    const label = name.trim() || params.label || '验证码'
    const existing = saved.find(
      (item) =>
        item.secretText === params.secretText &&
        item.period === params.period &&
        item.digits === params.digits &&
        item.algorithm === params.algorithm
    )
    if (existing) {
      setSaved((current) => current.map((item) => (item.id === existing.id ? { ...item, name: label } : item)))
      setNotice('已经记住')
    } else {
      setSaved((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: label,
          secretText: params.secretText,
          digits: params.digits,
          period: params.period,
          algorithm: params.algorithm
        }
      ])
      setNotice('已记住')
    }
    setSecret('')
    setName('')
  }

  const commitName = (id: string) => {
    const next = editingName.trim()
    setEditingId(null)
    if (!next) return
    setSaved((current) => current.map((item) => (item.id === id ? { ...item, name: next } : item)))
  }

  const codeRow = (id: string, code: string | undefined, period: number) => (
    <div className="flex shrink-0 items-center gap-3">
      <div className="font-mono text-2xl tracking-[0.16em] tabular-nums">{code ? grouped(code) : '······'}</div>
      <Remain now={now} period={period} large />
      <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 gap-1.5 px-3" disabled={!code} onClick={() => void copy(id, code)}>
        {copied === id ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied === id ? '已复制' : '复制'}
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <h2 className="flex h-8 shrink-0 items-center text-base font-medium">2FA 双因素认证码生成器</h2>
        <div className="min-w-0 flex-1">
          <Input
            value={secret}
            placeholder="密钥或 otpauth 链接"
            spellCheck={false}
            className="font-mono text-foreground"
            onChange={(event) => setSecret(event.target.value)}
          />
          {draft.error && <p className="mt-1 text-xs text-destructive">{draft.error}</p>}
        </div>
      </div>
      {draft.params && (
        <div className="flex flex-col gap-3 rounded-md bg-muted px-4 py-3">
          <div className="flex h-14 items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center justify-center gap-4">
              <div className="font-mono text-3xl tracking-[0.22em] tabular-nums">{codes.draft ? grouped(codes.draft) : '······'}</div>
              <Remain now={now} period={draft.params.period} />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5"
              disabled={!codes.draft}
              onClick={() => void copy('draft', codes.draft)}
            >
              {copied === 'draft' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied === 'draft' ? '已复制' : '复制'}
            </Button>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              remember()
            }}
          >
            <Input
              value={name}
              placeholder={draft.params.label || '名称'}
              className="h-8 text-foreground"
              style={{
                backgroundColor: 'var(--background)',
                borderColor: nameFocused ? 'var(--foreground)' : 'transparent',
                boxShadow: 'none'
              }}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" size="sm" className="h-8">
              记住
            </Button>
          </form>
        </div>
      )}
      {saved.length > 0 && (
        <div className="flex flex-col">
          {saved.map((item) => (
            <div key={item.id} className="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
              <div className="flex h-8 min-w-0 flex-1 items-center">
                <Input
                  value={editingId === item.id ? editingName : item.name}
                  readOnly={editingId !== item.id}
                  className="h-8 w-64 shrink-0 cursor-text text-base text-foreground md:text-base"
                  style={{
                    backgroundColor: editingId === item.id ? 'var(--background)' : 'transparent',
                    borderColor: editingId === item.id ? 'var(--foreground)' : 'transparent',
                    boxShadow: 'none'
                  }}
                  onFocus={() => {
                    if (editingId !== item.id) {
                      setEditingId(item.id)
                      setEditingName(item.name)
                    }
                  }}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={() => {
                    if (cancelEdit.current) {
                      cancelEdit.current = false
                      return
                    }
                    commitName(item.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      cancelEdit.current = true
                      setEditingId(null)
                      event.currentTarget.blur()
                    }
                  }}
                />
              </div>
              {codeRow(item.id, codes[item.id], item.period)}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="删除"
                onClick={() => setSaved((current) => current.filter((row) => row.id !== item.id))}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
