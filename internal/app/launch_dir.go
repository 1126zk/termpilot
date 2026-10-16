package app

import "strings"

// dirFromArgs 取出 --dir <path> 或 --dir=<path>。右键菜单用前一种。
func dirFromArgs(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--dir" && i+1 < len(args) {
			return strings.TrimSpace(args[i+1])
		}
		if strings.HasPrefix(arg, "--dir=") {
			return strings.TrimSpace(strings.TrimPrefix(arg, "--dir="))
		}
	}
	return ""
}

func (a *App) noteLaunchDir(dir string) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return
	}
	a.launchMu.Lock()
	a.launchDir = dir
	a.launchMu.Unlock()
}

func (a *App) takeLaunchDir() string {
	a.launchMu.Lock()
	defer a.launchMu.Unlock()
	dir := a.launchDir
	a.launchDir = ""
	return dir
}

// pingLaunchDir 通知前端来取目录。前端还没挂上时事件会丢掉，目录留着等它来取。
func (a *App) pingLaunchDir() {
	a.launchMu.Lock()
	dir := a.launchDir
	a.launchMu.Unlock()
	if dir == "" {
		return
	}
	a.emit("app:open-dir", dir)
}
