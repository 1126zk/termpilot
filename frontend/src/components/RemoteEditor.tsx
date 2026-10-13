import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { ScrollArea } from '@/components/ui/scroll-area'
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

/** 主区域里的文本编辑器。Ctrl/Cmd+S 写回原文件（SSH 服务器或本机）。查看模式只读，Markdown 显示渲染结果。 */
export function RemoteEditor(props: { tab: EditorTab }) {
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
