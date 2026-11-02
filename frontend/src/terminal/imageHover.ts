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

/** Ctrl+点击路径：用查看器/编辑器打开。打开要用到标签和会话，由 App 注册进来 */
let openHandler: ((termId: string, path: string) => void) | null = null
export function setImageOpenHandler(handler: ((termId: string, path: string) => void) | null): void {
  openHandler = handler
}
export function openImagePath(termId: string, path: string): void {
  openHandler?.(termId, path)
}
/** 普通文件路径和图片走同一个打开通道，RemoteEditor 按文件类型分派编辑器或查看器 */
export function openFilePath(termId: string, path: string): void {
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

// 常见文本文件扩展名，不含图片（图片走 IMAGE_PATH，带悬停预览）
const FILE_EXT =
  '(?:md|markdown|txt|json|ya?ml|toml|xml|csv|ts|tsx|js|jsx|mjs|cjs|go|py|sh|bash|zsh|fish|ps1|bat|cmd|rs|c|h|cc|cpp|cxx|hpp|java|kt|rb|php|pl|lua|sql|log|conf|cfg|ini|env|properties|gradle|mk|html?|css|scss|less|vue|svelte|swift|cs|vb|r|m|mm|tex|patch|diff)'
// 路径最后一段：隐藏文件通用识别，最后一段以 . 开头即可，不枚举具体文件名。
// SEG 不含路径分隔符，只匹配段名，避免把 .config/git/config 这种目录前缀误认成隐藏文件
const SEG = `[^\\s'"\`<>|;&()/\\\\]+`
// 段名后面只能是空白 / shell 分隔符或行尾，防止在 - 等字符处截断、或把目录前缀当文件
const HIDDEN_FILE = `(?:~?/(?:${BODY}/)?\\.${SEG}|[A-Za-z]:[\\\\/](?:${BODY}[\\\\/])?\\.${SEG})(?![^\\s'"\`<>|;&()])`
/**
 * 一行里的普通文件路径：/ 或 ~/ 开头的绝对路径、Windows 盘符路径。
 * 两类都认：以文本文件扩展名结尾的普通文件，以及最后一段以 . 开头的隐藏文件（.bashrc、.profile 等）。
 * Ctrl+点击进入编辑器，没有悬停预览。
 */
export const FILE_PATH = new RegExp(
  `(?<![\\w:/.~\\\\-])(${HIDDEN_FILE}|~?/${BODY}\\.${FILE_EXT}|[A-Za-z]:[\\\\/]${BODY}\\.${FILE_EXT})(?![\\w.])`,
  'gi'
)
