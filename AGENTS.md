# AGENTS.md

## 有现成的就复用，别重造

动手写新东西之前，先找项目里有没有现成的：

- **UI 组件**：`frontend/src/components/ui/`（button、input、select、switch、dialog、tooltip、dropdown-menu、context-menu……）。要下拉就 `select.tsx`，别用原生 `<select>`；要开关就 `switch.tsx`
- **终端**：挂终端用 `TerminalView`（右键菜单、截图都在里面），别自己裸挂 `terminalPool.attach`
- **拖拽排序**：`frontend/src/components/flip.ts`（pointer 拖拽 + FLIP 让位，TabBar 在用），别用 HTML5 原生 `draggable`
- **后端执行**：跑远端命令走 `sshx.Exec`（`ExecOptions` 带超时和逐行回调），调用方必须检查 `res.TimedOut`，超时不等于成功
- **IPC 通道**：加通道按 `shared/ipc-channels.ts` → `internal/app/bridge.go` → `handlers.go` → `frontend/src/wails-api.ts` 这条链走

不确定有没有现成的，先 Glob/Grep 找一圈再问。
