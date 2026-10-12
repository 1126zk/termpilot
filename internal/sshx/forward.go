package sshx

import (
	"fmt"
	"io"
	"log"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Logf 转发失败的日志出口，默认打到标准日志；上层可替换。
var Logf = log.Printf

const loopback = "127.0.0.1"

// AttachForwards 把会话的端口映射挂到已经连好的共享 SSH 连接上，每条连接只挂一次。
// local 对应 ssh -L（本机 127.0.0.1 监听 → SSH 通道到远端 127.0.0.1:targetPort），
// remote 对应 ssh -R（远端 127.0.0.1 监听 → 回本机 127.0.0.1:targetPort）。
// 单条规则失败（端口被占等）只记日志，不影响其他规则和连接本身；
// 连接关闭时统一回收监听。
func AttachForwards(client *ssh.Client, rules []ForwardRule) {
	if len(rules) == 0 {
		return
	}
	var closers []io.Closer
	for _, rule := range rules {
		switch rule.Type {
		case ForwardLocal:
			listener, err := net.Listen("tcp", net.JoinHostPort(loopback, fmt.Sprintf("%d", rule.ListenPort)))
			if err != nil {
				Logf("[TermPilot] 端口映射监听失败 127.0.0.1:%d: %v", rule.ListenPort, err)
				continue
			}
			closers = append(closers, listener)
			go serveLocal(client, listener, rule)
		case ForwardRemote:
			listener, err := client.Listen("tcp", net.JoinHostPort(loopback, fmt.Sprintf("%d", rule.ListenPort)))
			if err != nil {
				Logf("[TermPilot] 远程转发失败 127.0.0.1:%d: %v", rule.ListenPort, err)
				continue
			}
			closers = append(closers, listener)
			go serveRemote(listener, rule)
		}
	}
	if len(closers) == 0 {
		return
	}
	go func() {
		_ = client.Conn.Wait()
		for _, closer := range closers {
			_ = closer.Close()
		}
	}()
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
