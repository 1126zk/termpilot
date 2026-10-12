// 端口转发最小复现：对 Docker sshd（127.0.0.1:2222，testuser/testpass123）
// 拨号 → 挂 local 转发 127.0.0.1:12298 → 2222 → 本机 Dial 读 banner。
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"time"

	"termpilot/app/internal/sshx"
)

func main() {
	session := &sshx.SessionConfig{
		ID: "fwd-test", Host: "127.0.0.1", Port: 2222, Username: "testuser",
		Forwards: []sshx.ForwardRule{{Type: sshx.ForwardLocal, ListenPort: 12298, TargetPort: 2222}},
	}
	pool := sshx.NewPool()
	hold, err := pool.Acquire(context.Background(), session, "testpass123", "")
	if err != nil {
		fmt.Println("DIAL FAIL:", err)
		os.Exit(1)
	}
	defer hold.Release()
	fmt.Println("ssh connected, forwards attached")

	// 直接打一条 direct-tcpip 通道，看服务端到底报什么
	ch, chErr := hold.Conn.Client.Dial("tcp", "127.0.0.1:2222")
	if chErr != nil {
		fmt.Println("DIRECT-TCPIP FAIL:", chErr)
	} else {
		_ = ch.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 64)
		n, rerr := ch.Read(buf)
		fmt.Printf("direct-tcpip banner=%q readErr=%v\n", string(buf[:n]), rerr)
		ch.Close()
	}

	time.Sleep(300 * time.Millisecond)
	conn, err := net.DialTimeout("tcp", "127.0.0.1:12298", 5*time.Second)
	if err != nil {
		fmt.Println("LOCAL DIAL FAIL:", err)
		os.Exit(1)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 64)
	n, rerr := conn.Read(buf)
	fmt.Printf("banner=%q readErr=%v\n", string(buf[:n]), rerr)
	if n > 0 {
		fmt.Println("FORWARD_RESULT: PASS")
	} else {
		fmt.Println("FORWARD_RESULT: FAIL")
		os.Exit(1)
	}
}
