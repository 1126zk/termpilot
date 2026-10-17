import type { Terminal } from '@xterm/xterm'

/**
 * 全屏程序会打开备用屏幕和鼠标跟踪，让滚轮翻自己的对话、让滑块能被拖动。
 * 跟踪序列有时到不了 xterm，到了之后滚轮仍可能被视口拿走，翻到命令历史。
 * 只要处在备用屏幕，或程序已经要求鼠标跟踪，滚轮、悬停和左键拖动都改成 SGR 报告发给程序。
 * 悬停用按钮 35，Pi 据此点亮滑块；拖动每帧只报最新位置，滑块跟手。
 * 按住 Shift 拖动不拦截，留给终端自己选文字。
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

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || ev.shiftKey || !programOwnsMouse(term)) return
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
    if (dragging || ev.buttons !== 0 || ev.shiftKey || !programOwnsMouse(term)) return
    schedule('move', ev)
  }
  const onLeave = () => {
    if (dragging || !programOwnsMouse(term)) return
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
  host.addEventListener('pointerdown', onDown, true)
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
