import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import Editor, { loader } from '@monaco-editor/react'
import { Maximize, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import * as monaco from 'monaco-editor'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { readBuffer, writeBuffer } from '../editor/editorBuffers'
import { bindMiddleScroll } from '../editor/middleScroll'
import { useAppStore, type EditorTab } from '../stores/useAppStore'
import { terminalFontStack } from '../theme/applyAppearance'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}
loader.config({ monaco })

// 单个文件打开时没有 node_modules、tsconfig 这些项目环境，语言检查几乎全是误报，只保留高亮
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true })
}
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false })
for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) {
  defaults.setOptions({ ...defaults.options, validate: false })
}

const EDITOR_THEME = 'termpilot'

/** 主题变量是 applyAppearance 内联到根元素上的十六进制色，Monaco 只认这种格式。 */
function cssColor(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value : undefined
}

function defineEditorTheme(dark: boolean): void {
  const colors: Record<string, string> = {}
  const pick = (key: string, variable: string) => {
    const value = cssColor(variable)
    if (value) colors[key] = value
  }
  pick('editor.background', '--background')
  pick('editor.foreground', '--foreground')
  pick('editorGutter.background', '--background')
  pick('editorLineNumber.foreground', '--muted-foreground')
  pick('editorLineNumber.activeForeground', '--foreground')
  pick('editor.lineHighlightBackground', '--muted')
  pick('editor.selectionBackground', '--accent')
  pick('editorCursor.foreground', '--primary')
  pick('editorWidget.background', '--card')
  pick('editorWidget.border', '--border')
  pick('editorSuggestWidget.background', '--card')
  pick('editorHoverWidget.background', '--card')
  pick('input.background', '--muted')
  pick('focusBorder', '--ring')
  const primary = cssColor('--primary')?.slice(0, 7)
  if (primary) {
    colors['scrollbarSlider.background'] = `${primary}99`
    colors['scrollbarSlider.hoverBackground'] = `${primary}cc`
    colors['scrollbarSlider.activeBackground'] = `${primary}ee`
  }
  monaco.editor.defineTheme(EDITOR_THEME, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors })
  monaco.editor.setTheme(EDITOR_THEME)
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

function imageType(name: string): string | undefined {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return IMAGE_TYPES[ext]
}

export function isImage(name: string): boolean {
  return imageType(name) !== undefined
}

const errorText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(e)

/** 主区域里打开的文件：图片显示预览，其余进文本编辑器。 */
export function RemoteEditor(props: { tab: EditorTab }) {
  return isImage(props.tab.name) ? <ImagePreview tab={props.tab} /> : <TextEditor tab={props.tab} />
}

const MIN_SCALE = 0.05
const MAX_SCALE = 32
const ZOOM_STEP = 1.25
const VIEW_PADDING = 32
const IMAGE_TOOL =
  'flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

type ImageControls = {
  size: { w: number; h: number }
  scale: number
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  actual: () => void
  rotate: (delta: number) => void
}

/** 打开着的图片预览把缩放旋转操作登记在这里，标签栏右侧的工具按钮按标签 key 取用 */
const imageControls = new Map<string, ImageControls>()
const controlListeners = new Set<() => void>()

function publishControls(key: string, controls: ImageControls | null): void {
  if (controls) imageControls.set(key, controls)
  else imageControls.delete(key)
  for (const listener of controlListeners) listener()
}

function subscribeControls(listener: () => void): () => void {
  controlListeners.add(listener)
  return () => controlListeners.delete(listener)
}

/** 正在编辑的文本把保存函数登记在这里，标签栏的保存按钮按标签 key 调用。 */
const textSaves = new Map<string, () => Promise<void>>()

export function saveTextFile(key: string): Promise<void> | undefined {
  return textSaves.get(key)?.()
}

/** 标签栏右侧的图片工具：尺寸、缩放、旋转 */
export function ImageTools(props: { tabKey: string }) {
  const controls = useSyncExternalStore(subscribeControls, () => imageControls.get(props.tabKey))
  if (!controls) return null
  return (
    <>
      <span className="shrink-0 px-2 text-xs text-muted-foreground tabular-nums">
        {controls.size.w} × {controls.size.h}
      </span>
      <button type="button" title="缩小（-）" className={IMAGE_TOOL} onClick={controls.zoomOut}>
        <ZoomOut className="size-4" />
      </button>
      <span className="w-11 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
        {Math.round(controls.scale * 100)}%
      </span>
      <button type="button" title="放大（+）" className={IMAGE_TOOL} onClick={controls.zoomIn}>
        <ZoomIn className="size-4" />
      </button>
      <button type="button" title="适应窗口（0）" className={IMAGE_TOOL} onClick={controls.fit}>
        <Maximize className="size-4" />
        适应
      </button>
      <button type="button" title="原始大小（1）" className={IMAGE_TOOL} onClick={controls.actual}>
        1:1
      </button>
      <button type="button" title="向左旋转（Shift+R）" className={IMAGE_TOOL} onClick={() => controls.rotate(-90)}>
        <RotateCcw className="size-4" />
      </button>
      <button type="button" title="向右旋转（R）" className={IMAGE_TOOL} onClick={() => controls.rotate(90)}>
        <RotateCw className="size-4" />
      </button>
    </>
  )
}

/**
 * 图片预览。默认缩放到能看全（小图不放大），点一下在原始大小和适应窗口之间切换。
 * Ctrl+滚轮以鼠标位置为中心缩放；+ - 0 1 R 键分别是放大、缩小、适应、原始大小、旋转。
 * 读出的 data URL 放在编辑器缓存里，切标签不重新下载，关标签时一起丢掉。
 */
function ImagePreview(props: { tab: EditorTab }) {
  const tab = props.tab
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState({ w: 0, h: 0 })
  /** null 表示适应窗口，随窗口大小变化 */
  const [zoom, setZoom] = useState<number | null>(null)
  const [rotation, setRotation] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 缩放前鼠标所在的图片相对位置，缩放后把它滚回鼠标下面 */
  const anchorRef = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)

  const sideways = rotation % 180 !== 0
  const boxW = size ? (sideways ? size.h : size.w) : 0
  const boxH = size ? (sideways ? size.w : size.h) : 0
  const fit =
    size && view.w > 0
      ? Math.min(1, Math.max(view.w - VIEW_PADDING, 1) / boxW, Math.max(view.h - VIEW_PADDING, 1) / boxH)
      : 1
  const scale = zoom ?? fit

  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const root = rootRef.current
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
    if (root && size) {
      const rect = root.getBoundingClientRect()
      const x = at ? at.x - rect.left : rect.width / 2
      const y = at ? at.y - rect.top : rect.height / 2
      const contentW = Math.max(boxW * scale + VIEW_PADDING, rect.width)
      const contentH = Math.max(boxH * scale + VIEW_PADDING, rect.height)
      anchorRef.current = { fx: (root.scrollLeft + x) / contentW, fy: (root.scrollTop + y) / contentH, x, y }
    }
    setZoom(clamped)
  }

  const rotate = (delta: number) => {
    anchorRef.current = null
    setRotation((r) => (r + delta + 360) % 360)
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    const anchor = anchorRef.current
    anchorRef.current = null
    if (!root || !anchor) return
    root.scrollLeft = anchor.fx * root.scrollWidth - anchor.x
    root.scrollTop = anchor.fy * root.scrollHeight - anchor.y
  }, [zoom])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => setView({ w: root.clientWidth, h: root.clientHeight }))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !size) return
      e.preventDefault()
      zoomTo(scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), { x: e.clientX, y: e.clientY })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (!size || e.ctrlKey || e.altKey || e.metaKey) return
    const actions: Record<string, () => void> = {
      '+': () => zoomTo(scale * ZOOM_STEP),
      '=': () => zoomTo(scale * ZOOM_STEP),
      '-': () => zoomTo(scale / ZOOM_STEP),
      '0': () => setZoom(null),
      '1': () => zoomTo(1),
      r: () => rotate(90),
      R: () => rotate(-90)
    }
    const action = actions[e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  useEffect(() => {
    let cancelled = false
    const cached = readBuffer(tab.key)
    if (cached?.loaded) {
      setSrc(cached.text)
      setError(cached.error)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const read = tab.sessionId
      ? window.api.sftp.readImage(tab.sessionId, tab.path)
      : window.api.localfs.readImage(tab.path)
    read
      .then((base64) => {
        const url = `data:${imageType(tab.name)};base64,${base64}`
        writeBuffer(tab.key, { text: url, saved: url, loaded: true, error: '' })
        if (!cancelled) setSrc(url)
      })
      .catch((e) => {
        const message = errorText(e)
        writeBuffer(tab.key, { text: '', saved: '', loaded: true, error: message })
        if (!cancelled) setError(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab.key, tab.path, tab.sessionId, tab.name])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return bindMiddleScroll(root, (dx, dy) => root.scrollBy(dx, dy))
  }, [])

  useEffect(() => {
    if (!size) return
    publishControls(tab.key, {
      size,
      scale,
      zoomIn: () => zoomTo(scale * ZOOM_STEP),
      zoomOut: () => zoomTo(scale / ZOOM_STEP),
      fit: () => setZoom(null),
      actual: () => zoomTo(1),
      rotate
    })
    return () => publishControls(tab.key, null)
  })

  const zoomedIn = zoom !== null && zoom > fit + 1e-6

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={rootRef} tabIndex={0} className="min-h-0 flex-1 overflow-auto outline-none" onKeyDown={onKeyDown}>
        {loading && <p className="p-4 text-xs text-muted-foreground">正在读取图片…</p>}
        {!loading && src && (
          <div className="flex min-h-full min-w-full w-max p-4">
            <div className="relative m-auto shrink-0" style={{ width: boxW * scale, height: boxH * scale }}>
              <img
                src={src}
                alt={tab.name}
                draggable={false}
                title={zoomedIn ? '点击缩放到窗口大小' : '点击查看原始大小'}
                className={cn(
                  'absolute top-1/2 left-1/2 max-w-none bg-[image:conic-gradient(#8884_25%,transparent_0_50%,#8884_0_75%,transparent_0)] bg-[length:16px_16px]',
                  size ? '' : 'invisible',
                  zoomedIn ? 'cursor-zoom-out' : 'cursor-zoom-in'
                )}
                style={{
                  width: size ? size.w * scale : undefined,
                  height: size ? size.h * scale : undefined,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  imageRendering: scale >= 4 ? 'pixelated' : undefined
                }}
                onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onError={() => setError('图片无法显示，可能已损坏或格式不受支持')}
                onClick={(e) => (zoomedIn ? setZoom(null) : zoomTo(fit < 1 ? 1 : fit * 2, { x: e.clientX, y: e.clientY }))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 文本编辑器。Ctrl/Cmd+S 写回原文件（SSH 服务器或本机）。查看模式只读，Markdown 显示渲染结果。 */
function TextEditor(props: { tab: EditorTab }) {
  const tab = props.tab
  const setEditorDirty = useAppStore((s) => s.setEditorDirty)
  const pinEditorTab = useAppStore((s) => s.pinEditorTab)
  const dark = useAppStore((s) => s.resolvedApp === 'dark')
  const themeId = useAppStore((s) => s.appearance.theme)
  const fontFamily = useAppStore((s) => terminalFontStack(s.appearance.terminalFont))
  const fontSize = useAppStore((s) => s.appearance.terminalSize)
  const wrap = useAppStore((s) => s.editorWrap)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const textRef = useRef('')
  const savedRef = useRef('')

  const remember = (next: string, saved: string) => {
    textRef.current = next
    savedRef.current = saved
    writeBuffer(tab.key, { text: next, saved, loaded: true, error: '' })
    const dirty = next !== saved
    const row = useAppStore.getState().editorTabs.find((t) => t.key === tab.key)
    if (row && row.dirty !== dirty) setEditorDirty(tab.key, dirty)
    if (row?.preview && dirty) pinEditorTab(tab.key)
  }

  const load = useCallback(async () => {
    const cached = readBuffer(tab.key)
    if (cached?.loaded) {
      textRef.current = cached.text
      savedRef.current = cached.saved
      setText(cached.text)
      setError(cached.error)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const content = tab.sessionId
        ? await window.api.sftp.read(tab.sessionId, tab.path)
        : await window.api.localfs.read(tab.path)
      textRef.current = content
      savedRef.current = content
      writeBuffer(tab.key, { text: content, saved: content, loaded: true, error: '' })
      setText(content)
    } catch (e) {
      const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(e)
      writeBuffer(tab.key, { text: '', saved: '', loaded: true, error: message })
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [tab.key, tab.path, tab.sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    try {
      if (tab.sessionId) {
        await window.api.sftp.write(tab.sessionId, tab.path, textRef.current)
      } else {
        await window.api.localfs.write(tab.path, textRef.current)
      }
      remember(textRef.current, textRef.current)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(e))
    }
  }, [tab.key, tab.path, tab.sessionId])

  useEffect(() => {
    textSaves.set(tab.key, save)
    return () => {
      if (textSaves.get(tab.key) === save) textSaves.delete(tab.key)
    }
  }, [tab.key, save])

  useEffect(() => {
    defineEditorTheme(dark)
  }, [dark, themeId])

  // 内嵌字体用到才下载，Monaco 先按后备字体量了字宽，到了要重量，否则光标和字错位
  useEffect(() => {
    void document.fonts.load(`${fontSize}px ${fontFamily}`).then(() => monaco.editor.remeasureFonts())
  }, [fontFamily, fontSize])

  const showPreview = tab.readOnly && isMarkdown(tab.name)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1">
        {!loading && !error && showPreview && <MarkdownPreview text={text} />}
        {!loading && !error && !showPreview && (
          <Editor
            height="100%"
            language={languageOf(tab.name)}
            theme={EDITOR_THEME}
            value={text}
            beforeMount={() => defineEditorTheme(dark)}
            onChange={(value) => {
              const next = value ?? ''
              setText(next)
              remember(next, savedRef.current)
            }}
            onMount={(ed, api) => {
              ed.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => void save())
              const unbind = bindMiddleScroll(ed.getContainerDomNode(), (dx, dy) =>
                ed.setScrollPosition({ scrollLeft: ed.getScrollLeft() + dx, scrollTop: ed.getScrollTop() + dy })
              )
              ed.onDidDispose(unbind)
            }}
            options={{
              automaticLayout: true,
              fontFamily,
              fontSize,
              readOnly: tab.readOnly,
              readOnlyMessage: { value: '查看模式，点右上角“编辑”后可修改' },
              minimap: { enabled: false },
              overviewRulerLanes: 0,
              // 中文里的全角括号、逗号会被当成易混淆字符加框
              unicodeHighlight: { ambiguousCharacters: false },
              scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false },
              scrollBeyondLastLine: false,
              wordWrap: wrap ? 'on' : 'off'
            }}
          />
        )}
      </div>
    </div>
  )
}

function MarkdownPreview(props: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true })),
    [props.text]
  )
  // 链接默认会把整个应用窗口导航走，外链交给系统浏览器，其他链接不响应
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) window.runtime.BrowserOpenURL(href)
  }
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!root || !viewport) return
    return bindMiddleScroll(root, (dx, dy) => viewport.scrollBy(dx, dy))
  }, [])
  return (
    <ScrollArea ref={rootRef} className="h-full">
      <div className="markdown-body mx-auto max-w-4xl px-8 py-6" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </ScrollArea>
  )
}

function languageOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const known: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    xml: 'xml',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    vue: 'html'
  }
  return known[ext] ?? 'plaintext'
}
