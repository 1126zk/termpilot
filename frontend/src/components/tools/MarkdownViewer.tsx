import { useEffect, useRef, useState } from 'react'
import { Expand, Play, Shrink } from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import mermaid from 'mermaid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { mountMermaidViewport } from '../mermaidViewport'
import { startPointerDrag } from '../flip'
import type { ToolProps } from '../ToolsPage'

const STORAGE_KEY = 'termpilot.tool.markdownViewer'
const SPLIT_KEY = 'termpilot.tool.markdownSplit'
const DEFAULT_CODE = `# Markdown 预览

支持 **粗体**、*斜体*、~~删除线~~、\`行内代码\`。

## 列表

- 第一项
- 第二项
  - 嵌套项

## 代码

\`\`\`bash
echo "hello"
\`\`\`

## 表格

| 名称 | 说明 |
| --- | --- |
| 复制渲染 | 富文本，粘贴保留格式 |
| 复制源码 | Markdown 原文 |

## Mermaid

\`\`\`mermaid
flowchart LR
  A[源码] --> B[渲染]
\`\`\`
`

let seq = 0

function readCode(): string {
  return stripFence(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CODE)
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

/** 去掉所有非空行的公共前导缩进：粘贴来的文本常整体缩进，4 空格以上会被 Markdown 当成代码块。
    只减最小缩进量，嵌套列表的相对缩进保持不变。 */
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

const copyBtn =
  'flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

/** Markdown 预览：左边源码、右边渲染，布局与 Mermaid 查看器一致。
    右上角可复制渲染后的富文本、复制源码，或全屏展示。 */
export function MarkdownViewer(props: ToolProps) {
  const [code, setCode] = useState(readCode)
  const [tick, setTick] = useState(0)
  const [diagramOnly, setDiagramOnly] = useState(false)
  const [ratio, setRatio] = useState(readRatio)
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  const splitRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // mermaid 初始化与 MermaidViewer 共用（同一模块单例，那边已完成配置）

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
      onEnd: () => localStorage.setItem(SPLIT_KEY, String(ratioRef.current))
    })
  }

  // 全屏时其他工具收起，整个主界面都是这个工具（与 Mermaid 查看器同一套约定）
  const diagramEffectFirst = useRef(true)
  useEffect(() => {
    if (diagramEffectFirst.current) {
      diagramEffectFirst.current = false
      return
    }
    if (diagramOnly && !props.solo) props.onSolo?.()
    props.onFullDiagram?.(diagramOnly)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramOnly])

  const source = dedent(stripFence(code))

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, code)
    const root = previewRef.current
    if (!root) return
    root.innerHTML = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }))
    let cancelled = false
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
    for (const block of blocks) {
      const pre = block.parentElement
      if (!pre) continue
      const sourceText = block.textContent ?? ''
      void mermaid
        .render(`markdown-tool-${++seq}`, sourceText)
        .then(({ svg }) => {
          if (cancelled || !pre.isConnected) return
          const container = document.createElement('div')
          container.className = 'relative my-4 h-80 overflow-hidden rounded-md border border-border/60 bg-background select-none'
          container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
          container.querySelectorAll('[filter]').forEach((el) => el.removeAttribute('filter'))
          container.querySelectorAll('[stroke]').forEach((el) => {
            if ((el.getAttribute('stroke') ?? '').startsWith('url(')) el.setAttribute('stroke', '#64748b')
          })
          mountMermaidViewport(container)
          pre.replaceWith(container)
        })
        .catch(() => {
          // mermaid 语法错误时保留代码块原样，不影响其他内容渲染
        })
    }
    return () => {
      cancelled = true
    }
  }, [source, code, tick])

  return (
    <div ref={splitRef} className={cn('flex flex-row', diagramOnly ? 'min-h-0 flex-1' : 'h-96')}>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-r-md" style={{ width: `${ratio * 100}%` }}>
        <textarea
          value={code}
          onChange={(e) => setCode(stripFence(e.target.value))}
          placeholder="输入 Markdown 源码"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-muted px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <div className="flex shrink-0 items-center border-t border-border/60 bg-muted px-2 py-1.5">
          <Button type="button" size="sm" className="w-full gap-1.5" onClick={() => setTick((v) => v + 1)}>
            <Play className="size-3.5" strokeWidth={2} />
            渲染
          </Button>
        </div>
      </div>
      <div className="w-1 shrink-0 cursor-col-resize" onPointerDown={startSplitDrag} />
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-background">
        <div className="absolute top-2 right-2 z-10 flex items-center rounded-md border bg-card/95 shadow-sm">
          <button
            type="button"
            className={copyBtn}
            title={diagramOnly ? '返回编辑' : '整个页面展示'}
            onClick={() => setDiagramOnly((v) => !v)}
          >
            {diagramOnly ? <Shrink className="size-3.5" strokeWidth={2} /> : <Expand className="size-3.5" strokeWidth={2} />}
          </button>
        </div>
        <div
          ref={previewRef}
          className="markdown-body px-4 py-3"
          onClick={(e) => {
            const link = (e.target as HTMLElement).closest('a')
            if (!link) return
            e.preventDefault()
            const href = link.getAttribute('href') ?? ''
            if (/^(https?:|mailto:)/i.test(href)) window.runtime.BrowserOpenURL(href)
          }}
        />
      </div>
    </div>
  )
}
