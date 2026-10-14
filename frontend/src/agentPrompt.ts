import type { LocalShell, SessionConfig, Tab } from '../../shared/types'

/** 本机终端壳的标签名。缺省按 PowerShell。 */
export function shellLabel(shell?: LocalShell): string {
  if (shell === 'cmd') return 'CMD'
  if (shell === 'gitbash') return 'Git Bash'
  if (shell === 'wsl') return 'WSL'
  if (shell === 'pwsh') return 'PowerShell 7'
  return 'PowerShell'
}

/** 新建终端的标题：标签名加序号，例如「PowerShell (1)」「web (2)」。 */
export function termTitle(index: number, label?: string | null): string {
  const name = label?.trim() || '终端'
  return `${name} (${index})`
}

/** 右键一扇终端。只写这扇终端的编号、标签名和它所属连接。 */
export function termAgentPrompt(tab: Tab, session: SessionConfig | null): string {
  const lines = [`终端：${tab.id}`, `标题：${tab.title}`]
  if (tab.remark?.trim()) lines.push(`备注：${tab.remark.trim()}`)
  if (session) {
    lines.push(`所属连接：${session.publicId}`, `连接名称：${session.name}`)
    if (session.remark?.trim()) lines.push(`连接备注：${session.remark.trim()}`)
  }
  return lines.join('\n')
}

/**
 * 发给 Agent 的接入说明。它自己读端点文件、自己写配置、自己生成使用说明，
 * 我们不再维护各家的接入适配。
 */
export function agentOnboardPrompt(): string {
  return `请接入本机的 TermPilot（SSH 终端，Agent 可接管已打开的终端）：

1. 读取端点文件 mcp.json（Windows 是 %APPDATA%\\TermPilot\\mcp.json，macOS 是 ~/Library/Application Support/TermPilot/mcp.json，Linux 是 ~/.config/TermPilot/mcp.json）。里面有 MCP 端点（http://127.0.0.1:<port>/mcp）和 Bearer 令牌。文件不存在或没有 enabled: true 时，请用户先打开 TermPilot 并在设置里启用 MCP。
2. 把名为 termpilot 的 MCP 服务器注册到你自己的用户级配置：Streamable HTTP，Authorization 用 Bearer 加文件里的令牌。只加 termpilot 这一条，其他服务器不要动；不要写进连接器目录，重启会被盖掉。写完重新打开你自己的程序生效。
3. 用不了 MCP 就走本机命令 termpilot：tools 列出工具，schema 看参数，call 用 JSON 调用。它和 MCP 是同一份工具定义；窗口没开时它会先拉起应用。
4. 具体用法先读这份说明：%APPDATA%\\TermPilot\\SKILL.md（macOS 是 ~/Library/Application Support/TermPilot/SKILL.md，Linux 是 ~/.config/TermPilot/SKILL.md）。它在 TermPilot 启动时写出，随应用版本更新。

约定：
- 调用只认编号：conn- 是连接，term- 是终端。名称和备注只用来认出它。
- 先 connection_list 或 term_list；用户给了编号就直接用，不要新开终端。
- 优先读文本（term_lines / term_read），需要看画面再截图。
- 删除文件、写系统路径等危险操作会在 TermPilot 窗口里等用户确认，你只需照常发起。
- 密码和验证码由用户在窗口里输入，不要索取。`
}

/** 复制文本并给一句提示。label 是复制的内容类型，默认「Agent 提示词」。 */
export async function copyAgentPrompt(text: string, setNotice: (notice: string | null) => void, label = 'Agent 提示词'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    setNotice(`已复制${label}`)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error))
  }
}
