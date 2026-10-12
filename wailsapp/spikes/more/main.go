// 补充验证：远程转发（ssh -R）、ProxyCommand、跳板禁转发回退。
// 依赖 Docker 容器：tp-ssh-target(172.18.0.2:2222)、tp-ssh-jump(127.0.0.1:2223)、
// tp-ssh-strict(127.0.0.1:2224，AllowTcpForwarding no)，账号 testuser/testpass123。
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"time"

	"termpilot/app/internal/sshx"
	"termpilot/app/internal/terminal"
)

const (
	user = "testuser"
	pass = "testpass123"
)

var failures int

func check(name string, ok bool, detail string) {
	if ok {
		fmt.Println("PASS", name)
	} else {
		fmt.Printf("FAIL %s: %s\n", name, detail)
		failures++
	}
}

func main() {
	// ------------------------------------------------ 1. 远程转发（ssh -R）
	// 本机 127.0.0.1:12345 起一个 echo 服务；会话挂 remote 规则让服务器 127.0.0.1:12296 监听；
	// 从容器里 nc 12296 应打通回本机 echo 服务。
	echoLn, err := net.Listen("tcp", "127.0.0.1:12345")
	if err != nil {
		fmt.Println("echo listener fail:", err)
		os.Exit(1)
	}
	defer echoLn.Close()
	go func() {
		for {
			c, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()

	pool := sshx.NewPool()
	rSession := &sshx.SessionConfig{
		ID: "rfwd", Host: "127.0.0.1", Port: 2222, Username: user,
		Forwards: []sshx.ForwardRule{{Type: sshx.ForwardRemote, ListenPort: 12296, TargetPort: 12345}},
	}
	hold, err := pool.Acquire(context.Background(), rSession, pass, "")
	if err != nil {
		check("远程转发(-R)", false, "acquire: "+err.Error())
	} else {
		defer hold.Release()
		time.Sleep(300 * time.Millisecond)
		out, err := exec.Command("docker", "exec", "tp-ssh-target",
			"sh", "-c", "echo REMOTE_OK | nc -w 5 127.0.0.1 12296").CombinedOutput()
		check("远程转发(-R)", err == nil && string(out) == "REMOTE_OK\n", fmt.Sprintf("err=%v out=%.60s", err, out))
	}

	// ------------------------------------------------ 2. ProxyCommand
	// 不走 TCP 直连：本地起 `docker exec -i tp-ssh-target nc %h %p` 当传输。
	pSession := &sshx.SessionConfig{
		ID: "pxy", Host: "localhost", Port: 2222, Username: user,
		Options: &sshx.ConnectOptions{ProxyCommand: "docker exec -i tp-ssh-target nc %h %p"},
	}
	termSvc := terminal.NewService(staticSessions{"pxy": pSession}, nil, nil, pool)
	termSvc.Create(terminal.CreateOptions{TermID: "term-pxy", Kind: terminal.KindSSH, SessionID: "pxy", Cols: 80, Rows: 24})
	time.Sleep(2 * time.Second)
	termSvc.Input("term-pxy", "echo PXY_OK_$((30+12))\r\n")
	check("ProxyCommand 终端", pollTail(termSvc, "term-pxy", "PXY_OK_42", 15*time.Second), "")
	termSvc.Close("term-pxy")

	// ------------------------------------------------ 3. 跳板禁转发回退
	// 跳板 tp-ssh-strict 禁止转发，终端应回退成「跳板 shell 里再 ssh + 自动应答密码」。
	jSession := &sshx.SessionConfig{
		ID: "jfb", Host: "172.18.0.2", Port: 2222, Username: user,
		JumpHost: "127.0.0.1", JumpPort: 2224, JumpUsername: user,
	}
	termSvc2 := terminal.NewService(staticSessions{"jfb": jSession}, nil, nil, pool)
	termSvc2.Create(terminal.CreateOptions{TermID: "term-jfb", Kind: terminal.KindSSH, SessionID: "jfb", Cols: 80, Rows: 24})
	time.Sleep(3 * time.Second)
	termSvc2.Input("term-jfb", "echo FALLBACK_OK_$((21*2))\r\n")
	check("跳板禁转发回退", pollTail(termSvc2, "term-jfb", "FALLBACK_OK_42", 25*time.Second), "")
	termSvc2.Close("term-jfb")

	if failures == 0 {
		fmt.Println("MORE_RESULT: PASS")
	} else {
		fmt.Printf("MORE_RESULT: FAIL (%d 项)\n", failures)
		os.Exit(1)
	}
}

type staticSessions map[string]*sshx.SessionConfig

func (s staticSessions) FindSession(id string) *sshx.SessionConfig { return s[id] }
func (s staticSessions) GetSecret(string) string                   { return pass }
func (s staticSessions) GetJumpSecret(string) string               { return pass }

func pollTail(svc *terminal.Service, termID, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tail, err := svc.ReadTail(termID, 4000)
		if err == nil && contains(tail, want) {
			return true
		}
		time.Sleep(400 * time.Millisecond)
	}
	return false
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
