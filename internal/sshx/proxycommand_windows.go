//go:build windows

package sshx

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// hideWindow 对应 TS spawn 的 windowsHide：起控制台子进程时不弹黑窗。
// CREATE_NO_WINDOW 让系统根本不配控制台——HideWindow 只是 SW_HIDE，
// 默认终端应用设成 Windows Terminal 时新控制台被它接管，SW_HIDE 藏不住。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
