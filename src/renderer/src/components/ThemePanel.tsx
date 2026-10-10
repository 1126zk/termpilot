import { useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { TERMINAL_FONTS, UNIFIED_THEMES, type UnifiedTheme } from '../../../shared/types'
import { useAppStore } from '../stores/useAppStore'
import { terminalPalette } from '../theme/terminalThemes'

/** 主题板块：终端字体、字号，以及应用明暗 + 终端配色绑好的统一主题。改完立刻生效。 */
export function ThemePanel() {
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)

  const change = (patch: Parameters<typeof setAppearance>[0]) => {
    void setAppearance(patch).catch(() => undefined)
  }

  const resize = (delta: number) => {
    const next = Math.min(24, Math.max(10, appearance.terminalSize + delta))
    if (next !== appearance.terminalSize) change({ terminalSize: next })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-4 px-3 pt-3">
        <section className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">字体</p>
          <Select value={appearance.terminalFont} onValueChange={(terminalFont) => change({ terminalFont })}>
            <SelectTrigger className="w-44 text-muted-foreground [&_svg]:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONTS.map((font) => (
                <SelectItem key={font} value={font}>
                  {font}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        <section className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">字号</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-primary disabled:opacity-40"
              title="减小字号"
              disabled={appearance.terminalSize <= 10}
              onClick={() => resize(-1)}
            >
              <Minus className="size-3.5" />
            </button>
            <SizeInput
              value={appearance.terminalSize}
              onCommit={(size) => {
                if (size !== appearance.terminalSize) change({ terminalSize: size })
              }}
            />
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-primary disabled:opacity-40"
              title="增大字号"
              disabled={appearance.terminalSize >= 24}
              onClick={() => resize(1)}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        </section>
      </div>

      {/* 只有主题列表自己滚动，滑块因此细小 */}
      <p className="px-3 pt-4 pb-1.5 text-xs text-muted-foreground">主题</p>
      <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
        <div className="grid gap-1.5">
          {UNIFIED_THEMES.map((item) => (
            <ThemeCard
              key={item.id}
              item={item}
              selected={appearance.theme === item.id}
              onSelect={() => change({ theme: item.id })}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

/** 字号输入框：可直接输入，回车或失焦时按 10–24 结算；无效输入还原。 */
function SizeInput(props: { value: number; onCommit: (size: number) => void }) {
  const [draft, setDraft] = useState(String(props.value))
  useEffect(() => setDraft(String(props.value)), [props.value])

  const commit = () => {
    const parsed = Number(draft)
    if (Number.isInteger(parsed) && parsed >= 10 && parsed <= 24) {
      props.onCommit(parsed)
    } else {
      setDraft(String(props.value))
    }
  }

  return (
    <input
      className="h-7 w-11 rounded-md border border-muted-foreground/20 bg-transparent text-center text-sm tabular-nums text-muted-foreground shadow-none outline-none hover:text-primary"
      value={draft}
      inputMode="numeric"
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}

/** 一行统一主题：迷你终端预览卡（三行彩条模拟代码行）+ 主题名。悬停时卡片底部露出一排调色板小色块。 */
function ThemeCard(props: { item: UnifiedTheme; selected: boolean; onSelect: () => void }) {
  const theme = terminalPalette(props.item.terminal).theme
  return (
    <button
      type="button"
      className={cn(
        'group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground',
        props.selected && 'border-foreground/40 text-foreground ring-1 ring-foreground/20'
      )}
      onClick={props.onSelect}
    >
      <span
        className="relative flex h-11 w-16 shrink-0 flex-col justify-center gap-1 overflow-hidden rounded-md border border-foreground/10 px-1.5"
        style={{ background: theme.background }}
      >
        <span className="h-1 w-[88%] rounded-sm" style={{ background: theme.foreground }} />
        <span className="h-1 w-[55%] rounded-sm" style={{ background: theme.foreground, opacity: 0.75 }} />
        <span className="flex gap-1">
          <span className="h-1 w-[26%] rounded-sm" style={{ background: theme.green }} />
          <span className="h-1 w-[12%] rounded-sm" style={{ background: theme.foreground, opacity: 0.6 }} />
          <span className="h-1 w-[7%] rounded-sm" style={{ background: theme.blue }} />
        </span>
        {/* 悬停时从底部滑上来的调色板，移出滑回 */}
        <span className="absolute inset-x-0 bottom-0 flex translate-y-full transition-transform duration-200 group-hover:translate-y-0">
          {[theme.red, theme.yellow, theme.green, theme.blue, theme.magenta, theme.cyan].map((color) => (
            <span key={color} className="h-1.5 flex-1" style={{ background: color }} />
          ))}
        </span>
      </span>
      <span className="font-semibold">{props.item.label}</span>
    </button>
  )
}
