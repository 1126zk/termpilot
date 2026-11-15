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

function drawBitmap(canvas: HTMLCanvasElement, stage: HTMLElement, bitmap: ImageBitmap, _meta: ScreencastMeta): FrameFit | null {
  const paneW = stage.clientWidth
  const paneH = stage.clientHeight
  if (paneW <= 0 || paneH <= 0 || bitmap.width <= 0 || bitmap.height <= 0) return null
  const view = cssSize(stage)
  const fit = fitFrame(paneW, paneH, view.width, view.height)
  if (!fit) return null
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width
    canvas.height = bitmap.height
  }
  canvas.style.left = '0px'
  canvas.style.top = '0px'
  canvas.style.width = `${paneW}px`
  canvas.style.height = `${paneH}px`
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(bitmap, 0, 0)
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

function pixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2)
}

function cssSize(stage: HTMLElement | null) {
  return {
    width: Math.max(1, Math.round(stage?.clientWidth || 1280)),
    height: Math.max(1, Math.round(stage?.clientHeight || 720))
  }
}

function frameSize(stage: HTMLElement | null) {
  const { width, height } = cssSize(stage)
  const dpr = pixelRatio()
  return {
    width: Math.max(1, Math.round(width * dpr)),
    height: Math.max(1, Math.round(height * dpr))
  }
}

export function viewportParams(stage: HTMLElement | null): Record<string, unknown> {
  const { width, height } = cssSize(stage)
  return {
    width,
    height,
    deviceScaleFactor: pixelRatio(),
    mobile: false
  }
}

export function screencastParams(stage: HTMLElement | null): Record<string, unknown> {
  const { width, height } = frameSize(stage)
  return {
    format: 'jpeg',
    quality: 80,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1
  }
}
