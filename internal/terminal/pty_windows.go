//go:build windows

package terminal

import (
	"context"
	"errors"
	"os"
	"strings"

	"termpilot/internal/winconpty"
)

// Windows 本机 PTY。用随程序带的 conpty.dll，不用系统 kernel32 里那份：
// 系统那份会吞掉前景色、背景色查询，并抢先回答查询结束标记。
// 用法：Start / Read / Write / Resize / Wait / Close。

type conptyChannel struct {
	cpty *winconpty.ConPty
}

func (c *conptyChannel) Write(data []byte) error {
	// PSReadLine 只认 CR 提交。裸 LF 收成 CR，不再留着 LF，
	// 否则命令执行后多余的换行会被当成续行，提示符变成 >>。
	_, err := c.cpty.Write(consoleEnter(data))
	return err
}

func (c *conptyChannel) Resize(cols, rows int) error {
	return c.cpty.Resize(cols, rows)
}

func (c *conptyChannel) Close() error {
	return c.cpty.Close()
}

// startLocalPty 启动本机壳并接好读循环。返回通道与阻塞到进程退出的 wait。
// 对应 TS 里 pty.spawn + onData + onExit 的装配。
func startLocalPty(exe string, cols, rows int, workDir string, onData func([]byte)) (Channel, func(), error) {
	ensureBundledConpty()
	if !winconpty.IsConPtyAvailable() {
		return nil, nil, errors.New("本机 Windows 不支持 ConPTY（需 Windows 10 1809 以上）")
	}
	// Start 的命令行原样交给 CreateProcess，带空格的路径要自己加引号。
	cmdLine := exe
	if strings.ContainsAny(exe, " \t") && !strings.HasPrefix(exe, "\"") {
		cmdLine = "\"" + exe + "\""
	}
	options := []winconpty.ConPtyOption{winconpty.ConPtyEnv(os.Environ())}
	if dir := localWorkDir(workDir); dir != "" {
		options = append(options, winconpty.ConPtyWorkDir(dir))
	}
	if cols > 0 && rows > 0 {
		options = append(options, winconpty.ConPtyDimensions(cols, rows))
	}
	cpty, err := winconpty.Start(cmdLine, options...)
	if err != nil {
		return nil, nil, err
	}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := cpty.Read(buf)
			if n > 0 {
				onData(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}()
	wait := func() {
		_, _ = cpty.Wait(context.Background())
	}
	return &conptyChannel{cpty: cpty}, wait, nil
}
