import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bookmark, Globe, History, Minus, Plus, Power, RotateCw, Settings, Star, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { BrowserBookmark, BrowserPageInfo, BrowserVisit } from '../../../shared/types'
import {
  buttonName,
  inputModifiers,
  normalizeUrl,
  paintBlob,
  pointerToViewport,
  screencastParams,
  viewportParams,
  type FrameFit,
  type ScreencastMeta
} from '@/browser/cdp'

type PointEvent = {
  clientX: number
  clientY: number
  button: number
  buttons: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** 容器已在跑：后端经 SSH 连上 CDP，画面和键鼠都走这一个页面。 */
export function BrowserLive(props: { sessionId: string; stopping: boolean; onStop: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fitRef = useRef<FrameFit | null>(null)
  const previewRef = useRef(0)
  const addressRef = useRef<HTMLInputElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const wantedRef = useRef('')
  const editingRef = useRef(false)
  const composeRef = useRef(false)
  const clicks = useRef({ n: 0, t: 0, x: 0, y: 0 })
  const scrollDrag = useRef<{ x: number; y: number; axis: 'x' | 'y'; scale: number; gen: number; pending: number } | null>(null)
  const scrollGen = useRef(0)
  const middleDrag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)
  const middleLoop = useRef(0)
  const stepMiddleRef = useRef<() => void>(() => {})
  const zoomRef = useRef(1)
  const zoomWheel = useRef(0)
  const onWheelRef = useRef<(event: WheelEvent) => void>(() => {})
  const applyZoomRef = useRef<(factor: number) => void>(() => {})
  const lastFrame = useRef<{ blob: Blob; meta: ScreencastMeta } | null>(null)
  const acceptFrames = useRef(true)
  const inputBatch = useRef<{ seq: number; method: string; params: Record<string, unknown> }[]>([])
  const inputRaf = useRef(0)
  const wheelRef = useRef<{ x: number; y: number; dx: number; dy: number; modifiers: number } | null>(null)
  const fitGen = useRef(0)
  const scheduleFlushRef = useRef<() => void>(() => {})
  const [pages, setPages] = useState<BrowserPageInfo[]>([])
  const pagesRef = useRef<BrowserPageInfo[]>([])
  const commitPages = (next: BrowserPageInfo[]) => {
    pagesRef.current = next
    setPages(next)
  }
  const commitPagesRef = useRef(commitPages)
  commitPagesRef.current = commitPages
  const openPageRef = useRef<(page: BrowserPageInfo) => void>(() => {})
  const lookForTabRef = useRef<() => void>(() => {})
  const tabWatch = useRef<number[]>([])
  const [pageId, setPageId] = useState('')
  const [draft, setDraft] = useState('')
  const [zoom, setZoom] = useState(1)
  const [zoomHud, setZoomHud] = useState(false)
  const [middleMark, setMiddleMark] = useState<{ x: number; y: number } | null>(null)
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const zoomHudTimer = useRef(0)
  const [status, setStatus] = useState('正在连接')
  const [adding, setAdding] = useState(false)
  const [location, setLocation] = useState('')
  const setLocationRef = useRef(setLocation)
  setLocationRef.current = setLocation
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([])
  const [marking, setMarking] = useState(false)
  const [visits, setVisits] = useState<BrowserVisit[] | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [clearing, setClearing] = useState(false)
  const [quality, setQuality] = useState(readQuality)
  const qualityRef = useRef(quality)
  qualityRef.current = quality
  const [barOn, setBarOn] = useState(() => {
    try {
      return localStorage.getItem(`termpilot-browser-bar:${props.sessionId}`) !== '0'
    } catch {
      return true
    }
  })
  const [nav, setNav] = useState<{ index: number; entries: { id: number }[] }>({ index: 0, entries: [] })
  const navGen = useRef(0)

  const command = (method: string, params?: Record<string, unknown>) => {
    const previewId = previewRef.current
    if (!previewId) return Promise.reject(new Error('浏览器连接断了'))
    return window.api.sessions.browserCommand(props.sessionId, previewId, method, params ?? {})
  }
  const commandRef = useRef(command)
  commandRef.current = command

  const readHistory = () => {
    const gen = ++navGen.current
    void command('Page.getNavigationHistory')
      .then((result) => {
        if (gen !== navGen.current) return
        const body = result as { currentIndex?: number; entries?: { id?: number }[] } | undefined
        const entries = (body?.entries ?? []).filter((item): item is { id: number } => typeof item?.id === 'number')
        const index = body?.currentIndex ?? 0
        setNav((prev) => {
          if (prev.index === index && prev.entries.length === entries.length && prev.entries.every((item, i) => item.id === entries[i]?.id)) return prev
          return { index, entries }
        })
      })
      .catch(() => {})
  }
  const readHistoryRef = useRef(readHistory)
  readHistoryRef.current = readHistory

  const flushInput = () => {
    inputRaf.current = 0
    const wheel = wheelRef.current
    wheelRef.current = null
    if (wheel) {
      inputBatch.current.push({
        seq: nextInputSeq(props.sessionId),
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel',
          x: wheel.x,
          y: wheel.y,
          deltaX: wheel.dx,
          deltaY: wheel.dy,
          modifiers: wheel.modifiers,
          pointerType: 'mouse'
        }
      })
    }
    const batch = inputBatch.current
    if (batch.length === 0) return
    inputBatch.current = []
    const previewId = previewRef.current
    if (!previewId) return
    void window.api.sessions.browserInput(props.sessionId, previewId, batch)
  }
  const scheduleFlush = () => {
    if (inputRaf.current) return
    inputRaf.current = window.requestAnimationFrame(flushInput)
  }
  scheduleFlushRef.current = scheduleFlush
  const queueInput = (method: string, params: Record<string, unknown>) => {
    const batch = inputBatch.current
    const last = batch[batch.length - 1]
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && last?.method === method && last.params.type === 'mouseMoved') {
      last.params = params
    } else {
      batch.push({ seq: nextInputSeq(props.sessionId), method, params })
    }
    scheduleFlush()
  }

  const clearPicture = () => {
    acceptFrames.current = false
    switchingRef.current = true
    setSwitching(true)
  }

  const resumePicture = () => {
    acceptFrames.current = true
    switchingRef.current = false
    setSwitching(false)
  }

  const fitPreview = () => {
    const stage = stageRef.current
    if (!previewRef.current || !stage) return Promise.resolve()
    const gen = ++fitGen.current
    return command('Emulation.setDeviceMetricsOverride', viewportParams(stage)).then(() => {
      if (gen !== fitGen.current) return
      return command('Page.startScreencast', screencastParams(stage, qualityRef.current))
    })
  }
  const fitPreviewRef = useRef(fitPreview)
  fitPreviewRef.current = fitPreview

  const repaint = () => {
    const frame = lastFrame.current
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!frame || !canvas || !stage) return
    void paintBlob(canvas, stage, frame.blob, frame.meta).then((fit) => {
      if (fit) fitRef.current = fit
    })
  }

  useEffect(
    () => () => {
      window.clearTimeout(zoomHudTimer.current)
      if (middleLoop.current) window.cancelAnimationFrame(middleLoop.current)
    },
    []
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let timer = 0
    const observer = new ResizeObserver(() => {
      repaint()
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void fitPreviewRef.current().catch(() => {})
      }, 200)
    })
    observer.observe(stage)
    const onWheel = (event: WheelEvent) => onWheelRef.current(event)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
      stage.removeEventListener('wheel', onWheel)
    }
  }, [])

  useEffect(() => {
    let dead = false
    let current = 0
    let pendingClose = 0
    let resolveWait = () => {}
    let pullAbort: AbortController | null = null
    const sessionId = props.sessionId

    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
    const showUrl = (url: string) => {
      setLocationRef.current(url)
      if (editingRef.current) return
      setDraft(displayUrl(url))
    }

    let lastFrameAt = Date.now()
    const markFrame = () => {
      lastFrameAt = Date.now()
    }
    const wake = () => {
      const run = (method: string, params: Record<string, unknown>) => {
        void commandRef.current(method, params).catch(() => {})
      }
      run('Emulation.setFocusEmulationEnabled', { enabled: true })
      run('Page.setWebLifecycleState', { state: 'active' })
      run('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true })
    }

    const paintFrame = async (previewId: number, blob: Blob, meta: ScreencastMeta) => {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!acceptFrames.current || !canvas || !stage || blob.size === 0) return
      const fit = await paintBlob(canvas, stage, blob, meta)
      if (!acceptFrames.current || dead || previewRef.current !== previewId) return
      lastFrame.current = { blob, meta }
      if (fit) fitRef.current = fit
      if (switchingRef.current) {
        switchingRef.current = false
        setSwitching(false)
      }
      setStatus((prev) => (prev === '' ? prev : ''))
    }

    const pullSocket = async (previewId: number, ctrl: AbortController) => {
      const info = await window.api.sessions.browserFrameSocket(previewId)
      if (dead || ctrl.signal.aborted || previewRef.current !== previewId) return true
      const socket = new WebSocket(info.url)
      socket.binaryType = 'arraybuffer'
      let pending: ArrayBuffer | null = null
      let painting = false
      let got = false
      const paintNext = async () => {
        if (painting) return
        painting = true
        try {
          while (pending && !dead && previewRef.current === previewId) {
            const buf = pending
            pending = null
            if (!acceptFrames.current) continue
            const view = new DataView(buf)
            await paintFrame(previewId, new Blob([buf.slice(12)], { type: 'image/jpeg' }), {
              deviceWidth: view.getUint32(0) || undefined,
              deviceHeight: view.getUint32(4) || undefined
            })
          }
        } catch {
          // 这一帧画失败就等下一帧
        } finally {
          painting = false
          if (pending && !dead && previewRef.current === previewId) void paintNext()
        }
      }
      return await new Promise<boolean>((resolve) => {
        const stop = () => socket.close()
        ctrl.signal.addEventListener('abort', stop, { once: true })
        socket.onmessage = (event) => {
          if (!acceptFrames.current) return
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 12) return
          got = true
          markFrame()
          pending = event.data
          void paintNext()
        }
        socket.onerror = () => socket.close()
        socket.onclose = () => {
          ctrl.signal.removeEventListener('abort', stop)
          resolve(got || ctrl.signal.aborted || dead || previewRef.current !== previewId)
        }
      })
    }

    const pullHttp = async (previewId: number, ctrl: AbortController) => {
      let after = 0
      while (!dead && previewRef.current === previewId && !ctrl.signal.aborted) {
        let res: Response
        try {
          res = await fetch(`/__browser/frame?preview=${previewId}&after=${after}`, { cache: 'no-store', signal: ctrl.signal })
        } catch {
          if (dead || ctrl.signal.aborted) return
          await sleep(300)
          continue
        }
        if (dead || previewRef.current !== previewId) return
        if (res.status === 204) continue
        if (!res.ok) {
          await sleep(300)
          continue
        }
        const seq = Number(res.headers.get('X-Frame-Seq') || after)
        const blob = await res.blob()
        markFrame()
        if (!acceptFrames.current) {
          if (seq > after) after = seq
          continue
        }
        try {
          await paintFrame(previewId, blob, {
            deviceWidth: Number(res.headers.get('X-Device-Width')) || undefined,
            deviceHeight: Number(res.headers.get('X-Device-Height')) || undefined
          })
        } catch {
          // 这一帧画失败就等下一帧
        }
        if (seq > after) after = seq
        else await sleep(50)
      }
    }

    const pullFrames = async (previewId: number) => {
      pullAbort?.abort()
      const ctrl = new AbortController()
      pullAbort = ctrl
      let socket = true
      while (!dead && previewRef.current === previewId && !ctrl.signal.aborted) {
        if (socket) {
          try {
            socket = await pullSocket(previewId, ctrl)
          } catch {
            socket = false
          }
          if (dead || ctrl.signal.aborted || previewRef.current !== previewId) return
          if (socket) {
            await sleep(300)
            continue
          }
        }
        await pullHttp(previewId, ctrl)
        return
      }
    }

    const off = window.api.sessions.onBrowserFrame(sessionId, (event) => {
      if (event.method === 'preview.closed') {
        pendingClose = event.previewId
        if (event.previewId === current) resolveWait()
        return
      }
      if (current !== 0 && event.previewId !== current) return
      if (event.method !== 'Page.frameNavigated') return
      const frame = event.params?.frame as { url?: string; parentId?: string } | undefined
      if (frame?.url && !frame.parentId) {
        showUrl(frame.url)
        readHistoryRef.current()
        if (zoomRef.current !== 1) applyZoomRef.current(zoomRef.current)
      }
    })

    const run = async () => {
      while (!dead) {
        pendingClose = 0
        try {
          const info = await window.api.sessions.browserConnect(sessionId)
          if (dead) {
            void window.api.sessions.browserDisconnect(sessionId, info.id)
            return
          }
          current = info.id
          previewRef.current = info.id
          commitPagesRef.current(applyTabOrder(sessionId, info.pages))
          setPageId(info.pageId)
          wantedRef.current = info.pageId
          showUrl(info.pages.find((item) => item.id === info.pageId)?.url ?? '')
          void fitPreviewRef.current().catch(() => {})
          readHistoryRef.current()
          wake()
          void pullFrames(info.id)
          if (pendingClose !== info.id) {
            await new Promise<void>((resolve) => {
              resolveWait = resolve
              if (pendingClose === info.id) resolve()
            })
          }
          if (dead) return
          setStatus('正在重连')
        } catch (err) {
          if (dead) return
          setStatus(err instanceof Error ? err.message : '连不上浏览器')
        }
        const old = current
        current = 0
        previewRef.current = 0
        navGen.current++
        setNav({ index: 0, entries: [] })
        if (old) await window.api.sessions.browserDisconnect(sessionId, old).catch(() => {})
        if (!dead) await sleep(800)
      }
    }

    void run()
    const beat = window.setInterval(() => {
      if (dead || !previewRef.current) return
      wake()
      if (Date.now() - lastFrameAt < 2500) return
      const stage = stageRef.current
      if (!stage) return
      lastFrameAt = Date.now()
      void commandRef.current('Page.bringToFront', {}).catch(() => {})
      void commandRef.current('Page.startScreencast', screencastParams(stage, qualityRef.current)).catch(() => {})
    }, 2000)

    const syncPages = (found: BrowserPageInfo[]) => {
      const prev = pagesRef.current
      const ordered = applyTabOrder(sessionId, found)
      commitPagesRef.current(ordered)
      const known = new Set(prev.map((item) => item.id))
      if (prev.length > 0) {
        const appeared = ordered.filter((page) => page.id && !known.has(page.id))
        const opened = appeared[appeared.length - 1]
        if (opened) {
          openPageRef.current(opened)
          const strip = stripRef.current
          if (strip) strip.scrollLeft = strip.scrollWidth
        }
      }
      return ordered
    }
    lookForTabRef.current = () => {
      if (dead || !current) return
      const previewId = current
      void window.api.sessions
        .browserPages(sessionId)
        .then((found) => {
          if (dead || current !== previewId) return
          syncPages(found)
        })
        .catch(() => {})
    }

    const poll = window.setInterval(() => {
      if (!current || dead) return
      const previewId = current
      void window.api.sessions
        .browserPages(sessionId)
        .then((found) => {
          if (dead || current !== previewId) return
          const ordered = syncPages(found)
          readHistoryRef.current()
          if (wantedRef.current && !found.some((item) => item.id === wantedRef.current)) {
            const next = ordered[ordered.length - 1]
            if (!next) return
            openPageRef.current(next)
          }
        })
        .catch(() => {})
    }, 2000)

    return () => {
      dead = true
      resolveWait()
      pullAbort?.abort()
      window.clearInterval(beat)
      window.clearInterval(poll)
      for (const id of tabWatch.current) window.clearTimeout(id)
      tabWatch.current = []
      off()
      const old = current
      current = 0
      previewRef.current = 0
      if (old) void window.api.sessions.browserDisconnect(sessionId, old)
    }
  }, [props.sessionId])

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const stage = stageRef.current
    const fit = fitRef.current
    if (!stage || !fit) return null
    const rect = stage.getBoundingClientRect()
    const point = pointerToViewport(event.clientX - rect.left, event.clientY - rect.top, fit)
    if (!point) return null
    const zoom = zoomRef.current || 1
    return { x: point.x / zoom, y: point.y / zoom, rawX: point.x, rawY: point.y }
  }

  const watchNewTab = () => {
    for (const id of tabWatch.current) window.clearTimeout(id)
    tabWatch.current = [400].map((wait) => window.setTimeout(() => lookForTabRef.current(), wait))
  }

  const sendMouse = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', event: PointEvent, clickCount = 1) => {
    const point = pointOf(event)
    if (!point) return
    queueInput('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : buttonName(event.button),
      buttons: event.buttons,
      clickCount,
      modifiers: inputModifiers(event),
      pointerType: 'mouse'
    })
    if (type === 'mousePressed') watchNewTab()
  }

  const scrollbarAxis = (point: { rawX: number; rawY: number }) => {
    const fit = fitRef.current
    if (!fit) return null
    const edge = 16
    const fromRight = fit.devW - point.rawX
    const fromBottom = fit.devH - point.rawY
    if (fromRight <= edge && fromBottom <= edge) return fromRight < fromBottom ? 'y' : 'x'
    if (fromRight <= edge) return 'y' as const
    if (fromBottom <= edge) return 'x' as const
    return null
  }

  const readScrollScale = (axis: 'x' | 'y', x: number, y: number) => {
    const vertical = axis === 'y'
    const expression = `(() => {
      const vertical = ${vertical}
      const root = document.scrollingElement || document.documentElement
      let node = document.elementFromPoint(${x}, ${y})
      const extra = (el) => vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
      const can = (el) => {
        if (!el || el.nodeType !== 1 || extra(el) <= 1) return false
        if (el === root || el === document.body || el === document.documentElement) return true
        const overflow = vertical ? getComputedStyle(el).overflowY : getComputedStyle(el).overflowX
        return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
      }
      while (node && !can(node)) node = node.parentElement
      if (!can(node)) node = root
      const track = vertical ? node.clientHeight : node.clientWidth
      const extent = vertical ? node.scrollHeight : node.scrollWidth
      if (!track || extent <= track) return 1
      const thumb = Math.max(track * track / extent, 16)
      const travel = Math.max(1, track - thumb)
      return (extent - track) / travel
    })()`
    return command('Runtime.evaluate', { expression, returnByValue: true })
      .then((result) => {
        const value = (result as { result?: { value?: unknown } } | undefined)?.result?.value
        return typeof value === 'number' && value >= 1 && value < 1000 ? value : 1
      })
      .catch(() => 1)
  }

  const emitScroll = (drag: { axis: 'x' | 'y' }, point: { x: number; y: number }, delta: number) => {
    if (!delta) return
    queueInput('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: drag.axis === 'y' ? Math.max(0, point.x - 24) : point.x,
      y: drag.axis === 'x' ? Math.max(0, point.y - 24) : point.y,
      deltaX: drag.axis === 'x' ? delta : 0,
      deltaY: drag.axis === 'y' ? delta : 0,
      modifiers: 0,
      pointerType: 'mouse'
    })
  }

  const emitWheel = (point: { x: number; y: number }, dx: number, dy: number) => {
    if (!dx && !dy) return
    queueInput('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: dx,
      deltaY: dy,
      modifiers: 0,
      pointerType: 'mouse'
    })
  }

  const stopMiddleScroll = () => {
    middleDrag.current = null
    setMiddleMark(null)
    if (middleLoop.current) {
      window.cancelAnimationFrame(middleLoop.current)
      middleLoop.current = 0
    }
  }

  stepMiddleRef.current = () => {
    middleLoop.current = 0
    const mid = middleDrag.current
    if (!mid) return
    const dead = 12
    const dx = mid.x - mid.ox
    const dy = mid.y - mid.oy
    const speed = (delta: number) => {
      const extra = Math.abs(delta) - dead
      if (extra <= 0) return 0
      return Math.sign(delta) * extra * 0.08
    }
    emitWheel({ x: mid.ox, y: mid.oy }, speed(dx), speed(dy))
    middleLoop.current = window.requestAnimationFrame(() => stepMiddleRef.current())
  }

  applyZoomRef.current = (factor) => {
    const changed = Math.abs(factor - zoomRef.current) >= 0.01
    zoomRef.current = factor
    setZoom(factor)
    if (changed) {
      setZoomHud(true)
      window.clearTimeout(zoomHudTimer.current)
      zoomHudTimer.current = window.setTimeout(() => setZoomHud(false), 5000)
    }
    const value = factor === 1 ? '' : String(factor)
    void command('Runtime.evaluate', {
      expression: `document.documentElement.style.zoom=${JSON.stringify(value)}`
    }).catch(() => {})
  }

  const stepZoom = (out: boolean) => {
    const next = Math.min(3, Math.max(0.5, zoomRef.current * (out ? 1 / 1.1 : 1.1)))
    if (Math.abs(next - zoomRef.current) < 0.01) return
    applyZoomRef.current(Math.abs(next - 1) < 0.015 ? 1 : next)
  }

  onWheelRef.current = (event) => {
    const point = pointOf(event)
    if (!point) return
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      zoomWheel.current += event.deltaY
      if (Math.abs(zoomWheel.current) < 80) return
      const out = zoomWheel.current > 0
      zoomWheel.current = 0
      stepZoom(out)
      return
    }
    const stage = stageRef.current
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage?.clientHeight || 1 : 1
    const prev = wheelRef.current
    wheelRef.current = {
      x: point.x,
      y: point.y,
      dx: (prev?.dx ?? 0) + event.deltaX * scale,
      dy: (prev?.dy ?? 0) + event.deltaY * scale,
      modifiers: inputModifiers(event)
    }
    scheduleFlushRef.current()
  }

  const openPage = (page: BrowserPageInfo) => {
    if (!page.id || page.id === wantedRef.current) return
    wantedRef.current = page.id
    setPageId(page.id)
    setLocation(page.url)
    if (!editingRef.current) setDraft(displayUrl(page.url))
    const previewId = previewRef.current
    if (!previewId) return
    clearPicture()
    void window.api.sessions
      .browserSwitch(props.sessionId, previewId, page.id)
      .then(() => {
        resumePicture()
        void fitPreviewRef.current()
        readHistoryRef.current()
      })
      .catch((err: unknown) => {
        resumePicture()
        setStatus(err instanceof Error ? err.message : '连不上浏览器')
      })
  }
  openPageRef.current = openPage

  const addTab = async () => {
    if (adding) return
    setAdding(true)
    try {
      const page = await window.api.sessions.browserNewPage(props.sessionId)
      const prev = pagesRef.current
      commitPages(applyTabOrder(props.sessionId, prev.some((item) => item.id === page.id) ? prev : [...prev, page]))
      openPage(page)
      const strip = stripRef.current
      if (strip) strip.scrollLeft = strip.scrollWidth
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '打不开新标签')
    } finally {
      setAdding(false)
    }
  }

  const closeTab = async (page: BrowserPageInfo) => {
    if (!page.id) return
    const previewId = previewRef.current
    const rest = pages.filter((item) => item.id !== page.id)
    const active = page.id === wantedRef.current
    try {
      if (active && previewId) {
        const next = rest[rest.length - 1] ?? (await window.api.sessions.browserNewPage(props.sessionId))
        commitPages(applyTabOrder(props.sessionId, rest.length > 0 ? rest : [next]))
        wantedRef.current = next.id
        setPageId(next.id)
        setLocation(next.url)
        if (!editingRef.current) setDraft(displayUrl(next.url))
        clearPicture()
        await window.api.sessions.browserSwitch(props.sessionId, previewId, next.id)
        resumePicture()
        void fitPreviewRef.current()
        readHistoryRef.current()
      } else {
        commitPages(applyTabOrder(props.sessionId, rest))
      }
      await window.api.sessions.browserClosePage(props.sessionId, page.id)
    } catch (err) {
      resumePicture()
      setStatus(err instanceof Error ? err.message : '这个标签已经关了')
    }
  }

  const goEntry = (id: number | undefined) => {
    if (id == undefined || props.stopping) return
    void command('Page.navigateToHistoryEntry', { entryId: id }).catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : '浏览器没有回应')
    })
  }

  const reloadPage = () => {
    if (props.stopping) return
    void command('Page.reload').catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : '浏览器没有回应')
    })
  }

  const openUrl = (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url || props.stopping) return
    editingRef.current = false
    setLocation(url)
    setDraft(url)
    void command('Page.navigate', { url })
      .then((result) => {
        const errorText = (result as { errorText?: string } | undefined)?.errorText
        if (errorText) setStatus(errorText)
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : '打不开这个地址'))
  }

  const go = () => openUrl(draft)

  useEffect(() => {
    let cancel = false
    void window.api.sessions
      .browserBookmarks(props.sessionId)
      .then((items) => {
        if (!cancel) setBookmarks(items ?? [])
      })
      .catch((err: unknown) => {
        if (!cancel) setStatus(err instanceof Error ? err.message : '收藏读不出来')
      })
    return () => {
      cancel = true
    }
  }, [props.sessionId])

  const toggleBar = () => {
    setBarOn((on) => {
      const next = !on
      try {
        localStorage.setItem(`termpilot-browser-bar:${props.sessionId}`, next ? '1' : '0')
      } catch {
        // 记不住就只在这一次生效
      }
      return next
    })
  }

  const loadVisits = () => {
    void window.api.sessions
      .browserHistory(props.sessionId)
      .then((items) => setVisits(items ?? []))
      .catch((err: unknown) => {
        setVisits([])
        setStatus(err instanceof Error ? err.message : '读不了历史记录')
      })
  }

  const clearVisits = () => {
    if (clearing || props.stopping) return
    setClearing(true)
    void window.api.sessions
      .browserHistoryClear(props.sessionId)
      .then(() => {
        setVisits([])
        setHistoryQuery('')
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : '删不了历史记录'))
      .finally(() => setClearing(false))
  }

  const chooseQuality = (value: string) => {
    const next = Number(value)
    if (!qualitySteps.includes(next)) return
    setQuality(next)
    qualityRef.current = next
    try {
      localStorage.setItem(qualityKey, String(next))
    } catch {
      // 记不住就只用这一次
    }
    const stage = stageRef.current
    if (!previewRef.current || !stage) return
    void command('Page.startScreencast', screencastParams(stage, next)).catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : '画质没有换上')
    })
  }

  const historyNeedle = historyQuery.trim().toLowerCase()
  const shownVisits = (visits ?? []).filter((visit) => {
    if (!historyNeedle) return true
    return decodeTitle(visit.title).toLowerCase().includes(historyNeedle) || visit.url.toLowerCase().includes(historyNeedle)
  })

  const starred = bookmarks.some((item) => item.url === location)
  const activePage = pages.find((page) => page.id === pageId)
  const toggleStar = () => {
    if (marking || props.stopping || !canBookmark(location)) return
    setMarking(true)
    const req = starred
      ? window.api.sessions.browserBookmarkRemove(props.sessionId, location)
      : window.api.sessions.browserBookmarkAdd(props.sessionId, location, tabLabel({ title: activePage?.title ?? '', url: location }))
    void req
      .then((items) => setBookmarks(items ?? []))
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : '收藏没有写上'))
      .finally(() => setMarking(false))
  }

  const removeBookmark = (url: string) => {
    if (marking || props.stopping) return
    setMarking(true)
    void window.api.sessions
      .browserBookmarkRemove(props.sessionId, url)
      .then((items) => setBookmarks(items ?? []))
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : '收藏没有写上'))
      .finally(() => setMarking(false))
  }

  const tabs = pages.length > 0 ? pages : [{ id: '', title: '', url: draft }]
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-end gap-1 bg-background px-1.5 pt-1">
        <div ref={stripRef} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((page) => {
            const active = tabs.length === 1 || page.id === pageId
            return (
              <div
                key={page.id || 'blank'}
                className={cn(
                  'group/tab relative flex h-8 w-44 max-w-52 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-[13px]',
                  active
                    ? 'z-10 bg-muted text-foreground before:pointer-events-none before:absolute before:-left-2 before:bottom-0 before:size-2 before:bg-[radial-gradient(circle_at_0_0,transparent_8px,var(--muted)_9px)] after:pointer-events-none after:absolute after:-right-2 after:bottom-0 after:size-2 after:bg-[radial-gradient(circle_at_100%_0,transparent_8px,var(--muted)_9px)]'
                    : 'text-muted-foreground hover:bg-muted/60'
                )}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || !page.id) return
                  event.preventDefault()
                  event.stopPropagation()
                  void closeTab(page)
                }}
                onClick={() => openPage(page)}
              >
                <TabIcon url={page.url} />
                <span className="min-w-0 flex-1 truncate text-left">{tabLabel(page)}</span>
                {page.id && (
                  <button
                    type="button"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10',
                      active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover/tab:opacity-70'
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      void closeTab(page)
                    }}
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                )}
              </div>
            )
          })}
          <Button size="icon-sm" variant="ghost" className="mb-0.5 shrink-0" disabled={props.stopping || adding} onClick={() => void addTab()}>
            <Plus />
          </Button>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn('mb-0.5 shrink-0', barOn ? 'text-foreground' : 'text-muted-foreground')}
          disabled={props.stopping}
          onClick={toggleBar}
        >
          <Bookmark className={cn(barOn && 'fill-current')} />
        </Button>
        <DropdownMenu onOpenChange={(open) => {
          if (open) loadVisits()
          else setHistoryQuery('')
        }}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="mb-0.5 shrink-0" disabled={props.stopping}>
              <History />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 overflow-hidden p-0">
            <div
              className="flex items-center gap-1 border-b border-border p-1.5"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Input
                value={historyQuery}
                placeholder="搜索"
                className="h-7 text-sm"
                onChange={(event) => setHistoryQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <Button size="icon-sm" variant="ghost" disabled={props.stopping || clearing} onClick={clearVisits}>
                <Trash2 />
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {visits == null ? null : shownVisits.length === 0 ? (
                <DropdownMenuItem disabled>没有记录</DropdownMenuItem>
              ) : (
                shownVisits.map((visit) => (
                  <DropdownMenuItem key={`${visit.visitedAt}:${visit.url}`} className="gap-2" onSelect={() => openUrl(visit.url)}>
                    <TabIcon url={visit.url} />
                    <span className="min-w-0 flex-1 truncate">{decodeTitle(visit.title) || visit.url}</span>
                    <span className="shrink-0 text-xs tabular-nums">{visitWhen(visit.visitedAt)}</span>
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="mb-0.5 shrink-0" disabled={props.stopping}>
              <Settings />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuLabel>画质</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(quality)} onValueChange={chooseQuality}>
              {qualitySteps.map((step) => (
                <DropdownMenuRadioItem key={step} value={String(step)}>{step}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon-sm" variant="ghost" className="mb-0.5 shrink-0" disabled={props.stopping} onClick={props.onStop}>
          <Power />
        </Button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-muted px-1.5">
        <Button size="icon-sm" variant="ghost" className="text-foreground hover:bg-background/80" disabled={props.stopping || nav.entries[nav.index - 1] == undefined} onClick={() => goEntry(nav.entries[nav.index - 1]?.id)}>
          <ArrowLeft />
        </Button>
        <Button size="icon-sm" variant="ghost" className="text-foreground hover:bg-background/80" disabled={props.stopping || nav.entries[nav.index + 1] == undefined} onClick={() => goEntry(nav.entries[nav.index + 1]?.id)}>
          <ArrowRight />
        </Button>
        <Button size="icon-sm" variant="ghost" className="text-foreground hover:bg-background/80" disabled={props.stopping || !previewRef.current} onClick={reloadPage}>
          <RotateCw />
        </Button>
        <div className="flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-full border border-transparent bg-background pr-1.5 focus-within:border-foreground">
          <Input
            ref={addressRef}
            value={draft}
            placeholder="地址"
            className="h-7 min-w-0 flex-1 border-transparent! bg-transparent! px-3 py-0 text-sm leading-7 text-foreground shadow-none focus-visible:border-transparent! focus-visible:bg-transparent! focus-visible:ring-0"
            onFocus={() => {
              editingRef.current = true
            }}
            onBlur={() => {
              editingRef.current = false
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              go()
            }}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-foreground"
            disabled={props.stopping || marking || !canBookmark(location)}
            onClick={toggleStar}
          >
            <Star className={cn(starred && 'fill-current')} />
          </Button>
        </div>
      </div>
      {barOn && (
        <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-muted px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {bookmarks.map((item) => (
            <ContextMenu key={item.url}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground hover:bg-background/80"
                  onClick={() => openUrl(item.url)}
                >
                  <TabIcon url={item.url} />
                  <span className="truncate">{decodeTitle(item.title) || item.url}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => removeBookmark(item.url)}>删除</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
      <div
        ref={stageRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(event) => {
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          if (middleDrag.current) {
            stopMiddleScroll()
            return
          }
          const point = pointOf(event)
          if (!point) return
          if (event.button === 1) {
            event.preventDefault()
            const stage = stageRef.current
            const rect = stage?.getBoundingClientRect()
            middleDrag.current = { x: point.x, y: point.y, ox: point.x, oy: point.y, moved: false }
            scrollDrag.current = null
            if (rect) setMiddleMark({ x: event.clientX - rect.left, y: event.clientY - rect.top })
            if (!middleLoop.current) middleLoop.current = window.requestAnimationFrame(() => stepMiddleRef.current())
            return
          }
          const axis = event.button === 0 ? scrollbarAxis(point) : null
          if (axis) {
            const gen = ++scrollGen.current
            scrollDrag.current = { x: point.x, y: point.y, axis, scale: 0, gen, pending: 0 }
            const probeX = axis === 'y' ? Math.max(0, point.x - 24) : point.x
            const probeY = axis === 'x' ? Math.max(0, point.y - 24) : point.y
            void readScrollScale(axis, probeX, probeY).then((scale) => {
              const drag = scrollDrag.current
              if (!drag || drag.gen !== gen) return
              drag.scale = scale
              const pending = drag.pending
              drag.pending = 0
              emitScroll(drag, drag, pending * scale)
            })
          } else {
            scrollDrag.current = null
          }
          const now = Date.now()
          const prev = clicks.current
          const next = now - prev.t < 500 && Math.hypot(point.x - prev.x, point.y - prev.y) < 4 ? prev.n + 1 : 1
          prev.n = next
          prev.t = now
          prev.x = point.x
          prev.y = point.y
          sendMouse('mousePressed', event, next)
        }}
        onPointerMove={(event) => {
          const point = pointOf(event)
          const mid = middleDrag.current
          if (mid && point) {
            mid.x = point.x
            mid.y = point.y
            if (Math.hypot(point.x - mid.ox, point.y - mid.oy) > 12) mid.moved = true
          }
          const drag = scrollDrag.current
          if (drag && point) {
            const step = drag.axis === 'y' ? point.y - drag.y : point.x - drag.x
            drag.x = point.x
            drag.y = point.y
            if (drag.scale > 0) emitScroll(drag, point, step * drag.scale)
            else drag.pending += step
          }
          sendMouse('mouseMoved', event)
        }}
        onPointerUp={(event) => {
          const mid = middleDrag.current
          if (event.button === 1 && mid) {
            const moved = mid.moved
            stopMiddleScroll()
            if (!moved) {
              sendMouse('mousePressed', event, 1)
              sendMouse('mouseReleased', event, 1)
            }
            return
          }
          scrollDrag.current = null
          sendMouse('mouseReleased', event, clicks.current.n || 1)
        }}
        onPointerCancel={(event) => {
          const mid = middleDrag.current
          stopMiddleScroll()
          scrollDrag.current = null
          if (mid) return
          sendMouse('mouseReleased', event, 1)
        }}
        onAuxClick={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.target !== stageRef.current) return
          event.preventDefault()
          event.stopPropagation()
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composeRef.current) return
          const text = event.key.length === 1 ? event.key : ''
          const type = text && !event.ctrlKey && !event.metaKey && !event.altKey ? 'keyDown' : 'rawKeyDown'
          queueInput('Input.dispatchKeyEvent', {
            type,
            modifiers: inputModifiers(event),
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
            nativeVirtualKeyCode: event.keyCode,
            text: type === 'keyDown' ? text : undefined,
            autoRepeat: event.repeat || undefined
          })
        }}
        onKeyUp={(event) => {
          if (event.target !== stageRef.current) return
          event.preventDefault()
          if (composeRef.current) {
            composeRef.current = false
            return
          }
          queueInput('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: inputModifiers(event),
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
            nativeVirtualKeyCode: event.keyCode
          })
        }}
        onCompositionEnd={(event) => {
          if (!event.data) return
          composeRef.current = true
          queueInput('Input.insertText', { text: event.data })
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text')
          if (!text) return
          event.preventDefault()
          queueInput('Input.insertText', { text })
        }}
      >
        <canvas ref={canvasRef} className="absolute left-0 top-0" />
        {middleMark && (
          <div className="pointer-events-none absolute z-10" style={{ left: middleMark.x, top: middleMark.y, transform: 'translate(-50%, -50%)' }}>
            <MiddleScrollMark />
          </div>
        )}
        {zoomHud && (
          <div
            className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/95 px-2 py-0.5 shadow-md"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onWheel={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <span className="px-1 text-sm tabular-nums text-foreground">{Math.round(zoom * 100)}%</span>
            <Button size="icon-sm" variant="ghost" className="text-foreground" disabled={zoom <= 0.5} onClick={() => stepZoom(true)}>
              <Minus />
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-foreground" disabled={zoom >= 3} onClick={() => stepZoom(false)}>
              <Plus />
            </Button>
            <Button size="sm" variant="secondary" className="ml-1 h-7 px-2.5" onClick={() => applyZoomRef.current(1)}>
              重置
            </Button>
          </div>
        )}
        {switching && <div className="pointer-events-none absolute inset-0 z-10 bg-background/55" />}
        {status && <p className="pointer-events-none absolute inset-x-0 bottom-2 z-10 text-center text-sm text-muted-foreground">{status}</p>}
      </div>
    </div>
  )
}

function MiddleScrollMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="rgb(28 28 28 / 0.88)" stroke="white" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2" fill="white" />
      <path fill="white" d="M16 4.5 12.8 8.6h6.4zM16 27.5 19.2 23.4h-6.4zM4.5 16 8.6 12.8v6.4zM27.5 16 23.4 19.2v-6.4z" />
    </svg>
  )
}

function siteIcon(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}/favicon.ico`
  } catch {
    return null
  }
}

function TabIcon(props: { url: string }) {
  const src = siteIcon(props.url)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  if (!src || failed) return <Globe className="size-3.5 shrink-0 opacity-60" strokeWidth={2} />
  return <img src={src} alt="" draggable={false} className="size-3.5 shrink-0 rounded-sm" onError={() => setFailed(true)} />
}

const qualitySteps = [60, 70, 80, 90, 100]
const qualityKey = 'termpilot-browser-quality'

function readQuality() {
  try {
    const saved = Number(localStorage.getItem(qualityKey))
    if (qualitySteps.includes(saved)) return saved
  } catch {
    // 读不到就用默认
  }
  return 90
}

function canBookmark(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function visitWhen(ms: number) {
  if (!ms) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return time
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function displayUrl(url: string) {
  if (!url || url === 'about:blank') return ''
  return url
}

/** 每个服务器的标签顺序。预览卸掉也不清，换终端回来还按打开先后排。 */
const tabOrder = new Map<string, string[]>()

function nextInputSeq(sessionId: string) {
  const key = `termpilot-browser-input:${sessionId}`
  let cur = 0
  try {
    cur = Number(sessionStorage.getItem(key) || '0')
  } catch {
    cur = 0
  }
  if (!Number.isFinite(cur) || cur < 0) cur = 0
  const seq = cur + 1
  try {
    sessionStorage.setItem(key, String(seq))
  } catch {
    // 存不下就只用这一次的序号
  }
  return seq
}

function applyTabOrder(sessionId: string, found: BrowserPageInfo[]) {
  const byId = new Map(found.filter((page) => page.id).map((page) => [page.id, page]))
  const kept: BrowserPageInfo[] = []
  for (const id of tabOrder.get(sessionId) ?? []) {
    const page = byId.get(id)
    if (!page) continue
    kept.push(page)
    byId.delete(id)
  }
  for (const page of found) {
    if (page.id && byId.has(page.id)) kept.push(page)
  }
  tabOrder.set(sessionId, kept.map((page) => page.id))
  return kept
}

function decodeTitle(text: string) {
  if (!text.includes('&')) return text
  const node = document.createElement('textarea')
  node.innerHTML = text
  return node.value
}

function tabLabel(page: { title: string; url: string }) {
  const title = decodeTitle(page.title.trim())
  if (!page.url || page.url === 'about:blank') return '新标签页'
  if (title && title !== 'about:blank') return title
  try {
    const host = new URL(page.url).hostname
    if (host) return host
  } catch {
    // 地址还不是完整链接时，直接显示原文
  }
  return page.url || '新标签页'
}
