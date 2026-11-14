import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BrowserPageInfo } from '../../../shared/types'
import {
  buttonName,
  inputModifiers,
  normalizeUrl,
  paintBlob,
  pointerToViewport,
  screencastParams,
  stillParams,
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
  const wantedRef = useRef('')
  const editingRef = useRef(false)
  const composeRef = useRef(false)
  const clicks = useRef({ n: 0, t: 0, x: 0, y: 0 })
  const lastFrame = useRef<{ blob: Blob; meta: ScreencastMeta } | null>(null)
  const inputSeq = useRef(0)
  const inputBatch = useRef<{ seq: number; method: string; params: Record<string, unknown> }[]>([])
  const inputRaf = useRef(0)
  const wheelRef = useRef<{ x: number; y: number; dx: number; dy: number; modifiers: number } | null>(null)
  const fitGen = useRef(0)
  const stillGen = useRef(0)
  const stillTimer = useRef(0)
  const holdStill = useRef(false)
  const sharpening = useRef(false)
  const sharpFrame = useRef<{ blob: Blob; meta: ScreencastMeta } | null>(null)
  const scheduleFlushRef = useRef<() => void>(() => {})
  const scheduleStillRef = useRef<() => void>(() => {})
  const [pages, setPages] = useState<BrowserPageInfo[]>([])
  const [pageId, setPageId] = useState('')
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('正在连接')

  const command = (method: string, params?: Record<string, unknown>) => {
    const previewId = previewRef.current
    if (!previewId) return Promise.reject(new Error('浏览器连接断了'))
    return window.api.sessions.browserCommand(props.sessionId, previewId, method, params ?? {})
  }
  const commandRef = useRef(command)
  commandRef.current = command

  const flushInput = () => {
    inputRaf.current = 0
    const wheel = wheelRef.current
    wheelRef.current = null
    if (wheel) {
      inputBatch.current.push({
        seq: ++inputSeq.current,
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
    scheduleStillRef.current()
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
      batch.push({ seq: ++inputSeq.current, method, params })
    }
    scheduleFlush()
  }

  const fitPreview = () => {
    const stage = stageRef.current
    if (!previewRef.current || !stage) return Promise.resolve()
    const gen = ++fitGen.current
    return command('Emulation.setDeviceMetricsOverride', viewportParams(stage)).then(() => {
      if (gen !== fitGen.current) return
      return command('Page.startScreencast', screencastParams(stage))
    }).then(() => {
      if (gen === fitGen.current) scheduleStillRef.current()
    })
  }
  const fitPreviewRef = useRef(fitPreview)
  fitPreviewRef.current = fitPreview

  const takeStill = async (gen: number) => {
    const previewId = previewRef.current
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (gen !== stillGen.current || !previewId || !canvas || !stage) return
    if (!lastFrame.current) {
      stillTimer.current = window.setTimeout(() => {
        void takeStill(gen)
      }, 400)
      return
    }
    sharpening.current = true
    try {
      const result = await commandRef.current('Page.captureScreenshot', stillParams())
      if (gen !== stillGen.current || previewRef.current !== previewId) return
      const data = result && typeof result === 'object' && 'data' in result ? String((result as { data?: unknown }).data ?? '') : ''
      if (!data) return
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      const blob = new Blob([buffer], { type: 'image/png' })
      const fit = await paintBlob(canvas, stage, blob, {})
      if (gen !== stillGen.current || previewRef.current !== previewId) return
      const frame = { blob, meta: {} }
      sharpFrame.current = frame
      lastFrame.current = frame
      holdStill.current = true
      if (fit) fitRef.current = fit
    } catch {
      // 清晰图没拍到就继续用直播帧
    } finally {
      if (gen === stillGen.current) sharpening.current = false
    }
  }

  const scheduleStill = () => {
    holdStill.current = false
    sharpening.current = false
    const gen = ++stillGen.current
    window.clearTimeout(stillTimer.current)
    stillTimer.current = window.setTimeout(() => {
      void takeStill(gen)
    }, 450)
  }
  scheduleStillRef.current = scheduleStill

  const repaint = () => {
    const frame = lastFrame.current
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!frame || !canvas || !stage) return
    void paintBlob(canvas, stage, frame.blob, frame.meta).then((fit) => {
      if (fit) fitRef.current = fit
    })
  }

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
    const onWheel = (event: WheelEvent) => {
      const fit = fitRef.current
      const rect = stage.getBoundingClientRect()
      const point = fit ? pointerToViewport(event.clientX - rect.left, event.clientY - rect.top, fit) : null
      if (!point) return
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1
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
      if (editingRef.current) return
      setDraft(url)
    }

    const paintFrame = async (previewId: number, blob: Blob, meta: ScreencastMeta) => {
      if (holdStill.current || sharpening.current) return
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || !stage || blob.size === 0) return
      const fit = await paintBlob(canvas, stage, blob, meta)
      if (dead || previewRef.current !== previewId) return
      if (holdStill.current || sharpening.current) {
        const sharp = sharpFrame.current
        if (sharp) {
          const again = await paintBlob(canvas, stage, sharp.blob, sharp.meta)
          if (again) fitRef.current = again
        }
        return
      }
      lastFrame.current = { blob, meta }
      if (fit) fitRef.current = fit
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
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 12) return
          got = true
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
        scheduleStillRef.current()
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
          setPages(info.pages)
          setPageId(info.pageId)
          wantedRef.current = info.pageId
          showUrl(info.pages.find((item) => item.id === info.pageId)?.url ?? '')
          void fitPreviewRef.current().catch(() => {})
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
        if (old) await window.api.sessions.browserDisconnect(sessionId, old).catch(() => {})
        if (!dead) await sleep(800)
      }
    }

    void run()
    const poll = window.setInterval(() => {
      if (!current || dead) return
      const previewId = current
      void window.api.sessions
        .browserPages(sessionId)
        .then((found) => {
          if (dead || current !== previewId) return
          setPages(found)
          if (wantedRef.current && !found.some((item) => item.id === wantedRef.current)) {
            const next = found[found.length - 1]
            if (!next) return
            wantedRef.current = next.id
            setPageId(next.id)
            void window.api.sessions
              .browserSwitch(sessionId, previewId, next.id)
              .then(() => fitPreviewRef.current())
              .catch(() => {})
          }
        })
        .catch(() => {})
    }, 2000)

    return () => {
      dead = true
      resolveWait()
      pullAbort?.abort()
      window.clearTimeout(stillTimer.current)
      window.clearInterval(poll)
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
    return pointerToViewport(event.clientX - rect.left, event.clientY - rect.top, fit)
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
  }

  const go = () => {
    const url = normalizeUrl(draft)
    if (!url) return
    setDraft(url)
    editingRef.current = false
    void command('Page.navigate', { url })
      .then((result) => {
        const errorText = (result as { errorText?: string } | undefined)?.errorText
        if (errorText) setStatus(errorText)
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : '打不开这个地址'))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <Input
          value={draft}
          placeholder="地址"
          className="h-7"
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
        <Button size="sm" variant="outline" disabled={props.stopping} onClick={props.onStop}>
          {props.stopping ? '关闭中…' : '关闭浏览器'}
        </Button>
      </div>
      {pages.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1">
          {pages.map((page) => (
            <Button
              key={page.id}
              size="xs"
              variant={page.id === pageId ? 'default' : 'outline'}
              className="max-w-40 truncate"
              onClick={() => {
                if (page.id === wantedRef.current) return
                wantedRef.current = page.id
                setPageId(page.id)
                if (!editingRef.current) setDraft(page.url)
                const previewId = previewRef.current
                if (!previewId) return
                void window.api.sessions
                  .browserSwitch(props.sessionId, previewId, page.id)
                  .then(() => fitPreviewRef.current())
                  .catch((err: unknown) => {
                    setStatus(err instanceof Error ? err.message : '连不上浏览器')
                  })
              }}
            >
              {page.title || page.url}
            </Button>
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
          const point = pointOf(event)
          if (!point) return
          const now = Date.now()
          const prev = clicks.current
          const next = now - prev.t < 500 && Math.hypot(point.x - prev.x, point.y - prev.y) < 4 ? prev.n + 1 : 1
          prev.n = next
          prev.t = now
          prev.x = point.x
          prev.y = point.y
          sendMouse('mousePressed', event, next)
        }}
        onPointerMove={(event) => sendMouse('mouseMoved', event)}
        onPointerUp={(event) => sendMouse('mouseReleased', event, clicks.current.n || 1)}
        onPointerCancel={(event) => sendMouse('mouseReleased', event, 1)}
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
        {status && <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-sm text-muted-foreground">{status}</p>}
      </div>
    </div>
  )
}
