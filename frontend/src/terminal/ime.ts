import type { Terminal } from '@xterm/xterm'

type XtermInternals = {
  _core?: {
    _compositionHelper?: { updateCompositionElements(dontRecurse?: boolean): void }
    coreService?: { isCursorHidden: boolean }
    _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } }
  }
}

type Cell = { col: number; row: number }

const isBlockGlyph = (chars: string) => /[\u2580-\u259F]/.test(chars)

/**
 * 中文输入的摆放。xterm 按系统光标放拼音，还把组字条拉到行尾，
 * 全屏程序（pi、kimi）藏起系统光标自己画一个，候选窗就跑到行尾或屏幕角落。
 *
 * 这里接管 xterm 的摆放：
 * - 拼音框盖在输入位置那一格，顺带挡住光标；
 * - 隐藏输入框放在拼音左下，Windows 的候选窗跟着它；
 * - 输入框只能原地挪，移出终端 Windows 会取消组字。
 */
export function bindIme(host: HTMLElement, term: Terminal): void {
  const view = host.querySelector('.composition-view')
  const textarea = host.querySelector('textarea.xterm-helper-textarea')
  const core = (term as unknown as XtermInternals)._core
  const helper = core?._compositionHelper
  if (!(view instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) || !helper) return

  const xtermUpdate = helper.updateCompositionElements.bind(helper)
  const measure = document.createElement('canvas').getContext('2d')
  const applied = new Map<HTMLElement, string[]>()
  let lastAnchor: Cell | null = null

  const setStyles = (el: HTMLElement, styles: Record<string, string>) => {
    for (const [key, value] of Object.entries(styles)) el.style.setProperty(key, value, 'important')
    applied.set(el, Object.keys(styles))
  }
  const clearStyles = () => {
    for (const [el, keys] of applied) for (const key of keys) el.style.removeProperty(key)
    applied.clear()
  }

  const cellSize = () => {
    const cell = core?._renderService?.dimensions?.css?.cell
    if (cell && cell.width > 0 && cell.height > 0) return { w: cell.width, h: cell.height }
    const rect = host.getBoundingClientRect()
    return { w: rect.width / Math.max(1, term.cols), h: rect.height / Math.max(1, term.rows) }
  }

  /** 程序画的输入光标：一行里最右边孤立的反色格，其次孤立的方块字，再次孤立的有底色空格。 */
  const drawnCaret = (row: number) => {
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + row)
    if (!line) return -1
    const len = Math.min(line.length, term.cols)
    let inverse = -1
    let block = -1
    let spot = -1
    for (let x = 0; x < len; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const left = x > 0 ? line.getCell(x - 1) : undefined
      const right = x + 1 < len ? line.getCell(x + 1) : undefined
      if (cell.isInverse() && !(left?.isInverse() && right?.isInverse())) inverse = x
      const chars = cell.getChars()
      if (isBlockGlyph(chars) && !(isBlockGlyph(left?.getChars() ?? '') && isBlockGlyph(right?.getChars() ?? ''))) block = x
      if (!cell.isBgDefault() && (!chars || chars === ' ') && x < term.cols * 0.85) {
        const bg = `${cell.getBgColorMode()}:${cell.getBgColor()}`
        const same = (other?: typeof cell) =>
          !!other && !other.isBgDefault() && `${other.getBgColorMode()}:${other.getBgColor()}` === bg
        if (!(same(left) && same(right))) spot = x
      }
    }
    return inverse >= 0 ? inverse : block >= 0 ? block : spot
  }

  /**
   * 普通 shell 用系统光标。系统光标被程序藏起或停在行尾时，找程序画的那个：
   * 先看系统光标那一行，再从下往上找。组字中重画的瞬间找不到，就沿用上一次。
   */
  const anchor = (): Cell => {
    const buffer = term.buffer.active
    const hardware = { col: Math.min(buffer.cursorX, Math.max(0, term.cols - 1)), row: buffer.cursorY }
    const appHidden = core?.coreService?.isCursorHidden ?? false
    if (!appHidden && hardware.col < term.cols - 2) return hardware
    const inRow = drawnCaret(hardware.row)
    if (inRow >= 0) return { col: inRow, row: hardware.row }
    if (appHidden) {
      for (let row = term.rows - 1; row >= 0; row--) {
        const col = drawnCaret(row)
        if (col >= 0) return { col, row }
      }
    }
    return lastAnchor ?? hardware
  }

  const place = () => {
    const { w, h } = cellSize()
    const { col, row } = anchor()
    lastAnchor = { col, row }
    const fontSize = `${term.options.fontSize ?? 14}px`
    const fontFamily = term.options.fontFamily || 'monospace'
    const text = view.textContent ?? ''
    if (measure) measure.font = `${fontSize} ${fontFamily}`
    const textWidth = text && measure ? measure.measureText(text).width : 0
    const room = w * Math.max(1, term.cols - col)
    // 四边各多盖 1px，免得光标露出一条边；至少盖满一格。
    const width = Math.ceil(Math.min(room, Math.max(w, textWidth + 2))) + 1
    const left = Math.max(0, Math.floor(col * w) - 1)
    const top = Math.max(0, Math.floor(row * h) - 1)
    const height = `${Math.ceil((row + 1) * h) + 1 - top}px`

    setStyles(view, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      'max-width': `${width}px`,
      height,
      'line-height': height,
      'padding-left': '1px',
      'box-sizing': 'border-box',
      'font-family': fontFamily,
      'font-size': fontSize,
      background: '#000',
      color: '#fff'
    })
    // 候选窗贴着输入框下沿；输入框比拼音略靠左上，候选窗就落在拼音左下。
    setStyles(textarea, {
      left: `${Math.max(0, Math.round(col * w - w * 0.55))}px`,
      top: `${Math.round(row * h + h * 0.16)}px`,
      width: `${width}px`,
      'max-width': `${width}px`,
      height,
      'line-height': height,
      opacity: '0'
    })
    host.scrollLeft = 0
  }

  const reset = () => {
    if (applied.size === 0) return
    clearStyles()
    lastAnchor = null
  }

  helper.updateCompositionElements = (dontRecurse?: boolean) => {
    xtermUpdate(dontRecurse)
    if (view.classList.contains('active')) place()
    else reset()
  }
  textarea.addEventListener('compositionend', reset)
}
