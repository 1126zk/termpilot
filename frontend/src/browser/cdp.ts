/** 把 CDP 画面画到预览区，并把指针换算回浏览器视口。 */

export interface ScreencastMeta {
  deviceWidth?: number
  deviceHeight?: number
}

export interface FrameFit {
  x: number
  y: number
  w: number
  h: number
  devW: number
  devH: number
}

export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text
  if (/^(localhost|127\.|0\.0\.0\.0|\[)/.test(text) || /^[^/]+:\d+(\/|$)/.test(text)) return `http://${text}`
  return `https://${text}`
}

export function fitFrame(paneW: number, paneH: number, devW: number, devH: number): FrameFit | null {
  if (paneW <= 0 || paneH <= 0 || devW <= 0 || devH <= 0) return null
  const scale = Math.min(paneW / devW, paneH / devH)
  const w = devW * scale
  const h = devH * scale
  return { x: (paneW - w) / 2, y: (paneH - h) / 2, w, h, devW, devH }
}

export function pointerToViewport(localX: number, localY: number, fit: FrameFit): { x: number; y: number } | null {
  if (localX < fit.x || localY < fit.y || localX > fit.x + fit.w || localY > fit.y + fit.h) return null
  return {
    x: ((localX - fit.x) / fit.w) * fit.devW,
    y: ((localY - fit.y) / fit.h) * fit.devH
  }
}

export function inputModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

export function buttonName(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  if (button === 0) return 'left'
  return 'none'
}

export function decodeB64(data: string): Uint8Array {
  const fast = (Uint8Array as unknown as { fromBase64?: (value: string) => Uint8Array }).fromBase64
  if (fast) return fast(data)
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function drawBitmap(canvas: HTMLCanvasElement, stage: HTMLElement, bitmap: ImageBitmap, meta: ScreencastMeta): FrameFit | null {
  const paneW = stage.clientWidth
  const paneH = stage.clientHeight
  const dpr = pixelRatio()
  if (paneW <= 0 || paneH <= 0) return null
  const destW = Math.max(1, Math.round(paneW * dpr))
  const destH = Math.max(1, Math.round(paneH * dpr))
  if (canvas.width !== destW || canvas.height !== destH) {
    canvas.width = destW
    canvas.height = destH
  }
  canvas.style.width = `${paneW}px`
  canvas.style.height = `${paneH}px`
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  const viewW = meta.deviceWidth || bitmap.width
  const viewH = meta.deviceHeight || bitmap.height
  const fit = fitFrame(paneW, paneH, viewW, viewH)
  if (!fit) return null
  let dx = Math.round(fit.x * dpr)
  let dy = Math.round(fit.y * dpr)
  let dw = Math.round(fit.w * dpr)
  let dh = Math.round(fit.h * dpr)
  const crisp = Math.abs(dw - bitmap.width) <= 2 && Math.abs(dh - bitmap.height) <= 2
  if (crisp) {
    dw = bitmap.width
    dh = bitmap.height
    dx = Math.max(0, Math.round((destW - dw) / 2))
    dy = Math.max(0, Math.round((destH - dh) / 2))
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = !crisp
  if (!crisp) ctx.imageSmoothingQuality = 'high'
  if (dx > 0 || dy > 0 || dw < destW || dh < destH) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, destW, destH)
  }
  ctx.drawImage(bitmap, dx, dy, dw, dh)
  return fit
}

export async function paintFrame(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  bytes: Uint8Array,
  meta: ScreencastMeta
): Promise<FrameFit | null> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const bitmap = await createImageBitmap(new Blob([buffer], { type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }))
  try {
    return drawBitmap(canvas, stage, bitmap, meta)
  } finally {
    bitmap.close()
  }
}

export async function paintBlob(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  blob: Blob,
  meta: ScreencastMeta
): Promise<FrameFit | null> {
  const bitmap = await createImageBitmap(blob)
  try {
    return drawBitmap(canvas, stage, bitmap, meta)
  } finally {
    bitmap.close()
  }
}

const maxEdge = 2560

function pixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2)
}

function captureSize(stage: HTMLElement | null) {
  const width = Math.max(1, Math.round(stage?.clientWidth || 1280))
  const height = Math.max(1, Math.round(stage?.clientHeight || 720))
  const dpr = pixelRatio()
  let viewW = Math.max(1, Math.round(width * dpr))
  let viewH = Math.max(1, Math.round(height * dpr))
  const long = Math.max(viewW, viewH)
  if (long > maxEdge) {
    const scale = maxEdge / long
    viewW = Math.max(1, Math.round(viewW * scale))
    viewH = Math.max(1, Math.round(viewH * scale))
  }
  return { width: viewW, height: viewH }
}

export function viewportParams(stage: HTMLElement | null): Record<string, unknown> {
  const { width, height } = captureSize(stage)
  return {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  }
}

export function screencastParams(stage: HTMLElement | null): Record<string, unknown> {
  const { width, height } = captureSize(stage)
  return {
    format: 'jpeg',
    quality: 85,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1
  }
}

export function stillParams(): Record<string, unknown> {
  return { format: 'png', fromSurface: true, captureBeyondViewport: false }
}
