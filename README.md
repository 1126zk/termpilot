# TermPilot

本机 SSH 终端（Electron + React + xterm.js），内置 MCP 服务，Agent 可以接管已打开的会话继续操作。

## 环境要求

- Node.js 20+
- Windows 上安装依赖时会编译 node-pty 原生模块，需要 Python 和 Visual Studio Build Tools
- 打包时需要 Go（编译 `cli/` 下的配套命令行）

## 运行

```bash
npm install
npm run dev
```

## 打包

```bash
npm run dist:win     # Windows（NSIS 安装包 + zip）
npm run dist:mac     # macOS（dmg + zip）
npm run dist:linux   # Linux（AppImage + deb）
```

产物在 `release/` 目录。

## 数据位置

会话数据库在 `%APPDATA%\TermPilot\termpilot.db`（macOS / Linux 为对应的 userData 目录）。
