package sshx

import (
	"io"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

// 对应 ssh-config.ts 的 openProxyCommand：把 ProxyCommand 里的 %h/%p/%r 展开，
// 用本地 shell 起进程，把进程的 stdin/stdout 适配成 net.Conn 交给 SSH 握手。

var proxyTokenRe = regexp.MustCompile(`%[%hpnr]`)

// ExpandProxyCommand 展开 %h（主机）、%n（同 %h）、%p（端口，0 按 22）、%r（用户名）、%%（字面 %）。
func ExpandProxyCommand(command, host string, port int, username string) string {
	if port == 0 {
		port = 22
	}
	return proxyTokenRe.ReplaceAllStringFunc(command, func(token string) string {
		switch token {
		case "%%":
			return "%"
		case "%h", "%n":
			return host
		case "%p":
			return strconv.Itoa(port)
		case "%r":
			return username
		}
		return token
	})
}

// openProxyCommand 启动本地命令并返回它的管道连接。stderr 直接丢弃（与 TS 的 stdio ignore 一致）。
func openProxyCommand(command, host string, port int, username string) (net.Conn, error) {
	expanded := ExpandProxyCommand(command, host, port, username)
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", expanded)
	} else {
		cmd = exec.Command("sh", "-c", expanded)
	}
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &commandConn{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

// commandConn 把子进程的 stdin/stdout 包成 net.Conn。
// 进程管道没有截止时间的概念，SetDeadline 是 no-op——握手超时只对 TCP 直连生效。
type commandConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

func (c *commandConn) Read(p []byte) (int, error)  { return c.stdout.Read(p) }
func (c *commandConn) Write(p []byte) (int, error) { return c.stdin.Write(p) }

func (c *commandConn) Close() error {
	_ = c.stdin.Close()
	_ = c.stdout.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	_ = c.cmd.Wait()
	return nil
}

func (c *commandConn) LocalAddr() net.Addr              { return commandAddr("local") }
func (c *commandConn) RemoteAddr() net.Addr             { return commandAddr("proxycommand") }
func (c *commandConn) SetDeadline(time.Time) error      { return nil }
func (c *commandConn) SetReadDeadline(time.Time) error  { return nil }
func (c *commandConn) SetWriteDeadline(time.Time) error { return nil }

type commandAddr string

func (a commandAddr) Network() string { return "proxycommand" }
func (a commandAddr) String() string  { return string(a) }
