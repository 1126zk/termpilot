import type { Tab } from '../../../shared/types'
import { useAppStore } from '../stores/useAppStore'
import { insertPaths } from './dropPath'

/**
 * 剪贴板图片上传到服务器 ~/.termpilot/paste（和后端 sftpx.PasteDir 一致）。
 * 「图片」栏的 Ctrl+V 和 SSH 终端里的 Alt+V 共用这一套。
 */
export const PASTE_DIR = '~/.termpilot/paste'

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** 这个进程里起过的文件名，同一秒连传几张时不会重名覆盖 */
const usedNames = new Set<string>()

/** 粘贴图片的文件名：20261101-103215.png，同一秒重名时加 -2、-3 */
function pasteFileName(ext: string, taken: Iterable<string>): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const busy = new Set([...usedNames, ...taken])
  let name = `${stamp}.${ext}`
  for (let i = 2; busy.has(name); i++) name = `${stamp}-${i}.${ext}`
  usedNames.add(name)
  return name
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

const savedListeners = new Set<(sessionId: string) => void>()

/** 有图片传上去了。「图片」栏用它刷新列表；返回退订函数 */
export function onPasteSaved(cb: (sessionId: string) => void): () => void {
  savedListeners.add(cb)
  return () => savedListeners.delete(cb)
}

/** 传一张图到服务器，返回服务器上的绝对路径。格式不认识时抛错 */
export async function uploadPasteImage(
  sessionId: string,
  blob: Blob,
  type: string,
  taken: Iterable<string> = []
): Promise<string> {
  const ext = EXT_BY_TYPE[type]
  if (!ext) throw new Error(`不支持的图片格式：${type}`)
  const path = await window.api.sftp.savePaste(sessionId, pasteFileName(ext, taken), await blobToBase64(blob))
  for (const cb of savedListeners) cb(sessionId)
  return path
}

/** 剪贴板里的第一张图片；没有图片时返回 null。读剪贴板失败照样抛出 */
async function clipboardImage(): Promise<{ blob: Blob; type: string } | null> {
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (type) return { blob: await item.getType(type), type }
  }
  return null
}

/**
 * SSH 终端里的 Alt+V。剪贴板是图片：传上去，把路径填到这个终端的光标处；
 * 不是图片（或读不到剪贴板）：把 Alt+V 原样发给服务器，Emacs、less 这些照常用。
 */
export async function pasteClipboardImage(tab: Tab): Promise<void> {
  const { setNotice } = useAppStore.getState()
  let image: { blob: Blob; type: string } | null = null
  try {
    image = await clipboardImage()
  } catch (error) {
    // 读不到剪贴板时说一声，不然按了 Alt+V 看起来像没反应
    setNotice(`读不到剪贴板：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!image || !tab.sessionId) {
    window.api.term.input(tab.id, '\x1bv')
    return
  }
  setNotice('正在上传图片…', true)
  try {
    const path = await uploadPasteImage(tab.sessionId, image.blob, image.type)
    // 上传期间标签可能被关了
    if (!useAppStore.getState().tabs.some((t) => t.id === tab.id)) return setNotice(null)
    insertPaths(tab, [path], false)
    setNotice(`已上传：${path}`)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error))
  }
}
