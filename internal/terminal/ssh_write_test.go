package terminal

import (
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"termpilot/internal/sshx"
)

// blockingWriter 按 hold 决定这次写入要不要停住。inside 大于 1 表示两次写叠在一起。
type blockingWriter struct {
	mu      sync.Mutex
	inside  int
	overlap bool
	hold    bool
	entered chan struct{}
	release chan struct{}
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.inside++
	if w.inside > 1 {
		w.overlap = true
	}
	hold := w.hold
	w.mu.Unlock()
	if hold {
		w.entered <- struct{}{}
		<-w.release
	}
	w.mu.Lock()
	w.inside--
	w.mu.Unlock()
	return len(p), nil
}

func TestShellChannelWriteDoesNotOverlap(t *testing.T) {
	w := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	channels := []interface{ Write([]byte) error }{
		&sshShellChannel{stdin: w},
		&jumpShellChannel{shell: &sshx.JumpShell{Stdin: w}},
	}
	for _, ch := range channels {
		w.mu.Lock()
		w.overlap = false
		w.hold = true
		w.inside = 0
		w.mu.Unlock()
		done := make(chan error, 2)
		go func() { done <- ch.Write([]byte("a")) }()
		<-w.entered
		w.mu.Lock()
		w.hold = false
		w.mu.Unlock()
		go func() { done <- ch.Write([]byte("b")) }()
		time.Sleep(40 * time.Millisecond)
		w.mu.Lock()
		overlap := w.overlap
		w.mu.Unlock()
		if overlap {
			t.Fatal("写入重入了")
		}
		w.release <- struct{}{}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestShellExited(t *testing.T) {
	if !shellExited(nil) {
		t.Fatal("正常退出应算 shell 自己结束")
	}
	if shellExited(&ssh.ExitMissingError{}) {
		t.Fatal("没有退出状态时不该抢断线报告")
	}
	if shellExited(errors.New("EOF")) {
		t.Fatal("连接错误不该算 shell 自己结束")
	}
}

func TestDisconnectText(t *testing.T) {
	if got := disconnectText(nil, false); got != "对方关闭了连接" {
		t.Fatalf("空错误: %q", got)
	}
	if got := disconnectText(io.EOF, false); got != "对方关闭了连接" {
		t.Fatalf("EOF: %q", got)
	}
	if got := disconnectText(errors.New("read tcp: EOF"), true); got != "保活无响应" {
		t.Fatalf("保活: %q", got)
	}
	if got := disconnectText(errors.New("ssh: disconnect, reason 2: unexpected bytes remain"), false); got != "数据包无效，服务器已断开" {
		t.Fatalf("坏包: %q", got)
	}
}

func TestFinishDownOnce(t *testing.T) {
	svc, _, em := newTestService()
	svc.sessions = nameSessions("七牛云香港")
	entry := addFakeTerm(svc, "term-1", KindSSH, &fakeChannel{})
	svc.finishDown(entry, 1, "conn-1", StatusDisconnected, "对方关闭了连接", io.EOF)
	svc.finishDown(entry, 1, "conn-1", StatusDisconnected, "服务器已断开", errors.New("ssh: disconnect, reason 11: bye"))
	if len(em.statuses()) != 1 || em.statuses()[0].Error != "对方关闭了连接" {
		t.Fatalf("状态 = %+v", em.statuses())
	}
	log := svc.ConnLog()
	if len(log) != 1 || log[0].Name != "七牛云香港" || log[0].TermID != "term-1" || log[0].Detail != "EOF" {
		t.Fatalf("日志 = %+v", log)
	}
}

type nameSessions string

func (n nameSessions) FindSession(id string) *sshx.SessionConfig {
	return &sshx.SessionConfig{ID: id, Name: string(n)}
}
func (n nameSessions) GetSecret(string) string        { return "" }
func (n nameSessions) GetJumpSecrets(string) []string { return nil }
