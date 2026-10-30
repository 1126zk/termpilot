import type { ILink, Terminal } from '@xterm/xterm'

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?，。；！？、]+$/

export function bindTerminalLinks(term: Terminal): () => void {
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

  const provider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1)?.translateToString(true) ?? ''
      const links: ILink[] = []
      for (const match of line.matchAll(URL_PATTERN)) {
        const raw = match[0]
        const text = raw.replace(TRAILING_PUNCTUATION, '')
        if (!text || match.index === undefined) continue
        const link: ILink = {
          text,
          decorations: { pointerCursor: false, underline: false },
          range: {
            start: { x: match.index + 1, y: lineNumber },
            end: { x: match.index + text.length, y: lineNumber }
          },
          activate: (event, url) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            window.runtime.BrowserOpenURL(url)
          },
          hover: (event) => {
            hovered = link
            updateModifier(event)
          },
          leave: () => {
            if (hovered === link) hovered = null
            if (link.decorations) {
              link.decorations.pointerCursor = false
              link.decorations.underline = false
            }
          }
        }
        links.push(link)
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
