/**
 * 查找条贴在右上角时，Close 提示按整句展开后会伸出窗口，右边被切掉。
 * 只把超出的那一段往左挪，让整句露出来。返回解绑函数。
 */
export function bindFindCloseHover(container: HTMLElement): () => void {
  let scheduled = false
  const queue = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      shiftIntoView(container)
    })
  }
  const observer = new MutationObserver(queue)
  observer.observe(container, { childList: true, subtree: true })
  return () => observer.disconnect()
}

function shiftIntoView(container: HTMLElement): void {
  const view = container.querySelector('.context-view:has(.monaco-hover.workbench-hover.compact)')
  if (!(view instanceof HTMLElement)) return
  const rect = view.getBoundingClientRect()
  const limit = Math.min(container.getBoundingClientRect().right, window.innerWidth) - 4
  const overflow = rect.right - limit
  if (overflow <= 0) return
  const left = Number.parseFloat(view.style.left) || 0
  view.style.left = `${left - overflow}px`
}
