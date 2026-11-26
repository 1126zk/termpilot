import type { Terminal } from '@xterm/xterm'
import { httpLinkAt } from './links'

/**
 * 全屏程序会打开备用屏幕和鼠标跟踪，让滚轮翻自己的对话、让滑块能被拖动。
 * 跟踪序列有时到不了 xterm，到了之后滚轮仍可能被视口拿走，翻到命令历史。
 * 只要处在备用屏幕，或程序已经要求鼠标跟踪，滚轮和左键拖动都改成 SGR 报告发给程序。
 * 悬停（按钮 35）只在程序开了任意移动跟踪时发，Pi 据此点亮滑块；跟踪序列没到但还在备用屏幕时也发。
 * 拖动每帧只报最新位置，滑块跟手。
 * 按住中键上下移动时连续翻页，离得越远翻得越快，松手即停。
 * 程序接管了鼠标就发滚轮报告；没接管（如 Kimi 的普通模式）就翻终端自己的回滚。
 * 左键滚动条不变。按住 Shift 不拦截，留给终端自己选文字。
 * 落在网址或 OSC 8 链接上的左键不发给程序：拖动在本地选字，Ctrl+点击打开。跟踪模式保持不动，避免和选区抢这一下。
 * 按住 Ctrl/Cmd 时不截 mousemove，xterm 才能给链接画下划线。
 */
export function bindFullscreenWheel(host: HTMLElement, term: Terminal): () => void {
  // 全屏程序退出后，关闭跟踪的序列可能晚到或没到。这期间继续上报会把 35;…M 打进 shell，
  // 并且每动一下都要等一轮网络，所以先在本地停掉。
  let quiet = false
  let wasAlt = term.buffer.active.type === 'alternate'
  const owns = () => !quiet && programOwnsMouse(term)

  let wheelFrame = 0
  let wheelPending: { delta: number; cell: { col: number; row: number }; alt: boolean } | null = null
  const flushWheel = () => {
    wheelFrame = 0
    const item = wheelPending
    wheelPending = null
    if (!item || !owns()) return
    term.input(sgrWheelReport(item.delta, item.cell, item.alt))
  }
  const onWheel = (ev: WheelEvent) => {
    if (ev.deltaY === 0 || !owns()) return
    ev.preventDefault()
    ev.stopPropagation()
    // 一帧只留最新一格。触控板一次会连发很多格，每格都等 Pi 重画就会卡。
    wheelPending = { delta: ev.deltaY, cell: cellOf(host, term, ev), alt: ev.altKey }
    if (wheelFrame) return
    wheelFrame = requestAnimationFrame(flushWheel)
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: false })

  let dragging = false
  let pointerId = -1
  let lastCol = 0
  let lastRow = 0
  let frame = 0
  let moveTimer = 0
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

  // 链接上的这一下在本地选字、打开，不走 SGR，也不改跟踪模式。
  let linkPointer = -1
  let linkAnchor: BufferCell | null = null
  let linkUrl: string | null = null

  const emit = (action: PointerAction, cell: { col: number; row: number }, alt: boolean, ctrl: boolean) => {
    if ((action === 'move' || action === 'drag') && cell.col === lastCol && cell.row === lastRow) return
    lastCol = cell.col
    lastRow = cell.row
    term.input(sgrPointerReport(action, cell, alt, ctrl))
  }

  const flush = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (moveTimer) window.clearTimeout(moveTimer)
    moveTimer = 0
    const item = pending
    pending = null
    if (!item || !owns()) return
    emit(item.action, item.cell, item.alt, item.ctrl)
  }

  const schedule = (action: 'move' | 'drag', ev: PointerEvent) => {
    const cell = cellOf(host, term, ev)
    if (cell.col === lastCol && cell.row === lastRow && pending === null) return
    pending = { action, cell, alt: ev.altKey, ctrl: ev.ctrlKey }
    if (action === 'drag') {
      if (moveTimer) window.clearTimeout(moveTimer)
      moveTimer = 0
      if (frame) return
      frame = requestAnimationFrame(flush)
      return
    }
    // 悬停只用来点亮滑块，不必每帧都走一趟网络。
    if (frame || moveTimer) return
    moveTimer = window.setTimeout(flush, 48)
  }

  const stopDrag = () => {
    dragging = false
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
  }

  const onMove = (ev: PointerEvent) => {
    if (!dragging || ev.pointerId !== pointerId) return
    if (!owns()) {
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
    if (owns()) emit('up', cellOf(host, term, ev), ev.altKey, ev.ctrlKey)
  }

  const onUp = (ev: PointerEvent) => release(ev)

  const stopLink = () => {
    if (linkPointer < 0) return
    const id = linkPointer
    linkPointer = -1
    linkAnchor = null
    linkUrl = null
    window.removeEventListener('pointermove', onLinkMove, true)
    window.removeEventListener('pointerup', onLinkUp, true)
    window.removeEventListener('pointercancel', onLinkUp, true)
    try {
      host.releasePointerCapture(id)
    } catch {
      /* 指针已经不在捕获里 */
    }
  }

  const onLinkMove = (ev: PointerEvent) => {
    if (linkPointer < 0 || ev.pointerId !== linkPointer || !linkAnchor) return
    ev.preventDefault()
    ev.stopPropagation()
    selectBetween(term, linkAnchor, bufferCell(term, cellOf(host, term, ev)))
  }

  const onLinkUp = (ev: PointerEvent) => {
    if (linkPointer < 0 || ev.pointerId !== linkPointer || !linkAnchor) return
    ev.preventDefault()
    ev.stopPropagation()
    const anchor = linkAnchor
    const url = linkUrl
    const here = bufferCell(term, cellOf(host, term, ev))
    const same = here.x === anchor.x && here.y === anchor.y
    if (!same) selectBetween(term, anchor, here)
    stopLink()
    if (same && url && ev.type !== 'pointercancel' && (ev.ctrlKey || ev.metaKey)) {
      window.runtime.BrowserOpenURL(url)
    }
  }

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
    const still = owns()
    const cellH = cellHeight(term)
    const dead = Math.max(10, cellH * 0.75)
    const dy = scrollY - anchorY
    const dist = Math.abs(dy) - dead
    if (dist > 0) {
      const cells = dist / cellH
      const perSec = Math.min(180, 20 + cells * 32)
      carry += perSec / 60
      const count = Math.min(8, Math.floor(carry))
      const send = still ? Math.min(2, count) : count
      carry -= send
      if (still) {
        for (let i = 0; i < send; i += 1) term.input(sgrWheelReport(dy, scrollCell, scrollAlt))
      } else if (send > 0) {
        term.scrollLines(dy > 0 ? send : -send)
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
    if (ev.button !== 0 || scrolling || ev.shiftKey || linkPointer >= 0 || !owns()) return
    const anchor = bufferCell(term, cellOf(host, term, ev))
    const url = httpLinkAt(term, anchor.x, anchor.y)
    if (url) {
      ev.preventDefault()
      ev.stopPropagation()
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      pending = null
      linkPointer = ev.pointerId
      linkAnchor = anchor
      linkUrl = url
      term.focus()
      term.clearSelection()
      try {
        host.setPointerCapture(ev.pointerId)
      } catch {
        /* 指针已经松开 */
      }
      window.addEventListener('pointermove', onLinkMove, true)
      window.addEventListener('pointerup', onLinkUp, true)
      window.addEventListener('pointercancel', onLinkUp, true)
      return
    }
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
    if (dragging || scrolling || linkPointer >= 0 || ev.buttons !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || !owns() || !wantsHover(term)) return
    schedule('move', ev)
  }
  const onLeave = () => {
    if (dragging || scrolling || linkPointer >= 0 || !owns() || !wantsHover(term)) return
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = null
    emit('move', { col: 1, row: 1 }, false, false)
  }
  let lastMove: { x: number; y: number } | null = null
  const onMouseMove = (ev: MouseEvent) => {
    lastMove = { x: ev.clientX, y: ev.clientY }
    // 按住 Ctrl/Cmd 时留给 xterm 的链接悬停，否则下划线出不来。
    if (linkPointer >= 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || !owns()) return
    ev.preventDefault()
    ev.stopPropagation()
  }
  const replayHover = () => {
    if (!lastMove || !owns()) return
    const screen = host.querySelector('.xterm-screen')
    if (!(screen instanceof HTMLElement)) return
    screen.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: lastMove.x,
      clientY: lastMove.y,
      ctrlKey: true,
      metaKey: true
    }))
  }
  const onModifier = (ev: KeyboardEvent) => {
    if (ev.type !== 'keydown' || (ev.key !== 'Control' && ev.key !== 'Meta')) return
    replayHover()
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
  window.addEventListener('keydown', onModifier)

  const handBack = () => {
    quiet = true
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (moveTimer) window.clearTimeout(moveTimer)
    moveTimer = 0
    pending = null
    if (wheelFrame) cancelAnimationFrame(wheelFrame)
    wheelFrame = 0
    wheelPending = null
    if (dragging) {
      try {
        host.releasePointerCapture(pointerId)
      } catch {
        /* 指针已经不在捕获里 */
      }
      stopDrag()
    }
    if (scrolling) {
      try {
        host.releasePointerCapture(scrollId)
      } catch {
        /* 指针已经不在捕获里 */
      }
      stopScroll()
    }
    stopLink()
    term.clearSelection()
    if (term.modes.mouseTrackingMode !== 'none') {
      // 只改本地模式，不写进 PTY。
      term.write('\x1b[?9;1000;1002;1003;1006;1016l')
    } else {
      quiet = false
    }
  }

  const syncOwner = () => {
    const nowAlt = term.buffer.active.type === 'alternate'
    if (wasAlt && !nowAlt) {
      wasAlt = false
      handBack()
    } else {
      wasAlt = nowAlt
    }
    // 跟踪已经关掉，或程序又进了备用屏幕，都恢复正常上报。
    if (quiet && (nowAlt || term.modes.mouseTrackingMode === 'none')) quiet = false
    host.classList.toggle('term-app-mouse', owns())
  }
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
    window.removeEventListener('keydown', onModifier)
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (moveTimer) window.clearTimeout(moveTimer)
    moveTimer = 0
    pending = null
    if (wheelFrame) cancelAnimationFrame(wheelFrame)
    wheelFrame = 0
    wheelPending = null
    if (dragging && owns()) term.input(sgrPointerReport('up', { col: lastCol, row: lastRow }, false, false))
    stopDrag()
    stopLink()
  }
}

type BufferCell = { x: number; y: number }

/** cellOf 是视口里从 1 数的格子，选区和链接用缓冲区坐标。 */
function bufferCell(term: Terminal, cell: { col: number; row: number }): BufferCell {
  return { x: cell.col - 1, y: term.buffer.active.viewportY + cell.row - 1 }
}

/** 从按下的格子拖到当前格子。当前格是边界，和 xterm 自己选字一样不包含在内。 */
function selectBetween(term: Terminal, a: BufferCell, b: BufferCell): void {
  const cols = Math.max(1, term.cols)
  const ia = a.y * cols + a.x
  const ib = b.y * cols + b.x
  if (ia === ib) {
    term.clearSelection()
    return
  }
  const from = ia < ib ? a : b
  const to = ia < ib ? b : a
  term.select(from.x, from.y, to.y * cols + to.x - (from.y * cols + from.x))
}

/** 没按键的悬停。任意移动跟踪（1003）才要；序列没到 xterm 但还在备用屏幕时，Pi 的滑块也靠它。 */
function wantsHover(term: Terminal): boolean {
  const mode = term.modes.mouseTrackingMode
  return mode === 'any' || (mode === 'none' && term.buffer.active.type === 'alternate')
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
