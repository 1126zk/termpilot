//go:build windows

package terminal

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/UserExistsError/conpty"
)

// Windows 本机 PTY：ConPTY（github.com/UserExistsError/conpty）。
// 用法：Start / Read / Write / Resize / Wait / Close。

type conptyChannel struct {
	cpty *conpty.ConPty
}

func (c *conptyChannel) Write(data []byte) error {
	// 对应 node-pty 在 Windows 的输入行为：裸 LF 转成 CRLF。
	// PSReadLine 只认 CR 提交命令行，直接写 \n 会挂在提示符上不执行。
	out := make([]byte, 0, len(data)+8)
	for i, b := range data {
		if b == '\n' && (i == 0 || data[i-1] != '\r') {
			out = append(out, '\r')
		}
		out = append(out, b)
	}
	_, err := c.cpty.Write(out)
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
func startLocalPty(exe string, cols, rows int, onData func([]byte)) (Channel, func(), error) {
	if !conpty.IsConPtyAvailable() {
		return nil, nil, errors.New("本机 Windows 不支持 ConPTY（需 Windows 10 1809 以上）")
	}
	// conpty.Start 的命令行原样交给 CreateProcess，带空格的路径要自己加引号。
	cmdLine := exe
	if strings.ContainsAny(exe, " \t") && !strings.HasPrefix(exe, "\"") {
		cmdLine = "\"" + exe + "\""
	}
	options := []conpty.ConPtyOption{conpty.ConPtyEnv(os.Environ())}
	if home, err := os.UserHomeDir(); err == nil {
		options = append(options, conpty.ConPtyWorkDir(home))
	}
	if cols > 0 && rows > 0 {
		options = append(options, conpty.ConPtyDimensions(cols, rows))
	}
	cpty, err := conpty.Start(cmdLine, options...)
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
