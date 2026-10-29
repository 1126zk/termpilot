import type { Tab } from '../../../shared/types'
import { terminalPool } from './TerminalPool'

/** 文件树拖出来的路径。只在页面里流转，不带 text/plain，免得 xterm 的输入框自己再插一遍。 */
export const TREE_PATH_MIME = 'application/x-termpilot-path'

type Style = 'posix' | 'powershell' | 'cmd'

function posixQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`
}

function powershellQuote(path: string): string {
  return /^[\w.:\\/-]+$/.test(path) ? path : `'${path.replaceAll("'", "''")}'`
}

function cmdQuote(path: string): string {
  return /[\s&()[\]{}^=;!'+,`~%]/.test(path) ? `"${path}"` : path
}

/** C:\a\b 或 C:/a/b → 盘符和其余部分。不是 Windows 路径返回 null。 */
function splitDrive(path: string): { drive: string; rest: string } | null {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(path)
  return m ? { drive: m[1]!.toLowerCase(), rest: m[2]!.replaceAll('\\', '/') } : null
}

function splitWsl(path: string): string | null {
  const m = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+\/(.+)$/i.exec(path.replaceAll('\\', '/'))
  return m ? `/${m[1]}` : null
}

/** 按终端里跑的 shell 改写路径并加引号。 */
function format(path: string, tab: Tab, localPath: boolean): string {
  if (tab.kind === 'ssh' || window.api.platform !== 'win32') return posixQuote(path)
  let style: Style = 'powershell'
  let text = path
  if (tab.shell === 'wsl' || tab.shell === 'gitbash') {
    style = 'posix'
    const wsl = tab.shell === 'wsl' && localPath ? splitWsl(path) : null
    const parts = localPath && !wsl ? splitDrive(path) : null
    if (wsl) text = wsl
    else if (parts) text = `${tab.shell === 'wsl' ? '/mnt/' : '/'}${parts.drive}/${parts.rest}`
  } else {
    if (tab.shell === 'cmd') style = 'cmd'
    if (localPath) text = path.replaceAll('/', '\\')
  }
  return style === 'posix' ? posixQuote(text) : style === 'cmd' ? cmdQuote(text) : powershellQuote(text)
}

/**
 * 把路径插到终端光标处，多个用空格隔开，末尾留一个空格接着打字。
 * localPath 表示是本机路径（系统拖进来的、本机文件树里的），WSL / Git Bash 里会转成 /mnt/c、/c 这种。
 */
export function insertPaths(tab: Tab, paths: string[], localPath: boolean): void {
  if (paths.length === 0) return
  terminalPool.paste(tab.id, paths.map((p) => format(p, tab, localPath)).join(' ') + ' ')
}
