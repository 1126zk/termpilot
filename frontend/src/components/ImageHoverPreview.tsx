import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { useImageHover } from '../terminal/imageHover'
import { imageMime } from './RemoteEditor'

/** 读过的图（来源 + 路径）只拉一次。最多留 40 张，再多就丢最早的 */
const cache = new Map<string, string>()
const CACHE_LIMIT = 40

const MAX_W = 320
const MAX_H = 240
/** 悬停多久才弹：鼠标只是划过路径时不打扰 */
const DELAY_MS = 300
/** 浮窗和路径、和窗口边缘之间留的空 */
const GAP = 8

/**
 * 终端里图片路径的悬停预览：贴着鼠标弹一张缩略图。
 * SSH 终端从服务器读，本机终端读本机文件。读不到就说一声，不弹错误框。
 */
export function ImageHoverPreview() {
  const hover = useImageHover((s) => s.hover)
  const [shown, setShown] = useState<typeof hover>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  /**
   * 量出浮窗实际大小再摆：横向中心对准路径文字的中心，放在这一行正上方，
   * 上面放不下就放到正下方；左右贴边时往里收，不出窗口。
   */
  const place = useCallback(() => {
    const el = boxRef.current
    if (!el || !shown) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(GAP, Math.min(shown.centerX - width / 2, window.innerWidth - width - GAP))
    const top = shown.top - GAP - height >= GAP ? shown.top - GAP - height : shown.bottom + GAP
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }, [shown])

  // 内容一变（加载中 → 图片 → 出错）大小就变，画到屏幕之前重新摆一次；图片解码完 onLoad 再摆一次
  useLayoutEffect(place, [place, src, error])

  // 停够 DELAY_MS 才显示；鼠标移开立刻收起
  useEffect(() => {
    if (!hover) return setShown(null)
    const timer = window.setTimeout(() => setShown(hover), DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hover])

  useEffect(() => {
    setSrc(null)
    setError(null)
    if (!shown) return
    const tab = useAppStore.getState().tabs.find((t) => t.id === shown.termId)
    if (!tab) return
    const remote = tab.kind === 'ssh' && tab.sessionId
    // 本机读文件不认 ~，只有服务器上能展开
    if (!remote && shown.path.startsWith('~')) return setError('本机路径请写完整')
    const key = `${remote ? tab.sessionId : 'local'}:${shown.path}`
    const cached = cache.get(key)
    if (cached) return setSrc(cached)
    let alive = true
    const read = remote ? window.api.sftp.readImage(tab.sessionId!, shown.path) : window.api.localfs.readImage(shown.path)
    read
      .then((base64) => {
        const url = `data:${imageMime(shown.path)};base64,${base64}`
        cache.set(key, url)
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        if (alive) setSrc(url)
      })
      .catch(() => alive && setError('读不出图片'))
    return () => {
      alive = false
    }
  }, [shown])

  if (!shown) return null
  return (
    <div
      ref={boxRef}
      className="pointer-events-none fixed top-0 left-0 z-50 rounded-lg border bg-popover p-1.5 shadow-lg"
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="block rounded object-contain"
          style={{ maxWidth: MAX_W, maxHeight: MAX_H }}
          onLoad={place}
        />
      ) : (
        <div className="px-2 py-1 text-xs text-muted-foreground">{error ?? '加载中…'}</div>
      )}
    </div>
  )
}
