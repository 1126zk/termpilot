//go:build !windows

package terminal

import (
	"os"
	"path"
)

// 非 Windows：本机终端直接用 $SHELL，对应 TS localShellExe / detectLocalShells 的非 win32 分支。

func localShellExe(shell string) string {
	if exe := os.Getenv("SHELL"); exe != "" {
		return exe
	}
	return "/bin/bash"
}

// DetectLocalShells 非 Windows 只给当前壳（TS 里 id 沿用了 'powershell'，保持对齐）。
func DetectLocalShells() []LocalShellInfo {
	exe := localShellExe("")
	label := path.Base(exe)
	if label == "." || label == "/" {
		label = "bash"
	}
	return []LocalShellInfo{{ID: "powershell", Label: label, Exe: exe}}
}
