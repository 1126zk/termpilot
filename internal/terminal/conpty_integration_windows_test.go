//go:build windows

package terminal

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// 手动集成测试：真实启动 ConPTY（cmd.exe）。默认跳过，
// 设置 TERMPILOT_CONPTY_IT=1 后运行：go test ./internal/terminal/ -run TestConPTYIntegration -v
func TestConPTYIntegration(t *testing.T) {
	if os.Getenv("TERMPILOT_CONPTY_IT") != "1" {
		t.Skip("手动集成测试：设置 TERMPILOT_CONPTY_IT=1 运行")
	}

	var mu sync.Mutex
	var out strings.Builder
	ch, wait, err := startLocalPty("cmd.exe", 80, 24, "", func(b []byte) {
		mu.Lock()
		out.Write(b)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("startLocalPty: %v", err)
	}
	defer ch.Close()

	waitOutput := func(substr string, timeout time.Duration) bool {
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			mu.Lock()
			found := strings.Contains(out.String(), substr)
			mu.Unlock()
			if found {
				return true
			}
			time.Sleep(50 * time.Millisecond)
		}
		return false
	}

	if err := ch.Write([]byte("echo TP_IT_OK\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !waitOutput("TP_IT_OK", 15*time.Second) {
		t.Fatal("15s 内没看到回显")
	}
	if err := ch.Resize(120, 40); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if err := ch.Write([]byte("exit\r\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	done := make(chan struct{})
	go func() { wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("进程未在 10s 内退出")
	}
}
