import { create } from 'zustand'

/**
 * 终端里图片路径的悬停预览。links.ts 识别到路径后写这里，App 里的 ImageHoverPreview 读出来显示。
 * 单独一个小 store：links.ts 被终端池引用，不能反过来引用 useAppStore（会成环）。
 */
export interface ImageHover {
  termId: string
  path: string
  /** 路径文字在屏幕上的位置（视口坐标）：横向中点和这一行的上下沿，浮窗居中对齐它 */
  centerX: number
  top: number
  bottom: number
}

export const useImageHover = create<{ hover: ImageHover | null }>(() => ({ hover: null }))

export function showImageHover(hover: ImageHover): void {
  useImageHover.setState({ hover })
}

/** 只收起这一个路径的预览：鼠标从一条路径直接移到另一条时，后一条的 show 可能先到 */
export function hideImageHover(termId: string, path: string): void {
  const current = useImageHover.getState().hover
  if (current && current.termId === termId && current.path === path) useImageHover.setState({ hover: null })
}

/** Ctrl+点击图片路径：用图片查看器打开。打开要用到标签和会话，由 App 注册进来 */
let openHandler: ((termId: string, path: string) => void) | null = null
export function setImageOpenHandler(handler: ((termId: string, path: string) => void) | null): void {
  openHandler = handler
}
export function openImagePath(termId: string, path: string): void {
  openHandler?.(termId, path)
}

const EXT = '(?:png|jpe?g|gif|webp|bmp)'
// 路径里不认的字符：空白、引号、shell 符号。第一版不管带空格的路径
const BODY = `[^\\s'"\`<>|;&()]*?`
/**
 * 一行里的图片路径：/ 或 ~/ 开头的绝对路径，以及 C:\ 这种 Windows 盘符路径，以图片扩展名结尾。
 * 前面紧挨着字母数字、冒号、斜杠的不算，免得把网址里的 /a.png 那段也认出来。
 */
export const IMAGE_PATH = new RegExp(
  `(?<![\\w:/.~\\\\-])(~?/${BODY}\\.${EXT}|[A-Za-z]:[\\\\/]${BODY}\\.${EXT})(?![\\w.])`,
  'gi'
)
