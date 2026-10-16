/**
 * 从系统拖进本机文件树是移动，拖进服务器文件树是上传。落在终端上就把路径写进终端。
 *
 * Wails 的 OnFileDrop 全局只能注册一次，而每个终端标签各有一棵文件树，所以这里统一注册，
 * 按落点分发：落点往上找 data-drop-term（哪个终端），或 data-drop-dir（上传到哪个目录）
 * 和 data-drop-tree（哪棵树）。只有带 --wails-drop-target: drop 的区域才会触发。
 */

import type { CSSProperties } from 'react'
import { useAppStore } from './stores/useAppStore'
import { insertPaths } from './terminal/dropPath'
import { treeMoveActive } from './treeMove'

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

function onLocalTree(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-drop-local]')
}

export function initFileDrop(): void {
  window.runtime?.OnFileDrop?.((x, y, paths) => {
    const el = document.elementFromPoint(x, y)
    const termId = el?.closest<HTMLElement>('[data-drop-term]')?.dataset.dropTerm
    if (termId) {
      const state = useAppStore.getState()
      const tab = state.tabs.find((t) => t.id === termId)
      if (!tab || paths.length === 0) return
      if (tab.kind === 'ssh') {
        state.setNotice('服务器上用不了本机路径。要传到服务器，请拖到右侧文件树')
        return
      }
      insertPaths(tab, paths, true)
      return
    }
    const dir = dropDirAt(el)
    const tree = el?.closest<HTMLElement>('[data-drop-tree]')?.dataset.dropTree
    if (!dir || !tree || paths.length === 0) return
    trees.get(tree)?.(dir, paths)
  }, true)

  // 经过本机文件树时鼠标显示移动。从系统拖进来时，松手仍对资源管理器报复制：
  // 路径要等这次拖放结束才送到程序，若报移动，资源管理器会先删掉原文件。
  // 真正的移动由 MoveInto 完成，失败时桌面上的文件还在。
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return
    if (!treeMoveActive() && !onLocalTree(event.target)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  })
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer || treeMoveActive() || !onLocalTree(event.target)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
}
