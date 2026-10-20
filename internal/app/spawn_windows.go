//go:build windows

package app

import (
	"os/exec"
	"syscall"
)

// startDetached 启动另一份 TermPilot。新进程不跟着这扇窗口退出。
func startDetached(exe string, args ...string) error {
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
