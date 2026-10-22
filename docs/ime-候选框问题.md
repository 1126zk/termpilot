# IME 候选框乱飞 / 自绘兜底问题（已修复）

> 2026-10-21 排查记录。根因确认在 WebView2 与微软拼音之间：**多窗口共用同一个
> WebView2 浏览器进程，输入法桥是浏览器进程单例，切窗后 TSF 焦点没跟上**。
> 修复：每扇窗口用独立 WebView2 数据目录（`internal/app/webview_dir_windows.go`，
> 按占用抢锁分配），浏览器进程随之分开。2026-10-22 复发过一次：首版修复靠
> `--extra-window` 参数判断隔离，唯一带参入口"新窗口"按钮被删后修复失效，
> 已改为按实际占用抢锁（详见 `docs/经验记录.md` 2026-10-22 条目）。
> 本文保留作排查记录，供后续参考，避免重复走弯路。

## 现象

两个症状，高发于"双窗口来回切换后"：

1. **候选框飞左上**：打中文时，微软拼音弹出**它自己画的**组字窗（白底、右侧带绿色输入法图标）
   和候选条，钉在窗口左上角，不跟随输入光标。
2. **上屏重复**（曾出现）：选词后文本出现两遍（选"注意"上屏"注意注意"）。

注意区分两种形态：正常时是 **xterm 画的黑底拼音框**（`.composition-view`）+ IME 候选条跟随光标；
异常时是 **微软拼音自绘的组字窗**（白框+绿图标）+ 候选条在左上角。后者说明 IME 掉进了
"自绘兜底模式"，完全不读应用上报的 caret 位置——所以前端把位置摆得多对都没用。

## 环境

- TermPilot（Wails v2 应用，Windows 11，WebView2 运行时 155.0.4283.62，已是新版）
- 前端 `@xterm/xterm` ^6.0.0（WebGL 渲染）
- 复现：PowerShell 本地终端、SSH 远程跑全屏 TUI（kimi/pi）都会中
- 关键时间线：单窗口时代（IME 定位修复 590559b / 2c649e5 之后）**从未出现**；
  `efa944d feat: 可以再开一扇窗口`（第二窗口 = 再起一个进程）之后高频出现，特别是窗口切换后

## 已用日志证实的事实（关键，别再怀疑前端定位）

在 `frontend/src/terminal/ime.ts` 加插桩（console.log 前缀 `[ime]`）后确认：

- 组字全程 `anchor=hardware {col, row}` 稳定正确，textarea 位置**一次都没跳**
- 组字期间没有意外的 `textarea` 移动（移动会触发 Windows 取消组字 → 上屏重复，
  这条链路已通过"检出后冻结锚点"修掉，重复症状在最后一轮日志里没有再出现）
- 即使定位全部正确，切窗口后 IME 仍然自绘+钉左上 → **IME 没有读应用上报的位置**

## 机制要点

- Windows 上候选窗位置 = 应用上报的 caret 位置，xterm 通过隐藏的
  `textarea.xterm-helper-textarea` 上报；xterm 原生只在 `compositionupdate` 和每次 render
  时摆位（`CompositionHelper.updateCompositionElements`），`compositionstart` 不摆
- textarea 默认样式 `left:-9999em; top:0`（屏幕外左上）；IME 在 start 时刻抓位置，
  抓到默认值会被系统钳到窗口左上角
- TermPilot 自己接管了摆放逻辑：`frontend/src/terminal/ime.ts` 的 `bindIme()` 覆盖
  `helper.updateCompositionElements`，`anchor()` 启发式找"程序画的光标"
  （孤立反色格 / 孤立方块字符 U+2580–259F / 孤立带底色空格）
- Wails 焦点转发正常：WM_SETFOCUS → `chromium.Focus()` → `MoveFocus`（v2.16.0 源码核对过）
- xterm 自己的注释都写了坑："输入框只能原地挪，移出终端 Windows 会取消组字"

## 试过且已回滚的（不要重复试）

1. 检测失败用 `lastAnchor` 兜底 —— 无效（前端定位本来就不是病根）
2. 组字期间冻结锚点、方块字符补 U+25AE、光标停 (0,0) 不采信 —— 仍飞
3. `compositionstart` 立刻摆位 + 组字后 textarea 不清样式（保持停放） —— 仍飞
4. 窗口 focus 时把 textarea 挪 1px 强制 Chromium 重新推送 caret 位置 —— 仍飞
5. 第二窗口进程用独立 WebView2 用户数据目录（`WEBVIEW2_USER_DATA_FOLDER` 环境变量，
   隔离浏览器进程） —— 当时记录"仍飞，已回滚"。**这条结论与后来的修复看似矛盾**：
   最终生效的修法（`9fe071f` 及之后的按占用抢锁版）同样是隔离数据目录，只是改用
   `Windows.WebviewUserDataPath` 选项显式传目录。区别在传参方式：已核对 go-webview2
   v1.0.22 `chromium.go:167`，它总会显式传一个数据目录（DataPath 为空时用
   `%AppData%\<exe名>`），环境变量和显式参数谁优先没验证过，当时也可能还有别的问题。
   环境变量那次没验证过进程是否真的隔离了，"无效"记录不作数。

## 还没试的方向（按性价比排序）

1. **微软拼音设置 → 常规 → 兼容性 → "使用以前版本的微软拼音输入法"开关**。
   这个开关直接切换输入法渲染管线（TSF 新 UI ↔ 旧版 IMM 风格），两分钟验证。
2. **换输入法对照**（搜狗/微信键盘/QQ拼音）。如果别的输入法切窗口后不飞，
   坐实微软拼音特有；如果都飞，是 WebView2 通病。
3. **最小复现**：写一个只有一个 textarea 的 Wails 双窗口 demo，切窗口打中文。
   能复现就拿着去 https://github.com/MicrosoftEdge/WebView2Feedback 报 issue / 搜已有 issue
   （搜 "IME candidate window position"、"composition window top left"）。
4. 如果确认是 WebView2 通病且短期无解，产品侧兜底：提供"在终端内嵌一个自绘组字框、
   禁用 IME 跟随"的选项，或文档注明微软拼音兼容模式。

## 插桩参考（排查时可直接恢复）

ime.ts 里曾验证有效的日志点：`compositionstart/update/end` 事件序列与 textarea.value、
`term.onData` 实际发送内容（查重复）、textarea 位置变化（查"移动取消组字"）、
`anchor()` 决策路径与扫描失败时底部 8 行单元格 dump（`cell.getChars()/isInverse()/isBgDefault()`）、
window focus/blur。注意 DevTools 默认不显示 console.debug，用 console.log。

## 环境噪音（与本 bug 无关但会干扰）

- 本机 wails CLI 是 v2.12.0，项目 go.mod 用 v2.16.0；每次跑 `wails dev` 都会把 go.mod 改回
  v2.12.0。升级：`go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`
- 之前排查时顺手修了 dev 白屏（`c2098e4` 图标静态化），与本 bug 无关
