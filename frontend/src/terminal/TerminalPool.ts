import { Terminal, type ITheme } from '@xterm/xterm'
import { composeTerminalRange } from './composeGl'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import { bindFullscreenWheel } from './fullscreenWheel'
import { bindIme } from './ime'
import { terminalPalette } from '../theme/terminalThemes'

/**
 * 进程级 xterm 单例池（关键设计，见 docs/技术方案.md §4.2）：
 *
 * 每个终端（= 标签页）对应全应用唯一的 Terminal 实例，挂在游离的 host div 上。
 * 视图挂载时只做 re-parent（appendChild），卸载时 detach 而不销毁 ——
 * 这样切换标签、折叠面板后 scrollback 缓冲不丢失，TUI 程序无需重绘。
 *
 * 渲染器：WebGL 为默认（GPU 加速），context loss 时自动重建；失败回退 Canvas。
 */

interface PoolEntry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  disposeData: () => void
  disposeScrollHint: () => void
  disposeMouse: () => void
  settled: boolean
}

// 与默认外观 Source Code Pro 的字体栈一致，外观设置推过来之前先用这一套。
const DEFAULT_FONT_FAMILY = '"SauceCodePro Nerd Font Mono", Consolas, "Cascadia Mono", "Microsoft YaHei", monospace'

export interface TermLook {
  cols: number
  rows: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  theme: ITheme
  background: string
}

class TerminalPool {
  private entries = new Map<string, PoolEntry>()
  private palette: ITheme = terminalPalette('termius-dark').theme
  /** 字体设置来自外观配置，启动时 applyAppearance 会推过来。 */
  private font = { family: DEFAULT_FONT_FAMILY, size: 14 }

  /** 换终端配色。已经打开的终端一起改，后面新建的也用这一套。 */
  setTheme(theme: ITheme): void {
    this.palette = theme
    for (const entry of this.entries.values()) this.paint(entry)
  }

  /** 换终端字体/字号。已经打开的终端一起改并重排，后面新建的也用这一套。 */
  setFont(family: string, size: number): void {
    this.font = { family, size }
    for (const entry of this.entries.values()) {
      entry.term.options.fontFamily = family
      entry.term.options.fontSize = size
      entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
      try {
        entry.fit.fit()
      } catch {
        /* 容器不可见时 fit 会抛错，忽略 */
      }
    }
    // @font-face 用到才下载。上面量格子、画字形时内嵌字体多半还没到，
    // 用的是后备字体，xterm 之后也不会自己重量，所以等字体到了再按新字体重排一遍。
    void loadFonts(family, size).then(() => {
      if (this.font.family !== family || this.font.size !== size) return
      for (const entry of this.entries.values()) {
        entry.term.options.fontSize = size + 1
        entry.term.options.fontSize = size
      }
      this.clearGlyphAtlas()
      for (const termId of this.entries.keys()) this.fit(termId)
    })
  }

  ensure(termId: string): PoolEntry {
    const existing = this.entries.get(termId)
    if (existing) return existing

    const term = new Terminal({
      fontFamily: this.font.family,
      fontSize: this.font.size,
      lineHeight: 1,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 50000,
      allowProposedApi: true,
      theme: this.palette
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    // 默认按 Unicode 6 算宽度，✨ 这类 emoji 只占一格，后面的字会压上来。
    // 字素簇宽度和 Pi 一致：⚠️ 这类带样式选择符的字符占两格，
    // 全屏程序按这个宽度画的滚动条才不会整列错开。插件会把宽度版本设成 15-graphemes。
    term.loadAddon(new UnicodeGraphemesAddon())

    const host = document.createElement('div')
    host.style.width = '100%'
    host.style.height = '100%'
    host.style.overflow = 'hidden'
    term.open(host)
    host.style.background = this.palette.background ?? ''
    bindClipboardKeys(term)
    bindOsc52(term)
    bindIme(host, term)
    const disposeMouse = bindFullscreenWheel(host, term)

    this.enableWebgl(term)

    // 键盘/粘贴输入 → 主进程
    term.onData((d) => window.api.term.input(termId, d))
    // xterm 尺寸变化（fit 之后）→ 同步远端 PTY 窗口
    term.onResize(({ cols, rows }) => window.api.term.resize(termId, cols, rows))

    // 主进程数据 → xterm
    const disposeData = window.api.term.onData((id, data) => {
      if (id === termId) term.write(data)
    })
    window.api.term.bindView(termId)

    const entry: PoolEntry = {
      term,
      fit,
      host,
      disposeData,
      disposeScrollHint: bindScrollHint(host, term),
      disposeMouse,
      settled: false
    }
    this.entries.set(termId, entry)
    return entry
  }

  /** 挂载到指定容器（re-parent），并做一次同步 fit + 下一帧 refit 强制重绘 */
  attach(termId: string, el: HTMLElement): void {
    const e = this.ensure(termId)
    if (e.host.parentElement !== el) el.appendChild(e.host)
    bindClipboardKeys(e.term)
    this.fit(termId)
    this.scheduleSettle(termId)
    // 菜单关掉时会把焦点还给「新建」按钮，而且往往排在下一帧之后。
    // 多补几次，保证新开的终端不用再点一下才能打字。
    const focus = () => {
      if (e.host.isConnected) e.term.focus()
    }
    focus()
    requestAnimationFrame(() => {
      if (e.host.parentElement === el) {
        this.fit(termId)
        focus()
        e.host.scrollLeft = 0
      }
    })
    window.setTimeout(focus, 0)
    window.setTimeout(focus, 60)
    window.setTimeout(focus, 180)
  }

  /**
   * 第一次画的时候 WebGL 画布像素和格子对不齐，正文会往左裁掉一截。
   * 拖动窗口会强制按新尺寸重画，所以能自己对齐。字体加载完再按同样的字号
   * 触发一次重画，就不用等用户去拖。
   */
  private scheduleSettle(termId: string): void {
    const entry = this.entries.get(termId)
    if (!entry || entry.settled) return
    entry.settled = true
    const run = () => {
      if (!entry.host.isConnected) return
      const size = entry.term.options.fontSize
      if (size) {
        entry.term.options.fontSize = size + 1
        entry.term.options.fontSize = size
      }
      this.clearGlyphAtlas()
      this.fit(termId)
      entry.host.scrollLeft = 0
    }
    void loadFonts(this.font.family, this.font.size).then(() => {
      requestAnimationFrame(run)
      window.setTimeout(run, 200)
    })
  }

  /**
   * 同字体同配色的终端共用一张 WebGL 字形图。只清一个终端的话，图被它重新排过，
   * 其它终端还按旧坐标取字，画面就成了碎片，要拖一下窗口才恢复。所以一起清。
   */
  private clearGlyphAtlas(): void {
    for (const entry of this.entries.values()) entry.term.clearTextureAtlas()
  }

  detach(termId: string): void {
    const e = this.entries.get(termId)
    if (e?.host.parentElement) e.host.parentElement.removeChild(e.host)
  }

  fit(termId: string): void {
    const e = this.entries.get(termId)
    if (!e || !e.host.parentElement) return
    try {
      e.fit.fit()
    } catch {
      /* 容器不可见（0 尺寸）时 fit 会抛错，忽略 */
    }
  }

  /** 向终端写入文本（用于打印连接错误等本地提示） */
  write(termId: string, text: string): void {
    this.entries.get(termId)?.term.write(text)
  }

  /**
   * 字符网格的位置。截图用这块，不把滚动条和外面的留白拍进去，
   * 这样每一行在图片里的高度是稳定的。
   */
  screenRect(termId: string): { x: number; y: number; width: number; height: number } | null {
    const host = this.entries.get(termId)?.host
    const screen = host?.querySelector('.xterm-screen')
    if (screen instanceof HTMLElement && screen.isConnected) return boxOf(screen)
    return this.clientRect(termId)
  }

  /** 终端视图在页面上的位置。没挂到画面上时返回 null */
  clientRect(termId: string): { x: number; y: number; width: number; height: number } | null {
    const host = this.entries.get(termId)?.host
    if (!host?.isConnected) return null
    return boxOf(host)
  }

  /** 新建一块终端重画某一段时，沿用这一份字体和颜色。 */
  look(termId: string): TermLook | null {
    const term = this.entries.get(termId)?.term
    if (!term) return null
    const theme = term.options.theme ?? this.palette
    return {
      cols: term.cols,
      rows: term.rows,
      fontFamily: term.options.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: term.options.fontSize ?? 14,
      lineHeight: term.options.lineHeight ?? 1,
      theme,
      background: theme.background ?? this.palette.background ?? '#000000'
    }
  }

  /** 按缓冲格子用 WebGL 贴出这一段的 PNG。行号含首不含尾。 */
  composeRange(termId: string, start: number, end: number, cellWidth: number, cellHeight: number): string | null {
    const term = this.entries.get(termId)?.term
    if (!term || end <= start || cellWidth < 1 || cellHeight < 1) return null
    const theme = term.options.theme ?? this.palette
    return composeTerminalRange(term, start, end, {
      cellWidth,
      cellHeight,
      fontFamily: term.options.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: term.options.fontSize ?? 14,
      theme
    })
  }

  size(termId: string): { cols: number; rows: number } | null {
    const term = this.entries.get(termId)?.term
    if (!term) return null
    return { cols: term.cols, rows: term.rows }
  }

  pageInfo(termId: string): { viewportY: number; length: number; rows: number } | null {
    const term = this.entries.get(termId)?.term
    if (!term) return null
    return {
      viewportY: term.buffer.active.viewportY,
      length: term.buffer.active.length,
      rows: term.rows
    }
  }

  scrollTo(termId: string, line: number): void {
    this.entries.get(termId)?.term.scrollToLine(line)
  }

  /**
   * 当前选区。startLine 含、endLine 不含，和截图的行号一致。
   * xterm 内部行号是 0 起始的缓冲行。
   */
  selectionRange(termId: string): { text: string; startLine: number; endLine: number } | null {
    const term = this.entries.get(termId)?.term
    if (!term?.hasSelection()) return null
    const pos = term.getSelectionPosition()
    if (!pos) return null
    const backward = pos.start.y > pos.end.y || (pos.start.y === pos.end.y && pos.start.x > pos.end.x)
    const from = backward ? pos.end : pos.start
    const to = backward ? pos.start : pos.end
    let endLine = to.y
    if (to.x === 0 && endLine > from.y) endLine -= 1
    return { text: term.getSelection(), startLine: from.y, endLine: endLine + 1 }
  }

  /** 当前程序是否把方向键切到了应用光标模式。没有这个终端时当普通模式。 */
  applicationCursor(termId: string): boolean {
    return this.entries.get(termId)?.term.modes.applicationCursorKeysMode ?? false
  }

  paste(termId: string, text: string): void {
    const term = this.entries.get(termId)?.term
    if (!term || !text) return
    term.paste(text)
    term.focus()
  }

  focus(termId: string): void {
    this.entries.get(termId)?.term.focus()
  }

  /** 读出缓冲里的行。start 含、end 不含。没传范围时返回当前画面。 */
  bufferLines(
    termId: string,
    start?: number,
    end?: number
  ): { length: number; viewportY: number; rows: number; lines: { n: number; text: string }[] } | null {
    const term = this.entries.get(termId)?.term
    if (!term) return null
    const buffer = term.buffer.active
    const length = buffer.length
    const rows = Math.max(1, term.rows)
    const from = clampLine(start ?? buffer.viewportY, length)
    const to = clampLine(end ?? from + rows, length)
    const lines: { n: number; text: string }[] = []
    const last = Math.min(length, from + 200, Math.max(from, to))
    for (let n = from; n < last; n++) {
      lines.push({ n, text: buffer.getLine(n)?.translateToString(true) ?? '' })
    }
    return { length, viewportY: buffer.viewportY, rows, lines }
  }

  dispose(termId: string): void {
    const e = this.entries.get(termId)
    if (!e) return
    e.disposeMouse()
    e.disposeData()
    e.disposeScrollHint()
    e.term.dispose()
    this.entries.delete(termId)
  }

  private paint(entry: PoolEntry): void {
    entry.term.options.theme = this.palette
    entry.host.style.background = this.palette.background ?? ''
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
  }

  private enableWebgl(term: Terminal): void {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        // GPU 驱动崩溃 / 休眠恢复后重建渲染器
        webgl.dispose()
        this.enableWebgl(term)
      })
      term.loadAddon(webgl)
    } catch {
      // WebGL 不可用时 xterm 自动回退 Canvas 渲染器
    }
  }
}

/**
 * 滚动时给 host 加 term-scrolling 露出细滚动条，停滚 3 秒摘掉。
 * 滚动事件走 xterm 的 onScroll API（不依赖内部 DOM，滚轮/拖滑块/程序滚动都覆盖）。
 * 按住滑块拖的时候（指针没抬）不摘，免得拖到一半条没了。
 * 返回清理函数，终端销毁时调用。
 */
function bindScrollHint(host: HTMLDivElement, term: Terminal): () => void {
  // xterm 6 的自绘滚动条在 viewport 外面,拖它也要算"按住"
  const scrollbar = host.querySelector('.xterm-scrollable-element > .scrollbar')
  let timer = 0
  let holding = false
  const show = () => {
    host.classList.add('term-scrolling')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (!holding) host.classList.remove('term-scrolling')
    }, 3000)
  }
  const onDown = () => {
    holding = true
  }
  const onUp = () => {
    holding = false
    // 拖着滑块按住不动时倒计时被挂起，松手后若条还亮着就重新起 3 秒倒计时
    if (host.classList.contains('term-scrolling')) show()
  }
  // 鼠标离开终端立即隐藏（拖住滑块时除外）
  const onLeave = () => {
    if (holding) return
    window.clearTimeout(timer)
    host.classList.remove('term-scrolling')
  }
  const disposeScroll = term.onScroll(show)
  scrollbar?.addEventListener('pointerdown', onDown)
  host.addEventListener('pointerleave', onLeave)
  window.addEventListener('pointerup', onUp)
  return () => {
    window.clearTimeout(timer)
    disposeScroll.dispose()
    scrollbar?.removeEventListener('pointerdown', onDown)
    host.removeEventListener('pointerleave', onLeave)
    window.removeEventListener('pointerup', onUp)
  }
}

export function normalizeTerminalCopy(text: string): string {
  return text.replace(/[ \t]+(?=\r\n|\n|\r|$)/g, '')
}

/** Ctrl/Cmd+C 有选区就复制，否则仍是中断。Ctrl/Cmd+V 只粘贴，不把控制字符发给远端。 */
function bindClipboardKeys(term: Terminal): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.altKey) return true
    const key = event.key.toLowerCase()
    const mac = window.api.platform === 'darwin'
    const mod = mac ? event.metaKey : event.ctrlKey
    const copy = (mod && !event.shiftKey && key === 'c') || (event.ctrlKey && event.shiftKey && !event.metaKey && key === 'c')
    const paste =
      (mod && !event.shiftKey && key === 'v') || (event.ctrlKey && event.shiftKey && !event.metaKey && key === 'v')
    const insertCopy = event.ctrlKey && !event.shiftKey && !event.metaKey && event.key === 'Insert'
    const insertPaste = event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'Insert'

    if ((copy || insertCopy) && (event.shiftKey || event.key === 'Insert' || term.hasSelection())) {
      event.preventDefault()
      const text = term.getSelection()
      if (text) void navigator.clipboard.writeText(normalizeTerminalCopy(text))
      return false
    }
    if (paste || insertPaste) {
      event.preventDefault()
      void navigator.clipboard.readText().then((text) => {
        if (text) term.paste(text)
      })
      return false
    }
    return true
  })
}

/** 正文、加粗都要用到，各拉一份。加载失败就当后备字体，不挡后面的重排。 */
function loadFonts(family: string, size: number): Promise<unknown> {
  return Promise.all(
    ['400', '700'].map((weight) => document.fonts.load(`${weight} ${size}px ${family}`).catch(() => []))
  )
}

const OSC52_MAX_BASE64 = 8 * 1024 * 1024

/**
 * OSC 52：远端程序（SSH 上的 pi、vim、tmux 等）要写本机剪贴板，xterm 自己不处理。
 * 只接写入；Pd 为 ? 是读剪贴板，不答，免得远端读走本机内容。
 * 写剪贴板走 Wails 的 Go 端，WebView 的 navigator.clipboard 没有用户手势时可能被拒。
 */
function bindOsc52(term: Terminal): void {
  term.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';')
    if (sep < 0) return true
    const payload = data.slice(sep + 1)
    if (!payload || payload === '?' || payload.length > OSC52_MAX_BASE64) return true
    let text: string
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      text = new TextDecoder().decode(bytes)
    } catch {
      return true
    }
    const write = window.runtime?.ClipboardSetText
    if (write) {
      void write(text).catch(() => navigator.clipboard.writeText(text).catch(() => undefined))
    } else {
      void navigator.clipboard.writeText(text).catch(() => undefined)
    }
    return true
  })
}

function clampLine(line: number, length: number): number {
  if (!Number.isFinite(line)) return 0
  return Math.max(0, Math.min(length, Math.floor(line)))
}

function boxOf(el: HTMLElement): { x: number; y: number; width: number; height: number } | null {
  const rect = el.getBoundingClientRect()
  const box = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
  if (box.width < 2 || box.height < 2) return null
  return box
}

export const terminalPool = new TerminalPool()
