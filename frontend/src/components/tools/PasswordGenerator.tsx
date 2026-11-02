import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '../../stores/useAppStore'

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*()-_=+[]{};:,.<>?'
const STORAGE_KEY = 'termpilot.tool.passwordGenerator'

interface Settings {
  lengthInput: string
  upper: boolean
  lower: boolean
  digit: boolean
  symbol: boolean
}

const defaults: Settings = { lengthInput: '16', upper: true, lower: true, digit: true, symbol: true }

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    // 本地数据损坏时回落到默认配置
  }
  return defaults
}

function generate(length: number, upper: boolean, lower: boolean, digit: boolean, symbol: boolean): string {
  const pools: string[] = []
  if (upper) pools.push(UPPER)
  if (lower) pools.push(LOWER)
  if (digit) pools.push(DIGIT)
  if (symbol) pools.push(SYMBOL)
  if (pools.length === 0) return ''
  const all = pools.join('')
  const chars: string[] = []
  for (const pool of pools) chars.push(pool[Math.floor(Math.random() * pool.length)])
  while (chars.length < length) chars.push(all[Math.floor(Math.random() * all.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.slice(0, length).join('')
}

/** 密码生成器：一行工具，生成结果可直接复制。 */
export function PasswordGenerator() {
  const setNotice = useAppStore((s) => s.setNotice)
  const [initial] = useState(readSettings)
  const [lengthInput, setLengthInput] = useState(initial.lengthInput)
  const [upper, setUpper] = useState(initial.upper)
  const [lower, setLower] = useState(initial.lower)
  const [digit, setDigit] = useState(initial.digit)
  const [symbol, setSymbol] = useState(initial.symbol)
  const [password, setPassword] = useState(() =>
    generate(
      Math.min(512, Math.max(1, Number(initial.lengthInput) || 16)),
      initial.upper,
      initial.lower,
      initial.digit,
      initial.symbol
    )
  )
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lengthInput, upper, lower, digit, symbol }))
  }, [lengthInput, upper, lower, digit, symbol])

  const length = () => Math.min(512, Math.max(1, Number(lengthInput) || 16))
  const regenerate = useCallback(() => {
    const value = length()
    setLengthInput(String(value))
    setPassword(generate(value, upper, lower, digit, symbol))
    setCopied(false)
  }, [lengthInput, upper, lower, digit, symbol])

  const copy = async () => {
    if (!password) return
    await navigator.clipboard.writeText(password)
    setCopied(true)
    setNotice('密码已复制')
    window.setTimeout(() => setCopied(false), 1500)
  }

  const option = (label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-length" className="text-xs text-muted-foreground">
            长度
          </Label>
          <Input
            id="pw-length"
            type="number"
            min={1}
            max={512}
            value={lengthInput}
            onChange={(e) => setLengthInput(e.target.value)}
            onBlur={() => setLengthInput(String(length()))}
            className="h-8 w-20"
          />
        </div>
        <div className="flex flex-wrap items-center gap-4 pb-1">
          {option('大写', upper, setUpper)}
          {option('小写', lower, setLower)}
          {option('数字', digit, setDigit)}
          {option('符号', symbol, setSymbol)}
        </div>
        <Button type="button" size="sm" className="h-8 gap-1.5" onClick={regenerate}>
          <RefreshCw className="size-3.5" />
          重新生成
        </Button>
      </div>
      <div className="flex items-start gap-2">
        <div className="min-h-9 min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all text-foreground">
          {password || '至少选择一种字符类型'}
        </div>
        <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 gap-1.5" disabled={!password} onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
    </div>
  )
}
