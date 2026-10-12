package main

import (
	"embed"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

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
		// 与 Electron 版默认深色底色一致，避免浅色主题外的白屏首帧。
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		OnStartup:        app.startup,
		OnDomReady:       app.domReady,
		OnShutdown:       app.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "termpilot-single-instance",
			OnSecondInstanceLaunch: app.onSecondInstance,
		},
		Bind: []interface{}{
			app.bridge,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
