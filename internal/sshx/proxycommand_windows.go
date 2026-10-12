//go:build windows

package sshx

import (
	"os/exec"
	"syscall"
)

// hideWindow 对应 TS spawn 的 windowsHide：起 ProxyCommand 进程时不弹黑窗。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
