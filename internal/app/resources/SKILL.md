---
name: termpilot
description: >-
  通过 TermPilot 操作本机 SSH 终端：连接服务器（含多跳板）、执行命令、读写远程文件、截图。
  用户要求接入 TermPilot、接管终端窗口或做人机协同时使用。
---

# TermPilot

TermPilot 是本机 SSH 终端。用户和 Agent 共用同一套连接和终端：用户在窗口里登录，Agent 接着在同一条不断开的会话上操作。密码只保存在 TermPilot 里，不要向用户索取，也不要写入回复或日志。

## 接入

1. 读端点文件 mcp.json（Windows 是 `%APPDATA%\TermPilot\mcp.json`，macOS 是 `~/Library/Application Support/TermPilot/mcp.json`，Linux 是 `~/.config/TermPilot/mcp.json`）。文件不存在或没有 `enabled: true` 时，请用户先打开 TermPilot 并在设置里启用 MCP。
2. 把名为 `termpilot` 的 MCP 服务器注册到你自己的用户级配置：Streamable HTTP，`Authorization` 是 `Bearer ` 加文件里的令牌。只加这一条，别动其他服务器。写完重新打开你自己的程序生效。不要在回复、日志或仓库里打印令牌。
3. MCP 不可用就走本机命令 `termpilot`：`tools` 列工具，`schema` 看参数，`call` 用 JSON 调用（`--json-file` 传文件、`--json-stdin` 传标准输入、`--json` 一行输出）。和 MCP 同一份定义；窗口没开时它会先拉起应用。

## 约定

- 调用只认编号：`conn-` 是连接，`term-` 是终端。名称和备注只用来认出它，不能当参数。
- 用户给了编号就直接用。没给就先 `connection_list` 或 `term_list`，按名称找到它。
- 危险操作（删除文件、写系统路径等）会在 TermPilot 窗口里等用户确认，照常发起即可，收到"已取消"就停下来问用户。
- 删除终端用 `term_close`，删除连接用 `connection_delete`。不删除服务器上的已有文件。

## 怎么用

- **跑命令默认用 `term_exec`**：独立 exec 通道，不占终端画面，可并发，不需要先开终端。返回 JSON：stdout/stderr 分流（原始字节流，不折行、无回显）、exitCode、duration、timedOut、truncated。输出要进脚本逻辑时只能用它。命令原样交给远端 bash，多行、heredoc、引号直接写，不要自己转义。`session` 填同一个名字时 `cd` 和 `export` 跨调用承接；固定环境放 `prelude`。`timeout` 单位秒，最大 3600。
- **`term_pty`** 把命令打进一扇已打开的终端，环境在里面持续累积；输出是终端渲染结果（有回显、折行、颜色），适合交互和给人看，不适合程序解析。`timeout` 是这次最多等多久，到点命令还在跑就先交已回来的内容。
- **TUI、菜单、安装向导**用 `term_write`：`keys` 取 `up`、`down`、`left`、`right`、`ctrl-c` 等，文字放 `text`，回车用 `submit: true`。前台命令停不下来也用 `term_write` 发 `ctrl-c`，不要新开终端去结束它。
- **优先读文本**：`term_lines`（带行号读缓冲）和 `term_read` 比截图快。要截指定行时先 `term_lines` 看行号，再把 `startLine`/`endLine` 传给 `term_screenshot`，两端都包含；整段历史用 `term_screenshot_scrollback`。
- **断线恢复**:`status` 不是 `connected` 时用 `term_reconnect` 恢复同一扇（编号、备注保留），不要 `connection_open` 重开。
- **文件传输**:`sftp_list / mkdir / upload / download / rename / remove`，单文件 512MB 上限，几个 GB 的文件留在远端处理。
- **多跳板连接**：目标主机信息仍放 `host` / `username` / `secret`，中间跳板放 `jumps`，顺序是本机到目标主机，最多 9 跳。每跳填 `host` / `port` / `username`，需要时填 `secret`。`connection_create` 可直接创建；`connection_update` 不传 `jumps` 保留原链，传 `[]` 清除，传非空数组整体替换，修改其中一跳也要提交完整数组。未提供 `secret` 的相同跳板会沿用已存密码。`connection_list` 只返回跳板信息和 `hasSecret`，不返回密码。配置后 `connection_open`、`term_exec` 和 SFTP 工具都会自动走跳板链。
- 确认某条连接或终端的用途后写入备注：连接用 `connection_update` 的 `remark`，终端用 `term_update`。

## 工具一览

连接：`connection_list / open / close / create / update / delete`
命令：`term_exec / term_pty`
终端：`term_list / write / read / lines / reconnect / close / update / open_local`
画面：`term_screenshot / term_screenshot_scrollback`
文件：`sftp_list / mkdir / upload / download / rename / remove`
