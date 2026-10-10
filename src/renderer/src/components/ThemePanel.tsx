import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid gap-4 px-3 py-3">
        <section className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">字体</p>
          <Select value={appearance.terminalFont} onValueChange={(terminalFont) => change({ terminalFont })}>
            <SelectTrigger className="w-full">
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

        <section className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">字号</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              title="减小字号"
              disabled={appearance.terminalSize <= 10}
              onClick={() => resize(-1)}
            >
              <Minus />
            </Button>
            <span className="w-8 text-center text-sm tabular-nums">{appearance.terminalSize}</span>
            <Button
              variant="outline"
              size="icon-sm"
              title="增大字号"
              disabled={appearance.terminalSize >= 24}
              onClick={() => resize(1)}
            >
              <Plus />
            </Button>
          </div>
        </section>

        <section className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">主题</p>
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
        </section>
      </div>
    </ScrollArea>
  )
}

/** 一行统一主题：界面底色上放迷你终端预览卡（主题底色 + 几条彩色横条模拟文本行）+ 主题名。 */
function ThemeCard(props: { item: UnifiedTheme; selected: boolean; onSelect: () => void }) {
  const theme = terminalPalette(props.item.terminal).theme
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground',
        props.selected && 'border-foreground/40 text-foreground ring-1 ring-foreground/20'
      )}
      onClick={props.onSelect}
    >
      <span
        className="flex h-11 w-16 shrink-0 items-center justify-center rounded-md border border-foreground/10"
        style={{ background: props.item.ui['--background'] }}
      >
        <span
          className="grid h-8 w-12 content-center gap-1 rounded-sm px-1.5 shadow-sm"
          style={{ background: theme.background }}
        >
          <span className="flex gap-1">
            <span className="h-0.5 w-2 rounded-full" style={{ background: theme.green }} />
            <span className="h-0.5 flex-1 rounded-full" style={{ background: theme.foreground }} />
          </span>
          <span className="flex gap-1">
            <span className="h-0.5 w-1.5 rounded-full" style={{ background: theme.blue }} />
            <span className="h-0.5 w-3 rounded-full" style={{ background: theme.red }} />
            <span className="h-0.5 flex-1 rounded-full" style={{ background: theme.yellow }} />
          </span>
          <span className="flex gap-1">
            <span className="h-0.5 w-2 rounded-full" style={{ background: theme.magenta }} />
            <span className="h-0.5 flex-1 rounded-full" style={{ background: theme.cyan }} />
          </span>
        </span>
      </span>
      {props.item.label}
    </button>
  )
}
