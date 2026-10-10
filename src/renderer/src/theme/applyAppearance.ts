import { DEFAULT_APPEARANCE, parseAppearance, unifiedTheme, type Appearance } from '../../../shared/types'
import { terminalPool } from '../terminal/TerminalPool'
import { terminalPalette } from './terminalThemes'

const CACHE_KEY = 'termpilot.appearance'

export type ResolvedAppTheme = 'light' | 'dark'

export function readCachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    return parseAppearance(JSON.parse(raw))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** 上一次 setProperty 到 documentElement 的主题变量名。切换主题时先清掉，避免残留。 */
let appliedVars: string[] = []

/**
 * 立刻把整个窗口换成这套主题。.dark class 按主题明暗切换（index.css 的 dark: 变体继续工作），
 * theme.ui 里的整套 shadcn 变量内联到 documentElement 上，盖过 index.css 的 :root/.dark 默认值。
 */
export function applyAppearance(appearance: Appearance, persist = true): ResolvedAppTheme {
  const theme = unifiedTheme(appearance.theme)
  const root = document.documentElement
  root.classList.toggle('dark', theme.dark)
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
  for (const name of appliedVars) root.style.removeProperty(name)
  appliedVars = []
  for (const [name, value] of Object.entries(theme.ui)) {
    root.style.setProperty(name, value)
    appliedVars.push(name)
  }
  const palette = terminalPalette(theme.terminal)
  root.style.setProperty('--terminal-background', palette.theme.background ?? '#ffffff')
  terminalPool.setTheme(palette.theme)
  terminalPool.setFont(terminalFontStack(appearance.terminalFont), appearance.terminalSize)
  if (persist) localStorage.setItem(CACHE_KEY, JSON.stringify(appearance))
  return theme.dark ? 'dark' : 'light'
}

/** 选中的字体放最前，后面接原来的通用 fallback 链。 */
export function terminalFontStack(font: string): string {
  // Termius 的 Source Code Pro 用内嵌的 SauceCodePro Nerd Font Mono 渲染（系统没装也有效）
  const resolved = font === 'Source Code Pro' ? 'SauceCodePro Nerd Font Mono' : font
  const fallbacks = ['Consolas', 'Cascadia Mono', 'Microsoft YaHei']
  const chain = [resolved, ...fallbacks.filter((item) => item !== resolved), 'monospace']
  return chain.map((item) => (item.includes(' ') ? `"${item}"` : item)).join(', ')
}
