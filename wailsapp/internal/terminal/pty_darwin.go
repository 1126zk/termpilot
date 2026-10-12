//go:build darwin

package terminal

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// macOS 的 ptmx ioctl 常量（x/sys/unix 未导出），值来自 XNU 的 sys/ttycom.h，
// 与 creack/pty 的 darwin 实现一致。
const (
	ioctlTIOCPTYUNLK  = 0x20007452 // unlockpt
	ioctlTIOCPTYGNAME = 0x40807453 // 取从端路径，返回 char[128]
	ioctlTIOCPTYGRANT = 0x20007454 // grantpt
)

// openPTY Darwin：开 /dev/ptmx，grantpt + unlockpt，TIOCPTYGNAME 取从端路径。
func openPTY() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		if err != nil {
			_ = master.Close()
		}
	}()
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), ioctlTIOCPTYGRANT, 0); errno != 0 {
		return nil, nil, fmt.Errorf("grantpt: %v", errno)
	}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), ioctlTIOCPTYUNLK, 0); errno != 0 {
		return nil, nil, fmt.Errorf("unlockpt: %v", errno)
	}
	var name [128]byte
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), ioctlTIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		return nil, nil, fmt.Errorf("ptsname: %v", errno)
	}
	end := 0
	for end < len(name) && name[end] != 0 {
		end++
	}
	slave, err = os.OpenFile(string(name[:end]), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	return master, slave, nil
}
