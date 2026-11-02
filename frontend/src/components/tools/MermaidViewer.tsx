import { useEffect, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Expand, Play, Shrink } from 'lucide-react'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { mountMermaidViewport } from '../mermaidViewport'
import { startPointerDrag } from '../flip'
import type { ToolProps } from '../ToolsPage'

const STORAGE_KEY = 'termpilot.tool.mermaidViewer'
const SPLIT_KEY = 'termpilot.tool.mermaidSplit'
const DEFAULT_CODE = `flowchart LR
  A[开始] --> B{判断}
  B -->|是| C[执行]
  B -->|否| D[结束]`

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

let seq = 0

function readCode(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CODE
}

function readRatio(): number {
  const value = Number(localStorage.getItem(SPLIT_KEY))
  return value >= 0.15 && value <= 0.85 ? value : 1 / 3
}

const icons = {
  expand: renderToStaticMarkup(<Expand className="size-4" strokeWidth={2} />),
  shrink: renderToStaticMarkup(<Shrink className="size-4" strokeWidth={2} />)
}

/** Mermaid 查看器：输入代码实时渲染，支持拖动平移和缩放，内容记在本地。 */
export function MermaidViewer(props: ToolProps) {
  const [code, setCode] = useState(readCode)
  const [error, setError] = useState('')
  const [diagramOnly, setDiagramOnly] = useState(false)
  const [ratio, setRatio] = useState(readRatio)
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  const splitRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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
        // 右栏宽度变了，重新渲染让图按新视口居中
        renderRef.current()
      }
    })
  }

  // 只看图时其他工具也一起收起，整个主界面只剩渲染结果；尺寸变了重新渲染以适配宽度
  const diagramEffectFirst = useRef(true)
  useEffect(() => {
    if (diagramEffectFirst.current) {
      diagramEffectFirst.current = false
      return
    }
    if (diagramOnly && !props.solo) props.onSolo?.()
    props.onFullDiagram?.(diagramOnly)
    renderRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramOnly])

  const codeRef = useRef(code)
  codeRef.current = code
  const renderRef = useRef<() => void>(() => {})

  const renderDiagram = () => {
    const container = containerRef.current
    if (!container) return
    const source = codeRef.current
    if (!source.trim()) {
      container.innerHTML = ''
      setError('')
      return
    }
    void mermaid
      .render(`mermaid-tool-${++seq}`, source)
      .then(({ svg }) => {
        if (!container.isConnected) return
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
        if (container.isConnected) setError('Mermaid 渲染失败，请检查语法')
      })
  }
  renderRef.current = renderDiagram

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, code)
    const timer = window.setTimeout(() => renderRef.current(), 400)
    return () => window.clearTimeout(timer)
  }, [code])

  // 渲染容器里的全屏按钮是原生 DOM，状态变化时同步图标和提示（code 变化会重建按钮，也要跟上）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const diagramBtn = container.querySelector<HTMLButtonElement>('[data-viewport-action="diagram"]')
    if (diagramBtn) {
      diagramBtn.title = diagramOnly ? '返回编辑' : '整个页面展示'
      diagramBtn.innerHTML = diagramOnly ? icons.shrink : icons.expand
    }
  }, [diagramOnly, code])

  return (
    <div ref={splitRef} className={cn('flex flex-row', diagramOnly ? 'min-h-0 flex-1' : 'h-96')}>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-r-md" style={{ width: `${ratio * 100}%` }}>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="输入 Mermaid 代码"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-muted px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        {error && <p className={cn('text-sm text-destructive', diagramOnly && 'px-3 py-2')}>{error}</p>}
        <div className="flex shrink-0 items-center border-t border-border/60 bg-muted px-2 py-1.5">
          <Button type="button" size="sm" className="w-full gap-1.5" onClick={() => renderRef.current()}>
            <Play className="size-3.5" strokeWidth={2} />
            渲染
          </Button>
        </div>
      </div>
      <div className="w-1 shrink-0 cursor-col-resize" onPointerDown={startSplitDrag} />
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background select-none" />
    </div>
  )
}
