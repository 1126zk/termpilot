# TermPilot

本机 SSH 终端（Wails + Go + React + xterm.js），内置 MCP 服务，Agent 可以接管已打开的会话继续操作。

## 环境要求

- Go 1.26+
- Node.js 20+
- Wails CLI：`go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`
- Linux 需要 webview 依赖：`sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev`

## 运行

```bash
cd frontend && npm install && cd ..
node scripts/prebuild.mjs   # 编译配套 CLI + 同步图标（wails build 前的准备）
wails dev
```

## 打包

```bash
node scripts/prebuild.mjs [darwin|linux|windows]
wails build
```

产物是 `build/bin/` 下的可执行文件（Windows 为 `TermPilot.exe`，无安装包）。打 `v*.*.*` 标签会触发 GitHub Actions 三平台打包（tag 版本号需与 `frontend/package.json` 的 version 一致）。

## 目录结构

- `main.go` — Wails 入口（`wails dev` / `wails build` 要求 main 包在仓库根）
- `internal/app/` — 应用主体：App 生命周期、Bridge 绑定、IPC handler、系统操作；`internal/app/resources/` 是内嵌资源（SKILL.md、卸载脚本、CLI 二进制）
- `internal/`（其余）— 终端、SSH、SFTP、MCP、存储等核心服务
- `frontend/` — React 前端（Vite）
- `shared/` — 前后端共享的 TS 类型与常量
- `cmd/termpilot-cli/` — 配套命令行（独立 module，被主程序内嵌，Agent 通过它操作终端）
- `resources/icon.png` — 应用图标源文件（prebuild 时同步到 `build/appicon.png`）
- `scripts/prebuild.mjs` — `wails build` 前准备：编译 CLI 到 `internal/app/resources/cli/`，同步图标

## 数据位置

会话数据库在 `%APPDATA%\TermPilot\termpilot.db`（macOS / Linux 为对应的 userData 目录）。

## 待办

- 全屏程序（如 Pi）的滚动条轨道有时会整列错开：某一行的竖线比上下少一列，落在左边一格。把字形往格子外多画 1 像素对不上这个现象，改动已撤。下次从 Pi 和 xterm 的列宽计算查。
- Pi 的用户消息、代码块背景出不来。它的 system 主题要等终端回报背景色才画这些块。Windows 自带的 ConPTY 会吞掉前景色和背景色询问，并抢先回答查询结束标记，颜色回包到不了 Pi；晚到的回包写回去也没用，询问已经结束，还可能漏进输入框。Windows 终端用的是另一套控制台主机，所以那边正常。
