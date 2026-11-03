/** 指针离起点这么近时不滚，免得手抖 */
const DEAD_ZONE = 8
/** 每离开起点 1px，速度加多少 px/秒 */
const SPEED = 12

/**
 * 鼠标中键自动滚动（Windows 浏览器的那种）：按下中键出现起点标记，
 * 指针往哪边偏就往哪边滚，偏得越远越快。按住拖动后松开即停；
 * 只单击则保持滚动，再按任意鼠标键、Esc 或窗口失焦时停止。
 * Monaco 是自绘滚动，浏览器自带的中键滚动对它无效，所以统一自己实现。
 * 返回解绑函数。
 */
export function bindMiddleScroll(el: HTMLElement, scrollBy: (dx: number, dy: number) => void): () => void {
  let active = false
  let moved = false
  let originX = 0
  let originY = 0
  let pointerX = 0
  let pointerY = 0
  let restX = 0
  let restY = 0
  let frame = 0
  let last = 0
  const marker = document.createElement('div')
  marker.className = 'middle-scroll-marker'

  const velocity = (offset: number) => {
    const distance = Math.abs(offset) - DEAD_ZONE
    return distance > 0 ? Math.sign(offset) * distance * SPEED : 0
  }

  const tick = (now: number) => {
    const dt = Math.min(50, now - last) / 1000
    last = now
    restX += velocity(pointerX - originX) * dt
    restY += velocity(pointerY - originY) * dt
    const dx = Math.trunc(restX)
    const dy = Math.trunc(restY)
    restX -= dx
    restY -= dy
    if (dx || dy) scrollBy(dx, dy)
    frame = requestAnimationFrame(tick)
  }

  const stop = () => {
    if (!active) return
    active = false
    cancelAnimationFrame(frame)
    marker.remove()
    document.documentElement.classList.remove('middle-scrolling')
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', onUp, true)
    window.removeEventListener('mousedown', onAnyDown, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', stop)
  }

  const onMove = (e: MouseEvent) => {
    pointerX = e.clientX
    pointerY = e.clientY
    if (Math.hypot(pointerX - originX, pointerY - originY) > DEAD_ZONE) moved = true
  }
  const onUp = (e: MouseEvent) => {
    if (e.button === 1 && moved) stop()
  }
  const onAnyDown = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    stop()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      stop()
    }
  }

  const onDown = (e: MouseEvent) => {
    if (e.button !== 1 || active) return
    // 挡住浏览器自带的中键滚动和 Monaco 自己的中键处理
    e.preventDefault()
    e.stopPropagation()
    active = true
    moved = false
    originX = pointerX = e.clientX
    originY = pointerY = e.clientY
    restX = restY = 0
    marker.style.left = `${originX}px`
    marker.style.top = `${originY}px`
    document.body.appendChild(marker)
    document.documentElement.classList.add('middle-scrolling')
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    // 本次按下的 window 捕获阶段已经过去，现在挂上不会接住它
    window.addEventListener('mousedown', onAnyDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', stop)
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }
  // 中键点到链接上会在新窗口打开
  const onAux = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  }

  el.addEventListener('mousedown', onDown, true)
  el.addEventListener('auxclick', onAux, true)
  return () => {
    stop()
    el.removeEventListener('mousedown', onDown, true)
    el.removeEventListener('auxclick', onAux, true)
  }
}
