package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"termpilot/app/internal/sshx"
	"termpilot/app/internal/storage"
	"termpilot/app/internal/terminal"
)

// TERMPILOT_SMOKE=3 时的 SSH 端到端验收：对真实 sshd（Docker 容器）验证
// 直连终端、exec、SFTP、本地端口转发、跳板链五条链路。
// 环境变量：TERMPILOT_SSH_PORT（直连端口）、TERMPILOT_SSH_TARGET_IP（容器内 IP）、
// TERMPILOT_SSH_JUMP_PORT（跳板端口）；账号固定 testuser/testpass123。
func (a *App) runSmoke3() {
	log := func(format string, args ...interface{}) {
		line := fmt.Sprintf(format+"\n", args...)
		f, err := os.OpenFile(filepath.Join(a.userData, "smoke.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.WriteString(line)
			_ = f.Close()
		}
	}
	pass := "testpass123"
	user := "testuser"
	directPort := atoi(os.Getenv("TERMPILOT_SSH_PORT"), 2222)
	jumpPort := atoi(os.Getenv("TERMPILOT_SSH_JUMP_PORT"), 2223)
	targetIP := os.Getenv("TERMPILOT_SSH_TARGET_IP")

	failures := 0
	check := func(name string, ok bool, detail string) {
		if ok {
			log("PASS %s", name)
		} else {
			log("FAIL %s: %s", name, detail)
			failures++
		}
	}

	time.Sleep(2 * time.Second)

	// ---------------------------------------------------------- 1. 直连终端
	direct, err := a.store.Create(&storage.SessionInput{
		Name: "smoke-direct", Host: "127.0.0.1", Port: directPort, Username: user, Secret: &pass,
	})
	if err != nil {
		log("SMOKE3_RESULT: FAIL (建会话: %v)", err)
		os.Exit(1)
	}
	termID := "term-smoke3a"
	a.terminal.Create(terminal.CreateOptions{TermID: termID, Kind: terminal.KindSSH, SessionID: direct.ID, Cols: 80, Rows: 24})
	time.Sleep(1500 * time.Millisecond)
	a.terminal.Input(termID, "echo TERM_OK_$((40+2))\r\n")
	check("直连终端 echo", pollTail(a, termID, "TERM_OK_42", 15*time.Second), "")

	// ---------------------------------------------------------- 2. exec 通道
	execRes, execErr := a.exec.Exec(direct.ID, sshx.ExecOptions{Command: "echo EXEC_OK_$((6*7))", TimeoutMs: 15000})
	stdout := ""
	if execRes != nil {
		stdout = execRes.Stdout
	}
	check("exec 通道", execErr == nil && execRes != nil && strings.Contains(execRes.Stdout, "EXEC_OK_42") && execRes.ExitCode != nil && *execRes.ExitCode == 0,
		fmt.Sprintf("err=%v stdout=%.80s", execErr, stdout))

	// ---------------------------------------------------------- 3. SFTP
	_, entries, err := a.sftp.List(direct.ID, "/")
	check("sftp list /", err == nil && len(entries) > 0, fmt.Sprintf("err=%v", err))
	localFile := filepath.Join(a.userData, "smoke-upload.txt")
	_ = os.WriteFile(localFile, []byte("smoke-sftp-roundtrip-42"), 0o644)
	err = a.sftp.Put(direct.ID, localFile, "/config/smoke-upload.txt")
	check("sftp 上传", err == nil, fmt.Sprintf("err=%v", err))
	back, err := a.sftp.ReadText(direct.ID, "/config/smoke-upload.txt")
	check("sftp 读回", err == nil && strings.Contains(back, "smoke-sftp-roundtrip-42"), fmt.Sprintf("err=%v back=%.40s", err, back))
	_ = a.sftp.Remove(direct.ID, "/config/smoke-upload.txt", "file")

	// ---------------------------------------------------------- 4. 本地端口转发
	fwdSession, err := a.store.Create(&storage.SessionInput{
		Name: "smoke-forward", Host: "127.0.0.1", Port: directPort, Username: user, Secret: &pass,
		Forwards: &[]storage.ForwardRule{{Type: "local", ListenPort: 12299, TargetPort: 2222}},
	})
	if err != nil {
		check("本地端口转发", false, fmt.Sprintf("建会话: %v", err))
	} else {
		hold, err := a.acquire(fwdSession.ID)
		if err != nil {
			check("本地端口转发", false, fmt.Sprintf("acquire: %v", err))
		} else {
			defer hold.Release()
			banner := ""
			var readErr error
			conn, err := net.DialTimeout("tcp", "127.0.0.1:12299", 5*time.Second)
			if err == nil {
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				buf := make([]byte, 64)
				var n int
				n, readErr = conn.Read(buf)
				banner = string(buf[:n])
				conn.Close()
			}
			check("本地端口转发", strings.Contains(banner, "SSH-2.0"), fmt.Sprintf("dialErr=%v readErr=%v banner=%.40s", err, readErr, banner))
		}
	}

	// ---------------------------------------------------------- 5. 跳板链
	if targetIP == "" {
		check("跳板链", false, "TERMPILOT_SSH_TARGET_IP 未设置")
	} else {
		jumpSecret := pass
		jumpUser := user
		jumpHost := "127.0.0.1"
		jumped, err := a.store.Create(&storage.SessionInput{
			Name: "smoke-jump", Host: targetIP, Port: 2222, Username: user, Secret: &pass,
			JumpHost: &jumpHost, JumpPort: &jumpPort, JumpUsername: &jumpUser, JumpSecret: &jumpSecret,
		})
		if err != nil {
			check("跳板链", false, fmt.Sprintf("建会话: %v", err))
		} else {
			termJ := "term-smoke3j"
			a.terminal.Create(terminal.CreateOptions{TermID: termJ, Kind: terminal.KindSSH, SessionID: jumped.ID, Cols: 80, Rows: 24})
			time.Sleep(1500 * time.Millisecond)
			a.terminal.Input(termJ, "echo JUMP_OK_$((20+22))\r\n")
			check("跳板链 echo", pollTail(a, termJ, "JUMP_OK_42", 20*time.Second), "")
			a.terminal.Close(termJ)
		}
	}

	a.terminal.Close(termID)
	if failures == 0 {
		log("SMOKE3_RESULT: PASS")
		os.Exit(0)
	}
	log("SMOKE3_RESULT: FAIL (%d 项)", failures)
	os.Exit(1)
}

func pollTail(a *App, termID, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tail, err := a.terminal.ReadTail(termID, 4000)
		if err == nil && contains(tail, want) {
			return true
		}
		time.Sleep(400 * time.Millisecond)
	}
	return false
}

func atoi(v string, fallback int) int {
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return fallback
	}
	return n
}
