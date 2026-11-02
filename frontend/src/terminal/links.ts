import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { FILE_PATH, hideImageHover, IMAGE_PATH, openFilePath, openImagePath, showImageHover } from './imageHover'

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?，。；！？、]+$/

/**
 * 把一行拼成文字，同时记下每个字符落在哪一格、占几格。
 * 中文等宽字符占两格却只是一个字符，按字符下标当列号会让后面的链接整体左偏。
 */
function lineCells(line: IBufferLine | undefined): { text: string; col: number[]; width: number[] } {
  let text = ''
  const col: number[] = []
  const width: number[] = []
  if (!line) return { text, col, width }
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    const w = cell?.getWidth() ?? 1
    if (w === 0) continue // 宽字符的后半格
    const chars = cell?.getChars() || ' '
    for (let i = 0; i < chars.length; i++) {
      text += chars[i]
      col.push(x)
      width.push(w)
    }
  }
  return { text: text.trimEnd(), col, width }
}

/** 一段文字在屏幕上的位置：横向中点和所在行的上下沿（视口坐标）。终端没挂在画面上时返回 null */
function linkBox(
  term: Terminal,
  cells: { col: number[]; width: number[] },
  index: number,
  length: number,
  lineNumber: number
): { centerX: number; top: number; bottom: number } | null {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen || term.cols === 0 || term.rows === 0) return null
  const rect = screen.getBoundingClientRect()
  const cellW = rect.width / term.cols
  const cellH = rect.height / term.rows
  const last = index + length - 1
  const startCol = cells.col[index]
  const endCol = cells.col[last] + cells.width[last]
  const row = lineNumber - 1 - term.buffer.active.viewportY
  const top = rect.top + row * cellH
  return { centerX: rect.left + ((startCol + endCol) / 2) * cellW, top, bottom: top + cellH }
}

/**
 * 终端里的三种链接，都是按住 Ctrl/Cmd 才有下划线、才能点：
 * - 网址：Ctrl+点击用系统浏览器打开
 * - 图片路径：悬停弹出预览（不用按 Ctrl），Ctrl+点击用图片查看器打开
 * - 普通文件路径：Ctrl+点击进入编辑器，没有悬停预览
 */
export function bindTerminalLinks(term: Terminal, termId: string): () => void {
  let hovered: ILink | null = null
  const updateModifier = (event: { ctrlKey: boolean; metaKey: boolean }) => {
    if (!hovered?.decorations) return
    hovered.decorations.pointerCursor = event.ctrlKey || event.metaKey
    hovered.decorations.underline = event.ctrlKey || event.metaKey
  }
  const clearModifier = () => {
    if (!hovered?.decorations) return
    hovered.decorations.pointerCursor = false
    hovered.decorations.underline = false
  }
  window.addEventListener('keydown', updateModifier)
  window.addEventListener('keyup', updateModifier)
  window.addEventListener('blur', clearModifier)

  const makeLink = (
    text: string,
    index: number,
    lineNumber: number,
    cells: { col: number[]; width: number[] },
    open: (url: string) => void,
    onHover?: (event: MouseEvent) => void,
    onLeave?: () => void
  ): ILink => {
    const last = index + text.length - 1
    const link: ILink = {
      text,
      decorations: { pointerCursor: false, underline: false },
      // range 的列号从 1 起、含尾
      range: {
        start: { x: cells.col[index] + 1, y: lineNumber },
        end: { x: cells.col[last] + cells.width[last], y: lineNumber }
      },
      activate: (event, value) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        open(value)
      },
      hover: (event) => {
        hovered = link
        updateModifier(event)
        onHover?.(event)
      },
      leave: () => {
        if (hovered === link) hovered = null
        if (link.decorations) {
          link.decorations.pointerCursor = false
          link.decorations.underline = false
        }
        onLeave?.()
      }
    }
    return link
  }

  const provider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const cells = lineCells(term.buffer.active.getLine(lineNumber - 1))
      const line = cells.text
      const links: ILink[] = []
      for (const match of line.matchAll(URL_PATTERN)) {
        const text = match[0].replace(TRAILING_PUNCTUATION, '')
        if (!text || match.index === undefined) continue
        links.push(makeLink(text, match.index, lineNumber, cells, (url) => window.runtime.BrowserOpenURL(url)))
      }
      for (const match of line.matchAll(IMAGE_PATH)) {
        const path = match[1]
        if (!path || match.index === undefined) continue
        links.push(
          makeLink(
            path,
            match.index,
            lineNumber,
            cells,
            () => openImagePath(termId, path),
            () => {
              const box = linkBox(term, cells, match.index!, path.length, lineNumber)
              if (box) showImageHover({ termId, path, ...box })
            },
            () => hideImageHover(termId, path)
          )
        )
      }
      for (const match of line.matchAll(FILE_PATH)) {
        const path = match[1]
        if (!path || match.index === undefined) continue
        links.push(makeLink(path, match.index, lineNumber, cells, () => openFilePath(termId, path)))
      }
      callback(links.length > 0 ? links : undefined)
    }
  })
  return () => {
    provider.dispose()
    window.removeEventListener('keydown', updateModifier)
    window.removeEventListener('keyup', updateModifier)
    window.removeEventListener('blur', clearModifier)
  }
}
