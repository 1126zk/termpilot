# TermPilot Wails 重写计划

> 分支：`wails-rewrite`。本文档是唯一执行依据，后续以 goal 模式一次完成。
> 前提调研结论：Electron 版功能与界面可以在 Wails（Go + WebView2）上复刻；前端约 8300 行代码可近乎原样搬运，工作量集中在 Go 重写约 5000 行主进程。
> **本期先走兜底方案**（见 §3）；如果实现后体验不好，再做第二阶段「复刻」（见 §8）。

---

## 1. 目标

- 用 Wails + Go 重写 TermPilot 桌面应用，**功能、界面、交互与 Electron 版保持一致**（除 §3 明确让步的两处）。
- 保留现有产物形态：Windows 安装包（含 CLI 安装到 PATH）、本机 MCP Server、Go CLI。
- 保留用户数据：`userData/termpilot.db` 的 sqlite schema 原样沿用（见 §7 数据迁移）。

非目标：不新增功能、不重新设计 UI、不改变 MCP 工具目录（22 个工具的定义与 `conn-`/`term-` 编号体系原样保留，Agent 侧无感知）。

---

## 2. 总体架构

```
┌──────────────────────── Go 后端（Wails app）────────────────────────┐
│  storage (modernc.org/sqlite)   sshpool (x/crypto/ssh)              │
│  terminal (SSH shell + 本机 ConPTY/pty)   sftp (pkg/sftp)           │
│  exec / forward / mcp (go-sdk, StreamableHTTP, :3927)               │
│  cli 安装与拉起逻辑并入主程序（现有 cli/ 的 Go 代码大部分复用）          │
└──────────────────────────────▲───────────────────────────────────────┘
                               │ Wails 绑定（invoke）+ EventsEmit/EventsOn（推送）
┌──────────────────────────────┴───────────────────────────────────────┐
│        渲染层：现有 src/renderer 原样搬运，仅替换 window.api 实现        │
└──────────────────────────────────────────────────────────────────────┘
```

关键决策：

- **Wails 版本定为 v2（lib v2.16.0，CLI v2.12.0）**：v3 仍是 alpha 且有拖放回归前科，本期兜底方案不依赖任何 v3 独有特性；第二阶段若要恢复拖放再评估升级 v2.16 拖放支持或 v3。（2026-10-12 实施时定案，替代 §4 库选型里"优先 v3"的说法）
- **前端原样搬运**：React 19 + shadcn/radix + Tailwind v4 + zustand + xterm.js(WebGL) + Monaco 全部保留。renderer 现在零 Node/Electron import，唯一耦合是 `window.api`（84 处调用、13 个命名空间、约 66 个方法）。
- **桥接模式（Bridge）**：Go 侧不为 66 个方法逐个生成 Wails 绑定，而是暴露**一个**绑定方法 `Bridge.Invoke(channel string, payload json) (json, error)`；Go 内部维护 channel → handler 注册表（与现有 `ipc.ts` 的 `registerIpc()` 形状一一对应）。前端适配层把 `window.api.term.create(opts)` 翻译成 `Invoke('term:create', opts)`。
- **事件模型同构映射**：主进程推事件 → Go `runtime.EventsEmit(ctx, channel, payload)`；前端订阅 → `EventsOn(channel, cb)`（在 `@wailsio/runtime` 或 `window.runtime`）；`ipcRenderer.send` 上行 → 同一个 `Bridge.Invoke`（fire-and-forget 调用方忽略返回值）。事件名沿用 `src/shared/ipc-channels.ts` 的字符串常量。

---

## 3. 本期范围：兜底方案（明确让步的两处）

| 功能 | Electron 现状 | 本期做法 |
|---|---|---|
| 截图 | 默认走 `webContents.capturePage` 窗口实拍；「合成算法」是实验开关（`appearance.experimentalScreenshot`，`captureView.ts:119`） | **删除实拍路径，只保留缓冲合成**：`captureTerminalView` 恒走 `captureReplay`/`paintRange`（composeGl.ts），设置里的开关移除或固定为开。截图语义从「实拍」变为「按缓冲重绘」，需把 compose 路径打磨到可默认启用（字符/配色边缘情况、逐屏+长图输出格式对齐现有产物）。 |
| 拖文件上传 | `webUtils.getPathForFile` 换真实路径后 `sftp.uploadPaths`（`preload/index.ts:128`、`FileTree.tsx:272-309`） | **删除拖入手势**：`FileTree.tsx` 的 `dropTarget`/`uploadInto`/拖放高亮全部移除，只保留右键菜单「上传文件 / 上传文件夹」走原生文件选择对话框（Wails `OpenFileDialog`/`OpenDirectoryDialog`），功能不丢，丢的只是拖拽交互。 |

其余全部功能按现状复刻，无让步。

---

## 4. Go 后端重写清单（现有模块 → Go 实现）

| 现有模块 | 行数级 | Go 实现 | 要点 |
|---|---|---|---|
| `StorageService.ts` | ~813 | `modernc.org/sqlite`（纯 Go 免 CGO），schema 原样沿用 | 7 张表（sessions/mcp_config/appearance/host_notes/mcp_audit/snippets/history）；启动导入 `~/.ssh/config`、写回、写 `mcp.json` 的逻辑照搬 |
| 凭据加密（safeStorage） | — | Windows DPAPI（`golang.org/x/sys/windows` 的 `CryptProtectData`）；macOS Keychain / Linux secret-service 用 `zalando/go-keyring` | 老密文兼容见 §7 |
| `ssh-config.ts`（拨号层） | — | `golang.org/x/crypto/ssh` | 密码认证、15s keepalive、多跳跳板链（`Dial` 逐级穿透；跳板禁转发时回退 shell 内再 ssh + 自动应答密码）、ProxyCommand（`os/exec` 起本地进程当 `net.Conn`）、算法选择（含 OpenSSH `+/^/-` 前缀语法）、超时/IPv4-6/主机密钥开关 |
| `ssh-config-file.ts` | — | Go 重写解析/改写 `~/.ssh/config` 具体 Host 段 | 保留通配符/Match/Include 不动；原子写（tmp+rename+0600）；`suggestAlias` |
| `SshPool.ts` | ~166 | Go 连接池 | 同 session 单连接、引用计数、半死重拨、`acquireIsolated` |
| `forward.ts` | — | `net.Listen` + ssh `Dial`（local）/ `Listen` + `Accept`（remote） | 两端固定 127.0.0.1、单条失败只记日志、连接关闭统一回收 |
| `TerminalService.ts` | ~773 | SSH shell 通道 + 本机 PTY | **本机 PTY 是最大风险点**：Windows 用 ConPTY（`github.com/UserExistsError/conpty` 或自封装 `CreatePseudoConsole`），Unix 用 `creack/pty`。环形缓冲 100K、状态事件、重连 liveGen、execCommand 提示符检测 + 退出码探针、cwdOf 提示符解析、本机 shell 探测（PowerShell/CMD/pwsh7/Git Bash/WSL）全部照搬 |
| `SftpService.ts` | ~952 | `github.com/pkg/sftp` | list/mkdir/remove/rename/上传下载（目录递归）、流式传输（可取消+进度事件、512MB 上限）、远程文本读写（1.5MB 上限）、`~` 展开、半死重拨、远端无 SFTP 子系统时执行 `resources/install-sftp.sh` 后走 fresh 连接 |
| `ExecService.ts` | ~241 | ssh `NewSession` exec 通道 | stdout/stderr 分流、exitCode、超时截断、命名 session 环境持久化（`~/.cache/termpilot/exec/`）、detectOs |
| `McpService.ts` + `tool-catalog.ts` | ~975+313 | 官方 `github.com/modelcontextprotocol/go-sdk/mcp`（StreamableHTTP） | 监听 127.0.0.1:3927、Host 校验、Bearer 令牌（`crypto/subtle` 常量时间比较）、`/cli` 端点、危险命令正则 + 敏感路径弹窗确认、审计写库；**22 个工具定义逐一对齐**（zod schema → Go struct + jsonschema） |
| `LocalFsService.ts` | ~139 | `os`/`io/fs` | IPC 边界统一正斜杠路径 |
| `ipc.ts` / preload | ~80 通道 | Wails 绑定方法 + 事件名 | 与 `src/shared/ipc-channels.ts` 一一对应；适配层保证 renderer 无感 |
| 窗口/生命周期（`index.ts`、`window-chrome.ts`） | — | Wails 窗口 API | 单实例锁（Go 侧用 named mutex / lockfile）、固定 userData 到 `%APPDATA%\TermPilot`（含旧目录迁移）、主题色切换、白屏自愈（重载+尺寸 nudge）、退出统一 dispose |
| `install-cli.ts` + `cli/` | ~451 | CLI 已是 Go，逻辑并入主程序或保持独立二进制 | 复制到 `userData/bin`、写 PATH（Windows 注册表 PowerShell / Unix 软链+profile）、写 `launch.json`；CLI 拉起主程序逻辑保留 |
| 卸载清理 | — | NSIS `customUnInstall` + `uninstall-path.ps1` 沿用 | Wails 打包支持自定义 NSIS 钩子 |

**库选型汇总**（全部需在动手前 `go mod` 验证可用版本）：

- `github.com/wailsapp/wails/v3`（优先 v3；若稳定性不可接受退 v2 最新版，注意 v2 无窗口拖拽区域新 API 差异）
- `golang.org/x/crypto/ssh`、`github.com/pkg/sftp`
- `github.com/creack/pty`（Unix）+ ConPTY 封装（Windows）
- `modernc.org/sqlite`
- `github.com/modelcontextprotocol/go-sdk`
- `github.com/zalando/go-keyring`（macOS/Linux 凭据）
- `golang.org/x/sys/windows`（DPAPI、注册表、窗口细节）

---

## 5. 前端搬运与适配层

1. `src/renderer` 整体拷入 Wails 前端目录，构建链从 electron-vite 换成纯 Vite（Wails 模板），别名 `@/`、Tailwind v4、Monaco `?worker`、Nerd Font 资源保持。
2. 新建 `src/renderer/src/wails-api.ts`：实现与 `src/preload/index.ts` 导出的 `Api` 类型**逐字段同构**的对象挂到 `window.api`；内部调 Wails 生成绑定与 `EventsOn`（`@wailsio/runtime`）。
3. 删除/改造清单：
   - 截图：按 §3 只留合成路径（`captureView.ts` 删 `grab/shoot/hideFloaters/stitch` 实拍分支与 `experimentalScreenshot` 开关）。
   - 拖放：按 §3 删 `FileTree.tsx` 拖放相关代码。
   - 窗口控制：`win.*` 五个方法映射到 Wails 窗口 API；`--wails-draggable` 替换 `-webkit-app-region`（`TabBar.tsx` 顶部拖拽区）。
   - `window.api.platform`：由适配层注入（Go 侧 `runtime.GOOS` 下发）。
4. `src/shared/` 的类型仍给前端用；Go 侧另维护一份对齐的 struct（tool-catalog 与 IPC 载荷以现有 `types.ts` 为准绳）。

---

## 6. Spike 验证（开工第一周必须先过）

| # | 验证项 | 通过标准 | 失败的 B 方案 |
|---|---|---|---|
| 1 | Go ConPTY 跑 PowerShell + xterm 联调 | 输入/输出/resize/Ctrl 组合键正常，退出码可取 | 退而求其次用 `os/exec` 管道模式（无 PTY 语义，体验降级，需重估） |
| 2 | Wails frameless + `--wails-draggable` 复刻标题栏 | 拖拽、双击最大化、自绘三按钮、最大化状态事件齐全 | 用系统原生标题栏（界面有变，需用户确认） |
| 3 | xterm WebGL addon + Monaco worker 在 WebView2 内 | 终端 WebGL 渲染不黑屏、Monaco 正常加载 | xterm 回退 Canvas 渲染（性能略降）；Monaco 改 CDN/单文件 |
| 4 | MCP go-sdk StreamableHTTP 与现有 CLI/Agent 客户端互通 | 现有 `cli/` 二进制不改能直连新后端 22 个工具 | 手搓 HTTP+JSON-RPC（协议不复杂，可行但费时） |

Spike 不过不准进入正式重写；spike 结论回填本文档。

---

## 7. 数据迁移与兼容

- **sqlite**：schema 与 `userData/termpilot.db` 路径不变，Go 直接打开现有库（WAL 模式保留）。
- **safeStorage 密文**（已实测验证，2026-10-12）：Electron 44 在 Windows 的格式是 `"v10" || nonce(12) || AES-256-GCM || tag`，密钥是 `Local State` 里 `os_crypt.encrypted_key`（`base64("DPAPI" || CryptProtectData(key))`）。未启用 App-Bound Encryption，**Go 用 `CryptUnprotectData` 解出 AES key 后即可双向兼容解密存量密文**——`internal/secrets` 已实现并对真实 `%APPDATA%\TermPilot` 库实测通过，无需"重输密码"降级。macOS/Linux 走 Chromium 规则的 keyring 口令派生（`secrets_keyring.go`），未真机验证。
- **`~/.ssh/config`**：解析/写回逻辑照搬，行为不变。
- **`mcp.json` / `launch.json`**：格式不变，现有 CLI 与各 Agent 配置无感知。
- **截图目录**：仍限 `userData/screenshots` 下。

---

## 8. 第二阶段：复刻（本期不做，效果不好再启动）

触发条件：兜底方案上线后，用户实际体验认为截图或上传交互不可接受。

1. **实拍截图**：通过 WebView2 原生 `ICoreWebView2::CapturePreview` 自写 Go 绑定拍窗口像素（Wails 未暴露，需 cgo 或 `winsvc` 级封装），恢复「当前画面实拍 + 逐屏实拍拼接长图」与藏弹窗逻辑。
2. **拖入上传**：实测 Wails v2.16+/v3 的 `EnableFileDrop`（2026-09 才加入，v3 alpha.36+ 有过回归 bug #4701）能否拿到拖入文件的真实路径；可行则恢复 `FileTree` 的 `dropTarget` 交互，与文件对话框并存。
3. **标题栏细节 1:1**：如果 spike 2 有降级，此阶段补齐。
4. 评估是否升级 Wails v3 正式版。

---

## 9. 验收标准（goal 完成判据）

- [ ] 四个 spike 全部有结论，B 方案触发的已记录
- [ ] 22 个 MCP 工具用现有未改动的 `cli/` 二进制全部调通（`tools`/`schema`/`call` 输出与现版一致）
- [ ] SSH：密码登录、多跳跳板（含禁转发回退）、ProxyCommand、算法前缀语法、本地/远程端口转发，逐条过
- [ ] 终端：SSH shell 与本机 PowerShell/CMD/Git Bash/WSL 可用；50K 行 scrollback 切标签不丢；重连编号不变
- [ ] SFTP：列表/新建/重命名/删除/上传（对话框）/下载/远程编辑（Monaco）/无 SFTP 子系统机器的 `install-sftp.sh` 引导
- [ ] 截图：合成路径出图正确，长图拼接正确，MCP `term_screenshot`/`term_screenshot_scrollback` 可用
- [ ] 设置页：外观/主题（66 套终端主题表不变）、MCP 开关与令牌、审计记录
- [ ] 数据：用 Electron 版生成的 `termpilot.db` 直接启动新版，连接/片段/历史/备注全在；密码迁移按 §7 结论执行
- [ ] CLI 安装到 PATH、窗口未开时 CLI 拉起主程序、卸载清 PATH
- [ ] 三平台构建出包（Windows 至少出 NSIS 安装包）
- [ ] 界面走查：与 Electron 版逐页面对比，除 §3 两处让步外无可见差异

---

## 10. 工程量估算（1 人，熟悉 Go + 本项目）

| 阶段 | 估时 |
|---|---|
| Spike 验证（§6） | 3–5 天 |
| 前端搬运 + `window.api` 适配层 + 两处兜底改造 | 1–2 周 |
| Go 后端重写（§4 全表） | 4–6 周 |
| 打包、PATH 安装、三平台联调、数据迁移 | 1–2 周 |
| **合计** | **约 6–10 周** |

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| ConPTY Go 库不成熟 | spike 1 前置；失败则评估自封装 `CreatePseudoConsole`（API 面小，可控） |
| Wails v3 alpha 稳定性（拖放回归等前科） | 本期不依赖拖放；绑定/事件/窗口 API 是 v2 就成熟的部分 |
| MCP 工具行为漂移 | 以 `tool-catalog.ts` 的 zod schema 为准逐字段对齐，CLI 互通测试兜底 |
| safeStorage 老密文解不开 | §7 的降级方案（重输一次密码），影响一次性 |
| WebKitGTK（Linux）WebGL/worker 兼容 | spike 3 覆盖；Windows 优先，Linux 可后置 |
| 截图合成路径边缘情况 | 现有 `experimentalScreenshot` 已有用户验证基础，重写期集中打磨 |

---

## 12. 实施记录（2026-10-12，goal 执行回填）

### Spike 结论

| # | 结论 | 证据 |
|---|---|---|
| 1 ConPTY | **PASS**。`UserExistsError/conpty` v0.1.4，PowerShell/CMD 启动、读写、resize、退出码全过 | `spikes/conpty`（4 连跑无随机失败） |
| 2 frameless 标题栏 | **基本 PASS**。frameless + `--wails-draggable` + 自绘三按钮在真机渲染正常；拖拽手感待人工确认 | UIA 走查见下 |
| 3 WebGL/Monaco | **部分验证**。xterm 在 WebView2 挂载正常（Terminal input 元素存在）；WebGL 上下文与 Monaco 未自动化验证，待人工确认 | 同上 |
| 4 MCP go-sdk | **PASS**。go-sdk v1.8.0 StreamableHTTP + /cli 契约 15 项验证全过；app 内端到端二次验证通过 | `spikes/mcp`、SMOKE2 |

### 冒烟与 UIA 走查证据（真机自动化）

- `TERMPILOT_SMOKE=1`：临时 userData 启动 → 建本机 CMD 终端 → echo 回读 → `SMOKE_RESULT: PASS`（storage + terminal + ConPTY 端到端）。
- `TERMPILOT_SMOKE=2`：开启 MCP → /cli `tools/schema/call` 通过、无令牌 401、/mcp 裸 JSON-RPC initialize 通过 → `SMOKE2_RESULT: PASS`。
- `TERMPILOT_SMOKE=3`（Docker linuxserver/openssh-server 双容器，注意该镜像默认 `AllowTcpForwarding no` 且 home 是 /config）：**直连终端 echo、exec 通道、SFTP list/上传/读回、本地端口转发、跳板链 7 项全 PASS**。
- `spikes/more`（第三容器禁转发）：**远程转发(-R)、ProxyCommand（docker exec nc 当传输）、跳板禁转发回退（跳板 shell 自动应答密码）3 项全 PASS**。
- CLI 端到端（临时 userData + 真实 CLI 二进制）：`tools` 目录、`term_open_local` 开终端（经前端标签→bindView 全链路）、`term_pty` 在 PowerShell 执行并回读输出、**窗口关闭时 CLI 自动拉起主程序**全部通过。
- UIA 走查：React 挂载、HostsPage 渲染、`~/.ssh/config` 具体主机自动导入、「新建终端」菜单列出 PowerShell/CMD/PowerShell 7/Git Bash/WSL、CMD 标签打开、localfs 文件树列出 C:/Users/11268。
- 真实 `%APPDATA%\TermPilot` 启动：真实连接正常加载（数据兼容）。

### 联调期发现并修复的缺陷（均已回归验证）

1. **空数据库白屏（发布级）**：`store.List()` 等方法空结果返回 nil slice → Wails 序列化为 `null` → 前端 `sessions.filter` TypeError → React 根卸载（无 error boundary、console.error 不触发 window.onerror，表现为静默白屏）。修复：storage.List/ListAudit/ListSnippets/ListHistory、sftpx readdir 调用处全部改为非 nil 空 slice。空库启动 UIA 复测 NODES 9→24。
2. **本机 PowerShell 命令不执行**：ConPTY 写入裸 `\n` 时 PSReadLine 不提交（node-pty 在 Windows 会把裸 LF 转 CRLF）。修复：`conptyChannel.Write` 做裸 LF→CRLF 转换，`term_pty` 复测输出正确。
3. **smoke 模式 ssh-config 钩子污染风险**：`TERMPILOT_SMOKE` 设置时跳过写回钩子（导入只读保留）。
4. `configOptionsFromFields` 空跳板切片越界 panic（已修）。
5. Wails v2 在 DomReady 前 EventsEmit 会 eval 进未初始化的 webview：`emit` 加了 ready 门（OnDomReady 后置位），并保留 Windows 尺寸 nudge（recoverBlankWindow 的 nudge 部分）。

### 联调环境说明（复测方法）

Docker Desktop + `lscr.io/linuxserver/openssh-server`：两个容器挂同一 network（target 发布 2222、jump 发布 2223、strict 发布 2224 保持默认禁转发），需把 `/config/sshd/sshd_config`（**不是** /etc/ssh/sshd_config）的 `AllowTcpForwarding` 改为 yes 后 restart。测试后容器与 network 已清理。

### 与 Electron 版的已知偏差（除 §3 两处主动让步外）

1. **外观主题切换不再实时改窗口底色**（Wails v2 运行期无此 API），重启生效。
2. **白屏自愈（recoverBlankWindow）未移植**（Wails 无 executeJavaScript 等价物）；WebView2 稳定性好于 Electron 标题栏覆盖层，先观察。
3. **最大化状态事件用 250ms 轮询**实现（Wails 无原生事件），无感差异。
4. **capture:copy（图片进剪贴板）Windows 走 PowerShell** `SetImage`，macOS 走 osascript，Linux 暂不支持。
5. **单实例第二实例**只还原+显示窗口（v2 无 WindowFocus API）。
6. 手动 `go build` 必须带 `-tags "desktop,production"`（Wails 强制），正式构建一律 `wails build`。
7. `internal/sftpx/install_sftp.sh` 与 `resources/install-sftp.sh`、`wailsapp/resources/SKILL.md` 与 `skills/termpilot/SKILL.md` 为双份拷贝，改动需两边同步。

### 待办

- [ ] §9 全量验收（SSH 跳板/SFTP/端口转发/ProxyCommand 等需真实服务器；本机无 sshd/Docker 守护进程，无法自动化，需人工走查）
- [x] NSIS 安装包（`TermPilot-amd64-installer.exe` 22.5MB，卸载钩子已接 uninstall-path.ps1 清 PATH，makensis 用便携版 `tmp/nsis-3.10`）
- [x] macOS/Linux 打包 → 本机无法交叉构建，已加 `.github/workflows/wails-release.yml`（`wails-v*.*.*` 标签触发三平台 CI）
- [ ] WebGL/Monaco/标题栏拖拽 人工确认
