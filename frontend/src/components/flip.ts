import { useLayoutEffect, type RefObject } from 'react'

/**
 * 拖拽排序的公共件（标签条横向 / 菜单项竖向共用）：
 * - startPointerDrag：阈值内是点击，过了阈值进拖拽态的状态机
 * - capturePositions / dropIndex / moveTo：FLIP 快照、按指针找插入位、数组重排
 * - useFlipSlide：重排渲染后，非跟手元素从旧位置滑到新位置（160ms）
 * 位移计算一律用 offsetLeft/offsetTop（不受 transform 影响），
 * 容器需要定位（relative），让 offset* 与指针换算同一坐标系。
 */
export type FlipAxis = 'x' | 'y'

const posOf = (el: HTMLElement, axis: FlipAxis): number => (axis === 'x' ? el.offsetLeft : el.offsetTop)
const sizeOf = (el: HTMLElement, axis: FlipAxis): number => (axis === 'x' ? el.offsetWidth : el.offsetHeight)
const translateOf = (axis: FlipAxis, delta: number): string =>
  axis === 'x' ? `translateX(${delta}px)` : `translateY(${delta}px)`

/** 按住拖动的状态机。move 回调拿轴坐标（x 给 clientX，y 给 clientY）。 */
export function startPointerDrag(opts: {
  event: { button: number; clientX: number; clientY: number }
  /** both：网格拖拽，横竖超过阈值都算开始。onMove 仍只回水平坐标。 */
  axis: FlipAxis | 'both'
  threshold?: number
  onActivate: () => void
  onMove: (position: number) => void
  onEnd: () => void
}): void {
  if (opts.event.button !== 0) return
  const threshold = opts.threshold ?? 4
  const startX = opts.event.clientX
  const startY = opts.event.clientY
  const start = opts.axis === 'y' ? startY : startX
  let active = false
  const move = (ev: PointerEvent) => {
    const position = opts.axis === 'y' ? ev.clientY : ev.clientX
    if (!active) {
      const moved = opts.axis === 'both' ? Math.hypot(ev.clientX - startX, ev.clientY - startY) : Math.abs(position - start)
      if (moved < threshold) return
      active = true
      opts.onActivate()
    }
    opts.onMove(position)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    if (active) opts.onEnd()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  // 按住的是可选中文字时，继续拖动会被 Chromium 当成原生「拖动选中文本」，
  // 发 pointercancel 而不是 pointerup——不走 onEnd 状态就卡死，同样收尾
  window.addEventListener('pointercancel', up)
}

/** 重排前快照各元素的布局位（offset* 不受 transform 影响）。 */
export function capturePositions(
  container: HTMLElement,
  attr: string,
  axis: FlipAxis,
  map: Map<string, number>
): void {
  map.clear()
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const id = el.getAttribute(attr)
    if (id) map.set(id, posOf(el, axis))
  }
}

/**
 * 交换判定（Chromium 手感）：用被拖元素的视觉边缘对相邻项中点。
 * 往前（左/上）拖：被拖元素前缘越过相邻项中点 → 换到它前面；
 * 往后（右/下）拖：被拖元素后缘越过相邻项中点 → 换到它后面。
 * start/end 是被拖元素在容器坐标里的前缘/后缘（跟手 transform 下的视觉位，不是布局位）。
 * 返回在「去掉被拖项的数组」里的插入下标。
 */
export function dropIndex(
  container: HTMLElement,
  attr: string,
  axis: FlipAxis,
  start: number,
  end: number,
  skipId: string,
  orderedIds: string[]
): number {
  const rest = orderedIds.filter((id) => id !== skipId)
  const currentPos = orderedIds.indexOf(skipId)
  let insert = 0
  let index = 0
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const id = el.getAttribute(attr)
    // 容器里可能有别的分区的项（菜单的壳区/连接区），不在本区的不参与
    if (!id || id === skipId || !orderedIds.includes(id)) continue
    const mid = posOf(el, axis) + sizeOf(el, axis) / 2
    // 相邻项在被拖元素前面（左/上侧）→ 用前缘判定；在后面的 → 用后缘判定
    const beforeDragged = orderedIds.indexOf(id) < currentPos
    const after = beforeDragged ? start > mid : end > mid
    if (after) insert = index + 1
    index++
  }
  return insert
}

/** 把 dragId 插到指定下标；顺序没变返回 null。 */
export function moveTo(ids: string[], dragId: string, insert: number): string[] | null {
  const rest = ids.filter((id) => id !== dragId)
  const next = [...rest.slice(0, insert), dragId, ...rest.slice(insert)]
  return next.join() === ids.join() ? null : next
}

/**
 * FLIP：重排渲染后，非跟手元素从「旧位置相对新位置的位移」滑到 0（160ms）。
 * 只在 active 时工作；跟手元素（skipId）自己跟指针，不参与。
 */
export function useFlipSlide(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  attr: string,
  axis: FlipAxis,
  skipId: string | null,
  prev: RefObject<Map<string, number>>,
  deps: unknown[]
): void {
  useLayoutEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const animating: HTMLElement[] = []
    for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const id = el.getAttribute(attr)
      if (!id || id === skipId) continue
      const old = prev.current.get(id)
      if (old === undefined) continue
      const delta = old - posOf(el, axis)
      if (delta === 0) continue
      el.style.transition = 'none'
      el.style.transform = translateOf(axis, delta)
      animating.push(el)
    }
    if (animating.length === 0) return
    // 强制 reflow，让无过渡的位移先生效，再上过渡滑回去
    void container.offsetHeight
    for (const el of animating) {
      el.style.transition = 'transform 160ms ease'
      el.style.transform = ''
      const clear = () => {
        el.style.transition = ''
      }
      el.addEventListener('transitionend', clear, { once: true })
      window.setTimeout(clear, 220)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export type FlipPoint = { x: number; y: number }

/** 重排前快照网格里各项的左上角。offset* 不受 transform 影响。 */
export function capturePoints(container: HTMLElement, attr: string, map: Map<string, FlipPoint>): void {
  map.clear()
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const id = el.getAttribute(attr)
    if (id) map.set(id, { x: el.offsetLeft, y: el.offsetTop })
  }
}

/**
 * 只和紧挨着的上、下、左、右一张对调。中心越过两张卡片布局中点的连线中点才换。
 * 不把中间的卡片顺次挤开，换行时也不会带动整行。顺序没变返回 null。
 * left/top/width/height 是被拖卡片跟手后的视觉框（容器坐标）。
 */
export function gridNeighborSwap(
  container: HTMLElement,
  attr: string,
  left: number,
  top: number,
  width: number,
  height: number,
  skipId: string,
  orderedIds: string[]
): string[] | null {
  const boxes = new Map<string, HTMLElement>()
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const id = el.getAttribute(attr)
    if (id && orderedIds.includes(id)) boxes.set(id, el)
  }
  const rows: string[][] = []
  for (const id of orderedIds) {
    const el = boxes.get(id)
    if (!el) continue
    const row = rows.find((line) => {
      const head = boxes.get(line[0])
      return head != null && Math.abs(head.offsetTop - el.offsetTop) < 4
    })
    if (row) row.push(id)
    else rows.push([id])
  }
  let rowIndex = -1
  let colIndex = -1
  rows.forEach((row, index) => {
    const col = row.indexOf(skipId)
    if (col >= 0) {
      rowIndex = index
      colIndex = col
    }
  })
  const own = boxes.get(skipId)
  if (!own || rowIndex < 0) return null
  const around = [
    rows[rowIndex]?.[colIndex - 1],
    rows[rowIndex]?.[colIndex + 1],
    rows[rowIndex - 1]?.[colIndex],
    rows[rowIndex + 1]?.[colIndex]
  ].filter((id): id is string => !!id)
  const cx = left + width / 2
  const cy = top + height / 2
  const ownX = own.offsetLeft + own.offsetWidth / 2
  const ownY = own.offsetTop + own.offsetHeight / 2
  let nextTo: string | null = null
  let crossed = 0
  for (const id of around) {
    const el = boxes.get(id)
    if (!el) continue
    const nx = el.offsetLeft + el.offsetWidth / 2
    const ny = el.offsetTop + el.offsetHeight / 2
    const horizontal = Math.abs(ny - ownY) < Math.abs(nx - ownX)
    const mid = horizontal ? (ownX + nx) / 2 : (ownY + ny) / 2
    const dir = horizontal ? Math.sign(nx - ownX) || 1 : Math.sign(ny - ownY) || 1
    const past = ((horizontal ? cx : cy) - mid) * dir
    if (past > crossed) {
      crossed = past
      nextTo = id
    }
  }
  if (!nextTo) return null
  const from = orderedIds.indexOf(skipId)
  const to = orderedIds.indexOf(nextTo)
  if (from < 0 || to < 0) return null
  const next = orderedIds.slice()
  next[from] = nextTo
  next[to] = skipId
  return next
}

/** 网格 FLIP：其余卡片从旧的左上角滑到新位置。跟手的那张自己用 translate 跟着指针。 */
export function useFlipMove(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  attr: string,
  skipId: string | null,
  prev: RefObject<Map<string, FlipPoint>>,
  deps: unknown[]
): void {
  useLayoutEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const animating: HTMLElement[] = []
    for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const id = el.getAttribute(attr)
      if (!id || id === skipId) continue
      const old = prev.current.get(id)
      if (!old) continue
      const dx = old.x - el.offsetLeft
      const dy = old.y - el.offsetTop
      if (dx === 0 && dy === 0) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      animating.push(el)
    }
    if (animating.length === 0) return
    void container.offsetHeight
    for (const el of animating) {
      el.style.transition = 'transform 160ms ease'
      el.style.transform = ''
      const clear = () => {
        el.style.transition = ''
      }
      el.addEventListener('transitionend', clear, { once: true })
      window.setTimeout(clear, 220)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
