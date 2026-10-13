/**
 * 从系统拖文件进文件树上传。
 *
 * Wails 的 OnFileDrop 全局只能注册一次，而每个终端标签各有一棵文件树，所以这里统一注册，
 * 按落点分发：落点往上找 data-drop-dir（上传到哪个目录）和 data-drop-tree（哪棵树）。
 * 只有带 --wails-drop-target: drop 的区域才会触发，拖到终端等别处什么都不发生。
 */

import type { CSSProperties } from 'react'

type DropHandler = (dir: string, paths: string[]) => void

const trees = new Map<string, DropHandler>()

export const DROP_TARGET_STYLE = { '--wails-drop-target': 'drop' } as CSSProperties

export function registerDropTree(id: string, handler: DropHandler): () => void {
  trees.set(id, handler)
  return () => {
    if (trees.get(id) === handler) trees.delete(id)
  }
}

/** 拖动经过时落点对应的目录，给高亮用。不在任何文件树上返回 null。 */
export function dropDirAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-drop-dir]')?.dataset.dropDir ?? null
}

export function initFileDrop(): void {
  window.runtime?.OnFileDrop?.((x, y, paths) => {
    const el = document.elementFromPoint(x, y)
    const dir = dropDirAt(el)
    const tree = el?.closest<HTMLElement>('[data-drop-tree]')?.dataset.dropTree
    if (!dir || !tree || paths.length === 0) return
    trees.get(tree)?.(dir, paths)
  }, true)
}
