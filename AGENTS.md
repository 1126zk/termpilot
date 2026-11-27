# AGENTS.md

## 打 tag 发版

版本号只有一处来源：`frontend/package.json` 的 `version`。关于页显示的版本是 `main.go` 编译时嵌这份文件，`app.go` 不写死。`wails.json` 没有版本字段。

要改的只有这两个文件，改成同一个号：

- `frontend/package.json` 的 `version`
- `frontend/package-lock.json` 里两处本包 version：文件头一处，`packages[""]` 里一处

锁文件里其它包碰巧同号的不要动。`npm ci` 会核对 package.json 和 lock 是否一致，漏改 lock 会在装依赖时挂。

发版前在 `frontend` 跑 `npm run build`（`tsc --noEmit && vite build`）。CI 的 `wails build` 用的就是这条前端构建，类型或打包错误会让三个平台一起挂。本地不要为了发版跑 `wails build`：本机 CLI 和 go.mod 里的 Wails 版本不一致时，它会改写 `go.mod`。

提交只包含上面两个 json，说明固定为 `chore: 版本 x.y.z。`。`frontend/package.json.md5`、`go.mod` 的换行噪声不要带上。

顺序：

1. 改版本并提交，推到 main
2. 在这个提交上打轻量 tag `vX.Y.Z`（`v` 后面必须和 package.json 的 version 逐字相同），再推 tag

`release.yml` 由 `v*.*.*` tag 触发。校验不等就在三个平台的第一步退出。先打 tag 再改版本，或 tag 打在还没有版本提交的旧提交上，都会挂。

## 构建应用前：必须先跑 prebuild

禁止直接运行 `wails build`。正确顺序永远是：

```bash
node scripts/prebuild.mjs
wails build
```

`prebuild.mjs` 会把 `resources/icon.png` 同步到 `build/appicon.png`，并删除旧的 `icon.ico` 强制重建。缺少这一步时，Wails 会生成默认图标，绝不能把它当成正常结果。

## 有现成的就复用，别重造

动手写新东西之前，先找项目里有没有现成的：

- **UI 组件**：`frontend/src/components/ui/`（button、input、select、switch、dialog、tooltip、dropdown-menu、context-menu……）。要下拉就 `select.tsx`，别用原生 `<select>`；要开关就 `switch.tsx`
- **终端**：挂终端用 `TerminalView`（右键菜单、截图都在里面），别自己裸挂 `terminalPool.attach`
- **拖拽排序**：`frontend/src/components/flip.ts`（pointer 拖拽 + FLIP 让位，TabBar 在用），别用 HTML5 原生 `draggable`
- **后端执行**：跑远端命令走 `sshx.Exec`（`ExecOptions` 带超时和逐行回调），调用方必须检查 `res.TimedOut`，超时不等于成功
- **IPC 通道**：加通道按 `shared/ipc-channels.ts` → `internal/app/bridge.go` → `handlers.go` → `frontend/src/wails-api.ts` 这条链走

不确定有没有现成的，先 Glob/Grep 找一圈再问。

## 界面上别写说明废话

控件自己能看懂的，不要在下面再补一段解释：原理、前置条件、下一步该怎么点、文件名举例，都不要。按钮、输入框、占位符、报错把事情说完就停。

## 不要再做云浏览器

云浏览器做过，效果不佳，已经删掉。不要再加。

## 笔记编辑器里的图片

`NotesTool.tsx` 的编辑器是 contentEditable，图片是块级 `<img>`。踩过的坑：

- **每张图片必须独占一个 `<div><img></div>`**，粘贴走 `insertImage`，加载走 `toEditorHtml`，都会调 `isolateImage` 拆好。图片和下一行挤在同一个块里（比如 `<img><br>`）时，紧挨图片后面的光标 Chrome 有时画在图片上、有时画在下一行，Selection API 读不出是哪种，当前行高亮就会来回跳
- **当前行只按 DOM 顺序判断（`markIndex`）**，不要去量光标画在哪：量不出 affinity；插零宽字符去量会改 DOM，重设选区还会把光标挪走，越修越跳
- **图片前后的 Backspace / Delete 自己处理（`deleteNearImage`）**。Chrome 自带的删除碰到块级图片要么没反应，要么把下一行文字并进图片块
- **算行号要进 `<span>` 等行内元素**。Chrome 合并行时会把文字包进 `<span>`，跳过它这一行就没有行号
