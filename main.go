package main

import (
	"embed"
	"runtime"

	"termpilot/internal/app"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	a := app.NewApp()

	err := wails.Run(&options.App{
		Title:     "TermPilot",
		Width:     1440,
		Height:    900,
		MinWidth:  960,
		MinHeight: 600,
		// Windows 隐藏系统标题栏，最小化/最大化/关闭由界面自绘（与标签栏同行）。
		// 其他平台暂用系统标题栏。
		Frameless:       runtime.GOOS == "windows",
		CSSDragProperty: "--wails-draggable",
		CSSDragValue:    "drag",
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// 拖文件进文件树上传要拿本地绝对路径。不开 DisableWebViewDrop：Windows 上它会让
		// WebView2 拒收一切外部拖入，前端连 drop 事件都收不到。默认的"拖进来就打开文件"
		// 由前端注册 OnFileDrop 后 Wails 的监听统一 preventDefault 掉。
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		// 与 Electron 版默认深色底色一致，避免浅色主题外的白屏首帧。
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		// 每扇窗口各用一个 WebView2 数据目录（按占用抢锁分配）。共用时两窗挤在
		// 同一个浏览器进程里，切窗口后微软拼音拿不到光标位置，候选框钉在左上角
		// （详见 docs/经验记录.md 2026-10-22 条目）。
		Windows: &windows.Options{
			WebviewUserDataPath: app.WebviewDataDir(),
		},
		OnStartup:  a.Startup,
		OnDomReady: a.DomReady,
		OnShutdown: a.Shutdown,
		Bind: []interface{}{
			a.Bridge,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
