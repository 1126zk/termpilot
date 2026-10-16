import type { LocalShell, LocalShellInfo } from '../../shared/types'

/** + 菜单的拖拽顺序。和 TabBar 共用这一份，右键打开也按这个顺序取第一个。 */
export const MENU_ORDER_KEY = 'termpilot.menuOrder'

/** 按保存的顺序排 key；不在顺序表里的新项保持原相对顺序排在末尾。 */
export function applyOrder(keys: string[], order: string[]): string[] {
  const pos = new Map(order.map((key, index) => [key, index]))
  return [...keys].sort(
    (a, b) => (pos.get(a) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function readMenuOrder(): string[] {
  try {
    const raw = localStorage.getItem(MENU_ORDER_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

export function writeMenuOrder(order: string[]): void {
  localStorage.setItem(MENU_ORDER_KEY, JSON.stringify(order))
}

/** + 菜单里排在最前面的本机终端。没排过序时就是探测列表的第一项。 */
export function firstOrderedShell(shells: Pick<LocalShellInfo, 'id'>[]): LocalShell {
  const ordered = applyOrder(
    shells.map((shell) => `shell:${shell.id}`),
    readMenuOrder()
  )
  const key = ordered[0]
  if (key?.startsWith('shell:')) return key.slice('shell:'.length) as LocalShell
  return 'powershell'
}
