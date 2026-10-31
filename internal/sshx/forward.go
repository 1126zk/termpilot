package sshx

import (
	"fmt"
	"io"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"
)

const loopback = "127.0.0.1"

// key 一条映射的身份。同一方向同一个监听端口只能有一条。
func (r ForwardRule) key() string {
	return fmt.Sprintf("%s:%d", r.Type, r.ListenPort)
}

// activeForward 一条正在监听的映射。
type activeForward struct {
	rule   ForwardRule
	closer io.Closer
}

// openForward 在已经连好的 SSH 连接上开一条端口映射，连接期间随时可以调用。
// local 对应 ssh -L（本机 127.0.0.1 监听 → SSH 通道到远端 127.0.0.1:targetPort），
// remote 对应 ssh -R（远端 127.0.0.1 监听 → 回本机 127.0.0.1:targetPort）。
// 返回的 Closer 关掉就停止监听。
func openForward(client *ssh.Client, rule ForwardRule) (io.Closer, error) {
	addr := net.JoinHostPort(loopback, fmt.Sprintf("%d", rule.ListenPort))
	switch rule.Type {
	case ForwardLocal:
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("本机端口 %d 监听失败: %w", rule.ListenPort, err)
		}
		go serveLocal(client, listener, rule)
		return listener, nil
	case ForwardRemote:
		listener, err := client.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("服务器端口 %d 监听失败: %w", rule.ListenPort, err)
		}
		go serveRemote(listener, rule)
		return listener, nil
	}
	return nil, fmt.Errorf("未知的映射类型: %s", rule.Type)
}

// serveLocal ssh -L：本机来一条连接就用 SSH 通道打通到服务器上的目标端口，双向转发。
func serveLocal(client *ssh.Client, listener net.Listener, rule ForwardRule) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return // 监听被回收
		}
		go func() {
			target, err := client.Dial("tcp", net.JoinHostPort(loopback, fmt.Sprintf("%d", rule.TargetPort)))
			if err != nil {
				_ = conn.Close()
				return
			}
			proxyBidirectional(conn, target)
		}()
	}
}

// serveRemote ssh -R：远端 127.0.0.1 上有连接进来时，接回本机目标端口。
func serveRemote(listener net.Listener, rule ForwardRule) {
	for {
		channel, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			target, err := net.Dial("tcp", net.JoinHostPort(loopback, fmt.Sprintf("%d", rule.TargetPort)))
			if err != nil {
				_ = channel.Close()
				return
			}
			proxyBidirectional(channel, target)
		}()
	}
}

// proxyBidirectional 双向拷贝，任一方向结束就把两头都关掉。
func proxyBidirectional(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() {
		_ = a.Close()
		_ = b.Close()
	}
	go func() {
		_, _ = io.Copy(a, b)
		once.Do(closeBoth)
	}()
	go func() {
		_, _ = io.Copy(b, a)
		once.Do(closeBoth)
	}()
}
