import { useEffect, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Expand, Play, Shrink } from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import mermaid from 'mermaid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { mountMermaidViewport } from '../mermaidViewport'
import { startPointerDrag } from '../flip'
import type { ToolProps } from '../ToolsPage'

type Mode = 'mermaid' | 'markdown'

const MODE_KEY = 'termpilot.tool.previewMode'
const MERMAID_KEY = 'termpilot.tool.mermaidViewer'
const MARKDOWN_KEY = 'termpilot.tool.markdownViewer'
const SPLIT_KEY = 'termpilot.tool.previewSplit'

const DEFAULT_MERMAID = `flowchart LR
  A[开始] --> B{判断}
  B -->|是| C[执行]
  B -->|否| D[结束]`
const DEFAULT_MARKDOWN = `# Markdown 预览

支持 **粗体**、*斜体*、~~删除线~~、\`行内代码\`。

## 列表

- 第一项
- 第二项
  - 嵌套项

## 代码

\`\`\`bash
echo "hello"
\`\`\`

## Mermaid

\`\`\`mermaid
flowchart LR
  A[源码] --> B[渲染]
\`\`\`
`

let seq = 0

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  look: 'neo',
  htmlLabels: false,
  themeVariables: {
    background: 'transparent',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '14px',
    primaryColor: '#1f2937',
    primaryTextColor: '#e5e7eb',
    primaryBorderColor: '#64748b',
    secondaryColor: '#111827',
    tertiaryColor: 'transparent',
    textColor: '#e5e7eb',
    titleColor: '#e5e7eb',
    lineColor: '#64748b',
    clusterBkg: 'rgba(148, 163, 184, 0.06)',
    clusterBorder: '#334155',
    edgeLabelBackground: '#1f2937'
  },
  flowchart: {
    nodeSpacing: 36,
    rankSpacing: 42
  }
})

function readMode(): Mode {
  return localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'mermaid'
}

function readRatio(): number {
  const value = Number(localStorage.getItem(SPLIT_KEY))
  return value >= 0.15 && value <= 0.85 ? value : 1 / 3
}

/** 粘贴内容最外层被 ```markdown / ```md / ``` 完整包裹时，剥掉这层围栏再渲染。 */
function stripFence(text: string): string {
  const match = /^\s*```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text)
  return match ? match[1] : text
}

/** 去掉所有非空行的公共前导缩进，避免整体缩进被 Markdown 当成代码块。 */
function dedent(text: string): string {
  const lines = text.split('\n')
  let min = Infinity
  for (const line of lines) {
    if (!line.trim()) continue
    const indent = /^[ \t]*/.exec(line)![0].length
    min = Math.min(min, indent)
  }
  if (!Number.isFinite(min) || min === 0) return text
  return lines.map((line) => line.slice(min)).join('\n')
}

const icons = {
  expand: renderToStaticMarkup(<Expand className="size-4" strokeWidth={2} />),
  shrink: renderToStaticMarkup(<Shrink className="size-4" strokeWidth={2} />)
}

const modeBtn =
  'flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

/** 预览：Mermaid / Markdown 合一，代码区顶部一行选择模式，两种内容分别记忆。 */
export function PreviewViewer(props: ToolProps) {
  const [mode, setMode] = useState<Mode>(readMode)
  const [mermaidCode, setMermaidCode] = useState(() => localStorage.getItem(MERMAID_KEY) ?? DEFAULT_MERMAID)
  const [markdownCode, setMarkdownCode] = useState(() =>
    stripFence(localStorage.getItem(MARKDOWN_KEY) ?? DEFAULT_MARKDOWN)
  )
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [diagramOnly, setDiagramOnly] = useState(false)
  const [ratio, setRatio] = useState(readRatio)
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  const splitRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const code = mode === 'mermaid' ? mermaidCode : markdownCode

  const startSplitDrag = (event: React.PointerEvent) => {
    event.preventDefault()
    startPointerDrag({
      event,
      axis: 'x',
      threshold: 0,
      onActivate: () => undefined,
      onMove: (x) => {
        const el = splitRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        setRatio(Math.min(0.85, Math.max(0.15, (x - rect.left) / rect.width)))
      },
      onEnd: () => {
        localStorage.setItem(SPLIT_KEY, String(ratioRef.current))
        setTick((v) => v + 1)
      }
    })
  }

  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode])
  useEffect(() => localStorage.setItem(MERMAID_KEY, mermaidCode), [mermaidCode])
  useEffect(() => localStorage.setItem(MARKDOWN_KEY, markdownCode), [markdownCode])

  // 全屏时其他工具收起，整个主界面都是这个工具
  const diagramEffectFirst = useRef(true)
  useEffect(() => {
    if (diagramEffectFirst.current) {
      diagramEffectFirst.current = false
      return
    }
    if (diagramOnly && !props.solo) props.onSolo?.()
    props.onFullDiagram?.(diagramOnly)
    setTick((v) => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramOnly])

  // 渲染：按当前模式走 Mermaid 或 Markdown，全屏按钮与 Mermaid 查看器一致放在预览控件组里
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    if (mode === 'mermaid') {
      if (!mermaidCode.trim()) {
        container.innerHTML = ''
        setError('')
        return
      }
      void mermaid
        .render(`preview-${++seq}`, mermaidCode)
        .then(({ svg }) => {
          if (cancelled || !container.isConnected) return
          container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
          container.querySelectorAll('[filter]').forEach((el) => el.removeAttribute('filter'))
          container.querySelectorAll('[stroke]').forEach((el) => {
            if ((el.getAttribute('stroke') ?? '').startsWith('url(')) el.setAttribute('stroke', '#64748b')
          })
          container.querySelectorAll('style').forEach((style) => {
            style.textContent = (style.textContent ?? '')
              .replace(/filter\s*:\s*drop-shadow\([^)]*\)\s*;?/gi, 'filter:none;')
              .replace(/stroke\s*:\s*url\(#[^)]+\)/gi, 'stroke:#64748b')
          })
          mountMermaidViewport(container, [
            {
              key: 'diagram',
              title: diagramOnly ? '返回编辑' : '整个页面展示',
              html: diagramOnly ? icons.shrink : icons.expand,
              onClick: () => setDiagramOnly((v) => !v)
            }
          ])
          setError('')
        })
        .catch(() => {
          if (!cancelled && container.isConnected) setError('Mermaid 渲染失败，请检查语法')
        })
      return
    }
    const source = dedent(stripFence(markdownCode))
    container.innerHTML = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }))
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
    for (const block of blocks) {
      const pre = block.parentElement
      if (!pre) continue
      const sourceText = block.textContent ?? ''
      void mermaid
        .render(`preview-md-${++seq}`, sourceText)
        .then(({ svg }) => {
          if (cancelled || !pre.isConnected) return
          const box = document.createElement('div')
          box.className = 'relative my-4 h-80 overflow-hidden rounded-md border border-border/60 bg-background select-none'
          box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
          box.querySelectorAll('[filter]').forEach((el) => el.removeAttribute('filter'))
          box.querySelectorAll('[stroke]').forEach((el) => {
            if ((el.getAttribute('stroke') ?? '').startsWith('url(')) el.setAttribute('stroke', '#64748b')
          })
          mountMermaidViewport(box)
          pre.replaceWith(box)
        })
        .catch(() => {
          // mermaid 语法错误时保留代码块原样
        })
    }
    return () => {
      cancelled = true
    }
  }, [mode, mermaidCode, markdownCode, tick, diagramOnly])

  return (
    <div ref={splitRef} className={cn('flex flex-row', diagramOnly ? 'min-h-0 flex-1' : 'h-96')}>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-r-md" style={{ width: `${ratio * 100}%` }}>
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-muted px-2 py-1 text-sm">
          {(['mermaid', 'markdown'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={cn(
                'rounded-md px-2.5 py-1',
                mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setMode(m)}
            >
              {m === 'mermaid' ? 'Mermaid' : 'Markdown'}
            </button>
          ))}
        </div>
        <textarea
          value={code}
          onChange={(e) => {
            const value = e.target.value
            if (mode === 'mermaid') setMermaidCode(value)
            else setMarkdownCode(stripFence(value))
          }}
          placeholder={mode === 'mermaid' ? '输入 Mermaid 代码' : '输入 Markdown 源码'}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-muted px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        {mode === 'mermaid' && error && <p className={cn('text-sm text-destructive', diagramOnly && 'px-3 py-2')}>{error}</p>}
        <div className="flex shrink-0 items-center border-t border-border/60 bg-muted px-2 py-1.5">
          <Button type="button" size="sm" className="w-full gap-1.5" onClick={() => setTick((v) => v + 1)}>
            <Play className="size-3.5" strokeWidth={2} />
            渲染
          </Button>
        </div>
      </div>
      <div className="w-1 shrink-0 cursor-col-resize" onPointerDown={startSplitDrag} />
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
        {mode === 'markdown' && (
          <div className="absolute top-2 right-2 z-10 flex items-center rounded-md border bg-card/95 shadow-sm">
            <button
              type="button"
              className={modeBtn}
              title={diagramOnly ? '返回编辑' : '整个页面展示'}
              onClick={() => setDiagramOnly((v) => !v)}
            >
              {diagramOnly ? <Shrink className="size-3.5" strokeWidth={2} /> : <Expand className="size-3.5" strokeWidth={2} />}
            </button>
          </div>
        )}
        <div ref={containerRef} className={mode === 'markdown' ? 'markdown-body px-4 py-3' : 'relative h-full select-none'} />
      </div>
    </div>
  )
}
