const MIN_SCALE = 0.2
const MAX_SCALE = 4

export function mountMermaidViewport(container: HTMLElement): void {
  const content = document.createElement('div')
  content.className = 'absolute inset-0 cursor-grab'
  while (container.firstChild) content.appendChild(container.firstChild)
  container.appendChild(content)

  const controls = document.createElement('div')
  controls.className = 'absolute top-2 right-2 z-10 flex items-center rounded-md border bg-card/95 shadow-sm'
  const percent = document.createElement('button')
  const zoomOut = document.createElement('button')
  const zoomIn = document.createElement('button')
  for (const button of [zoomOut, percent, zoomIn]) {
    button.type = 'button'
    button.className = 'h-7 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
    controls.appendChild(button)
  }
  zoomOut.textContent = '−'
  zoomOut.title = '缩小'
  zoomOut.setAttribute('aria-label', '缩小')
  zoomIn.textContent = '+'
  zoomIn.title = '放大'
  zoomIn.setAttribute('aria-label', '放大')
  percent.title = '重置视图'
  percent.setAttribute('aria-label', '重置视图')
  container.appendChild(controls)

  let scale = 1
  let x = 0
  let y = 0
  const svg = content.querySelector('svg')
  const box = svg?.viewBox.baseVal
  const baseWidth = box?.width ? Math.min(container.clientWidth || box.width, box.width) : 0
  const baseHeight = box?.width ? box.height * (baseWidth / box.width) : 0
  if (svg) svg.style.maxWidth = 'none'
  const apply = () => {
    content.style.transform = `translate(${x}px, ${y}px)`
    if (svg && baseWidth > 0) {
      svg.setAttribute('width', `${baseWidth * scale}`)
      svg.setAttribute('height', `${baseHeight * scale}`)
    }
    percent.textContent = `${Math.round(scale * 100)}%`
  }
  const zoomAt = (factor: number, px: number, py: number) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
    const ratio = next / scale
    x = px - (px - x) * ratio
    y = py - (py - y) * ratio
    scale = next
    apply()
  }
  const zoomCenter = (factor: number) => zoomAt(factor, container.clientWidth / 2, container.clientHeight / 2)
  const reset = () => {
    scale = 1
    x = 0
    y = 0
    apply()
  }
  zoomOut.addEventListener('click', () => zoomCenter(1 / 1.2))
  zoomIn.addEventListener('click', () => zoomCenter(1.2))
  percent.addEventListener('click', reset)
  controls.addEventListener('pointerdown', (event) => event.stopPropagation())

  let drag: { pointerId: number; startX: number; startY: number; x: number; y: number } | null = null
  content.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y }
    content.setPointerCapture(event.pointerId)
    content.classList.add('cursor-grabbing')
    content.classList.remove('cursor-grab')
  })
  content.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    x = drag.x + event.clientX - drag.startX
    y = drag.y + event.clientY - drag.startY
    apply()
  })
  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag = null
    content.classList.add('cursor-grab')
    content.classList.remove('cursor-grabbing')
  }
  content.addEventListener('pointerup', endDrag)
  content.addEventListener('pointercancel', endDrag)
  content.addEventListener('dblclick', reset)
  content.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = container.getBoundingClientRect()
    zoomAt(event.deltaY > 0 ? 1 / 1.12 : 1.12, event.clientX - rect.left, event.clientY - rect.top)
  }, { passive: false })
  apply()
}
