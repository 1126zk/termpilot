import type { Terminal } from '@xterm/xterm'

/**
 * 全屏程序会打开备用屏幕和鼠标跟踪，让滚轮翻自己的对话、让滑块能被拖动。
 * 跟踪序列有时到不了 xterm，到了之后滚轮仍可能被视口拿走，翻到命令历史。
 * 只要处在备用屏幕，或程序已经要求鼠标跟踪，滚轮、悬停和左键拖动都改成 SGR 报告发给程序。
 * 悬停用按钮 35，Pi 据此点亮滑块；拖动每帧只报最新位置，滑块跟手。
 * 按住中键上下移动时连续翻页，离得越远翻得越快，松手即停。
 * 程序接管了鼠标就发滚轮报告；没接管（如 Kimi 的普通模式）就翻终端自己的回滚。
 * 左键滚动条不变。按住 Shift 不拦截，留给终端自己选文字。
 */
export function bindFullscreenWheel(host: HTMLElement, term: Terminal): () => void {
  const onWheel = (ev: WheelEvent) => {
    if (ev.deltaY === 0 || !programOwnsMouse(term)) return
    ev.preventDefault()
    ev.stopPropagation()
    term.input(sgrWheelReport(ev.deltaY, cellOf(host, term, ev), ev.altKey))
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: false })

  let dragging = false
  let pointerId = -1
  let lastCol = 0
  let lastRow = 0
  let frame = 0
  let pending: { action: 'move' | 'drag'; cell: { col: number; row: number }; alt: boolean; ctrl: boolean } | null = null
  let scrolling = false
  let scrollId = -1
  let anchorY = 0
  let scrollY = 0
  let scrollCell = { col: 1, row: 1 }
  let scrollAlt = false
  let carry = 0
  let scrollFrame = 0
  const marker = document.createElement('div')
  marker.className = 'middle-scroll-marker'

  const emit = (action: PointerAction, cell: { col: number; row: number }, alt: boolean, ctrl: boolean) => {
    if ((action === 'move' || action === 'drag') && cell.col === lastCol && cell.row === lastRow) return
    lastCol = cell.col
    lastRow = cell.row
    term.input(sgrPointerReport(action, cell, alt, ctrl))
  }

  const flush = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    const item = pending
    pending = null
    if (!item) return
    emit(item.action, item.cell, item.alt, item.ctrl)
  }

  const schedule = (action: 'move' | 'drag', ev: PointerEvent) => {
    const cell = cellOf(host, term, ev)
    if (cell.col === lastCol && cell.row === lastRow && pending === null) return
    pending = { action, cell, alt: ev.altKey, ctrl: ev.ctrlKey }
    if (frame) return
    frame = requestAnimationFrame(flush)
  }

  const stopDrag = () => {
    dragging = false
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
  }

  const onMove = (ev: PointerEvent) => {
    if (!dragging || ev.pointerId !== pointerId) return
    if (!programOwnsMouse(term)) {
      release(ev)
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    schedule('drag', ev)
  }

  const release = (ev: PointerEvent) => {
    if (!dragging || ev.pointerId !== pointerId) return
    stopDrag()
    try {
      host.releasePointerCapture(pointerId)
    } catch {
      /* 指针已经不在捕获里 */
    }
    flush()
    emit('up', cellOf(host, term, ev), ev.altKey, ev.ctrlKey)
  }

  const onUp = (ev: PointerEvent) => release(ev)

  const hideMarker = () => {
    marker.remove()
    document.documentElement.classList.remove('middle-scrolling')
  }

  const stopScroll = () => {
    scrolling = false
    carry = 0
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
    hideMarker()
    window.removeEventListener('pointermove', onScrollMove, true)
    window.removeEventListener('pointerup', onScrollUp, true)
    window.removeEventListener('pointercancel', onScrollUp, true)
  }

  const scrollTick = () => {
    scrollFrame = 0
    if (!scrolling) return
    const owns = programOwnsMouse(term)
    const cellH = cellHeight(term)
    const dead = Math.max(10, cellH * 0.75)
    const dy = scrollY - anchorY
    const dist = Math.abs(dy) - dead
    if (dist > 0) {
      const cells = dist / cellH
      const perSec = Math.min(180, 20 + cells * 32)
      carry += perSec / 60
      const count = Math.min(8, Math.floor(carry))
      carry -= count
      if (owns) {
        for (let i = 0; i < count; i += 1) term.input(sgrWheelReport(dy, scrollCell, scrollAlt))
      } else if (count > 0) {
        term.scrollLines(dy > 0 ? count : -count)
      }
    } else {
      carry = 0
    }
    scrollFrame = requestAnimationFrame(scrollTick)
  }

  const onScrollMove = (ev: PointerEvent) => {
    if (!scrolling || ev.pointerId !== scrollId) return
    ev.preventDefault()
    ev.stopPropagation()
    scrollY = ev.clientY
    scrollCell = cellOf(host, term, ev)
    scrollAlt = ev.altKey
  }

  const onScrollUp = (ev: PointerEvent) => {
    if (!scrolling || ev.pointerId !== scrollId) return
    if (ev.type !== 'pointercancel' && ev.button !== 1) return
    try {
      host.releasePointerCapture(scrollId)
    } catch {
      /* 指针已经不在捕获里 */
    }
    stopScroll()
  }

  const onDown = (ev: PointerEvent) => {
    if (ev.button === 1) {
      if (ev.shiftKey || dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      scrolling = true
      scrollId = ev.pointerId
      anchorY = ev.clientY
      scrollY = ev.clientY
      scrollCell = cellOf(host, term, ev)
      scrollAlt = ev.altKey
      carry = 0
      marker.style.left = `${ev.clientX}px`
      marker.style.top = `${ev.clientY}px`
      document.body.appendChild(marker)
      document.documentElement.classList.add('middle-scrolling')
      term.focus()
      try {
        host.setPointerCapture(ev.pointerId)
      } catch {
        /* 指针已经松开 */
      }
      window.addEventListener('pointermove', onScrollMove, true)
      window.addEventListener('pointerup', onScrollUp, true)
      window.addEventListener('pointercancel', onScrollUp, true)
      scrollFrame = requestAnimationFrame(scrollTick)
      return
    }
    if (ev.button !== 0 || scrolling || ev.shiftKey || !programOwnsMouse(term)) return
    ev.preventDefault()
    ev.stopPropagation()
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = null
    dragging = true
    pointerId = ev.pointerId
    term.focus()
    emit('down', cellOf(host, term, ev), ev.altKey, ev.ctrlKey)
    try {
      host.setPointerCapture(ev.pointerId)
    } catch {
      /* 指针已经松开 */
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }
  const onHover = (ev: PointerEvent) => {
    if (dragging || scrolling || ev.buttons !== 0 || ev.shiftKey || !programOwnsMouse(term)) return
    schedule('move', ev)
  }
  const onLeave = () => {
    if (dragging || scrolling || !programOwnsMouse(term)) return
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = null
    emit('move', { col: 1, row: 1 }, false, false)
  }
  const onMouseMove = (ev: MouseEvent) => {
    if (ev.shiftKey || !programOwnsMouse(term)) return
    ev.preventDefault()
    ev.stopPropagation()
  }
  const onAuxClick = (ev: MouseEvent) => {
    if (ev.button !== 1 || ev.shiftKey) return
    ev.preventDefault()
    ev.stopPropagation()
  }
  host.addEventListener('pointerdown', onDown, true)
  host.addEventListener('auxclick', onAuxClick, true)
  host.addEventListener('pointermove', onHover, true)
  host.addEventListener('pointerleave', onLeave, true)
  host.addEventListener('mousemove', onMouseMove, true)

  const syncOwner = () => host.classList.toggle('term-app-mouse', programOwnsMouse(term))
  syncOwner()
  const parsed = term.onWriteParsed(syncOwner)

  return () => {
    parsed.dispose()
    host.classList.remove('term-app-mouse')
    host.removeEventListener('wheel', onWheel, true)
    host.removeEventListener('pointerdown', onDown, true)
    host.removeEventListener('auxclick', onAuxClick, true)
    stopScroll()
    host.removeEventListener('pointermove', onHover, true)
    host.removeEventListener('pointerleave', onLeave, true)
    host.removeEventListener('mousemove', onMouseMove, true)
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = null
    if (dragging) term.input(sgrPointerReport('up', { col: lastCol, row: lastRow }, false, false))
    stopDrag()
  }
}

function cellHeight(term: Terminal): number {
  const dims = (term as unknown as RenderDims)._core?._renderService?.dimensions?.css
  const height = dims?.cell?.height ?? 0
  return height > 0 ? height : 16
}

function programOwnsMouse(term: Terminal): boolean {
  return term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
}

/** 一格一报。Pi 只认整段数据恰好是一条滚轮序列。 */
export function sgrWheelReport(deltaY: number, cell: { col: number; row: number }, alt: boolean): string {
  const button = (deltaY < 0 ? 64 : 65) + (alt ? 8 : 0)
  return `\x1b[<${button};${cell.col};${cell.row}M`
}

export type PointerAction = 'down' | 'move' | 'drag' | 'up'

/** 悬停是按钮 35，拖动是 32，松开用小写 m。和 xterm 的 SGR 一致。 */
export function sgrPointerReport(
  action: PointerAction,
  cell: { col: number; row: number },
  alt: boolean,
  ctrl: boolean
): string {
  let button = (alt ? 8 : 0) + (ctrl ? 16 : 0)
  if (action === 'move') button += 35
  else if (action === 'drag') button += 32
  const final = action === 'up' ? 'm' : 'M'
  return `\x1b[<${button};${cell.col};${cell.row}${final}`
}

type RenderDims = {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: { width: number; height: number }
          canvas?: { width: number; height: number }
        }
      }
    }
  }
}

/** 跟 xterm 自己上报鼠标用同一套格子。按整个窗口宽度均分会偏一列，Pi 的滚动条就点不中。 */
function cellOf(host: HTMLElement, term: Terminal, ev: { clientX: number; clientY: number }): { col: number; row: number } {
  const screen = host.querySelector('.xterm-screen')
  const element = screen instanceof HTMLElement ? screen : host
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  let x = ev.clientX - rect.left - (Number.parseFloat(style.paddingLeft) || 0)
  let y = ev.clientY - rect.top - (Number.parseFloat(style.paddingTop) || 0)
  const dims = (term as unknown as RenderDims)._core?._renderService?.dimensions?.css
  const cellW = dims?.cell?.width ?? 0
  const cellH = dims?.cell?.height ?? 0
  if (cellW > 0 && cellH > 0) {
    const canvasW = dims?.canvas?.width ?? cellW * term.cols
    const canvasH = dims?.canvas?.height ?? cellH * term.rows
    x = Math.min(Math.max(x, 0), Math.max(canvasW, cellW) - 1)
    y = Math.min(Math.max(y, 0), Math.max(canvasH, cellH) - 1)
    return {
      col: Math.min(term.cols, Math.max(1, Math.floor(x / cellW) + 1)),
      row: Math.min(term.rows, Math.max(1, Math.floor(y / cellH) + 1))
    }
  }
  return {
    col: Math.min(term.cols, Math.max(1, Math.floor((x / Math.max(rect.width, 1)) * term.cols) + 1)),
    row: Math.min(term.rows, Math.max(1, Math.floor((y / Math.max(rect.height, 1)) * term.rows) + 1))
  }
}
