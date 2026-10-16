import type { Terminal } from '@xterm/xterm'

/**
 * 全屏程序会打开备用屏幕和鼠标跟踪，让滚轮翻自己的对话。
 * 跟踪序列有时到不了 xterm，到了之后滚轮仍可能被视口拿走，翻到命令历史。
 * 只要处在备用屏幕，或程序已经要求鼠标跟踪，滚轮就改成 SGR 报告发给程序。
 */
export function bindFullscreenWheel(host: HTMLElement, term: Terminal): void {
  host.addEventListener(
    'wheel',
    (ev) => {
      if (ev.deltaY === 0) return
      const fullscreen = term.buffer.active.type === 'alternate'
      const tracking = term.modes.mouseTrackingMode !== 'none'
      // 全屏，或程序已经要求鼠标跟踪。两种都要把滚轮留给程序，不能翻命令历史。
      if (!fullscreen && !tracking) return
      ev.preventDefault()
      ev.stopPropagation()
      term.input(sgrWheelReport(ev.deltaY, cellOf(host, term, ev), ev.altKey))
    },
    { capture: true, passive: false }
  )
}

/** 一格一报。Pi 只认整段数据恰好是一条滚轮序列。 */
export function sgrWheelReport(deltaY: number, cell: { col: number; row: number }, alt: boolean): string {
  const button = (deltaY < 0 ? 64 : 65) + (alt ? 8 : 0)
  return `\x1b[<${button};${cell.col};${cell.row}M`
}

function cellOf(host: HTMLElement, term: Terminal, ev: WheelEvent): { col: number; row: number } {
  const rect = host.getBoundingClientRect()
  const col = Math.min(term.cols, Math.max(1, Math.floor(((ev.clientX - rect.left) / Math.max(rect.width, 1)) * term.cols) + 1))
  const row = Math.min(term.rows, Math.max(1, Math.floor(((ev.clientY - rect.top) / Math.max(rect.height, 1)) * term.rows) + 1))
  return { col, row }
}
