//go:build linux || darwin

package terminal

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// Unix 本机 PTY：依赖里没有 creack/pty 且不许新增依赖，
// 这里用 golang.org/x/sys/unix 手写最小实现（等价于 creack/pty 的核心路径）：
// /dev/ptmx 开主端，ioctl 解锁取从端名，子进程 Setsid + Setctty 拿控制终端。

type unixPtyChannel struct {
	master *os.File
	cmd    *exec.Cmd
}

func (c *unixPtyChannel) Write(data []byte) error {
	_, err := c.master.Write(data)
	return err
}

func (c *unixPtyChannel) Resize(cols, rows int) error {
	return setWinSize(c.master.Fd(), cols, rows)
}

func (c *unixPtyChannel) Close() error {
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	return c.master.Close()
}

type winsize struct {
	rows, cols, xpix, ypix uint16
}

// setWinSize 对应 node-pty 的 resize（TIOCSWINSZ）。
func setWinSize(fd uintptr, cols, rows int) error {
	ws := winsize{rows: uint16(rows), cols: uint16(cols)}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return errno
	}
	return nil
}

// startLocalPty 与 Windows 版同签名：启动本机壳并接好读循环。
func startLocalPty(exe string, cols, rows int, onData func([]byte)) (Channel, func(), error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.Command(exe)
	cmd.Env = os.Environ()
	if home, herr := os.UserHomeDir(); herr == nil {
		cmd.Dir = home
	}
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, nil, err
	}
	_ = slave.Close() // 父进程不再需要从端
	if cols > 0 && rows > 0 {
		_ = setWinSize(master.Fd(), cols, rows)
	}
	ch := &unixPtyChannel{master: master, cmd: cmd}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := master.Read(buf)
			if n > 0 {
				onData(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}()
	wait := func() { _ = cmd.Wait() }
	return ch, wait, nil
}
