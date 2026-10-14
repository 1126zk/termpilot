package sshx

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestJumpHops(t *testing.T) {
	t.Run("无跳板", func(t *testing.T) {
		if hops := jumpHops(&SessionConfig{Host: "h", Username: "u"}, nil); len(hops) != 0 {
			t.Fatalf("hops = %+v", hops)
		}
	})
	t.Run("第一跳默认沿用会话用户名和 22 端口", func(t *testing.T) {
		hops := jumpHops(&SessionConfig{Jumps: []Hop{{Host: "bastion"}}, Username: "deploy"}, []string{"jsecret"})
		if len(hops) != 1 {
			t.Fatalf("hops = %+v", hops)
		}
		if hops[0].host != "bastion" || hops[0].port != 22 || hops[0].username != "deploy" || hops[0].password != "jsecret" {
			t.Fatalf("hop = %+v", hops[0])
		}
	})
	t.Run("jt_ 用户名把口令并进用户名", func(t *testing.T) {
		hops := jumpHops(&SessionConfig{Jumps: []Hop{{Host: "bastion", Username: "jt_ops"}}, Username: "deploy"}, []string{"jsecret"})
		if hops[0].username != "jt_ops:jsecret" || hops[0].password != "" {
			t.Fatalf("hop = %+v", hops[0])
		}
		// 口令为空或用户名已含冒号时不做合并
		hops = jumpHops(&SessionConfig{Jumps: []Hop{{Host: "bastion", Username: "jt_ops"}}, Username: "deploy"}, []string{""})
		if hops[0].username != "jt_ops" || hops[0].password != "" {
			t.Fatalf("hop = %+v", hops[0])
		}
		hops = jumpHops(&SessionConfig{Jumps: []Hop{{Host: "bastion", Username: "jt_ops:tok"}}, Username: "deploy"}, []string{"jsecret"})
		if hops[0].username != "jt_ops:tok" || hops[0].password != "jsecret" {
			t.Fatalf("hop = %+v", hops[0])
		}
	})
	t.Run("多跳按顺序使用各自密码", func(t *testing.T) {
		hops := jumpHops(&SessionConfig{
			Jumps: []Hop{
				{Host: "j1"},
				{Host: "j2", Port: 2200, Username: "ops"},
				{Host: "  ", Port: 22},
				{Host: "j3"},
			},
			Username: "deploy",
		}, []string{"one", "two", "ignored", "four"})
		if len(hops) != 3 {
			t.Fatalf("hops = %+v", hops)
		}
		if hops[0].password != "one" || hops[1].password != "two" || hops[2].password != "four" {
			t.Fatalf("密码顺序不对: %+v", hops)
		}
		if hops[1].host != "j2" || hops[1].port != 2200 || hops[1].username != "ops" {
			t.Fatalf("hop2 = %+v", hops[1])
		}
		if hops[2].host != "j3" || hops[2].port != 22 || hops[2].username != "deploy" {
			t.Fatalf("hop3 = %+v", hops[2])
		}
	})
}

func TestJumpSSHCommand(t *testing.T) {
	got := jumpSSHCommand(&SessionConfig{Host: "example.com", Port: 22, Username: "deploy"})
	want := "ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o NumberOfPasswordPrompts=1 deploy@example.com\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	got = jumpSSHCommand(&SessionConfig{Host: "example.com", Port: 2200, Username: "deploy"})
	if !strings.Contains(got, " -p 2200 ") {
		t.Fatalf("got %q", got)
	}
	// IPv6 地址加方括号
	got = jumpSSHCommand(&SessionConfig{Host: "2001:db8::1", Port: 22, Username: "u"})
	if !strings.Contains(got, "u@[2001:db8::1]\n") {
		t.Fatalf("got %q", got)
	}
	// 已经带括号的不重复加
	got = jumpSSHCommand(&SessionConfig{Host: "[2001:db8::1]", Port: 22, Username: "u"})
	if !strings.Contains(got, "u@[2001:db8::1]\n") {
		t.Fatalf("got %q", got)
	}
}

func TestStripControls(t *testing.T) {
	if got := stripControls("\x1b[1;32muser@host\x1b[0m $ "); got != "user@host $ " {
		t.Fatalf("got %q", got)
	}
	if got := stripControls("\x1b]0;title\x07rest"); got != "rest" {
		t.Fatalf("got %q", got)
	}
	if got := stripControls("\x1b]0;title\x1b\\rest"); got != "rest" {
		t.Fatalf("got %q", got)
	}
}

type recordingWriter struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (w *recordingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *recordingWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestLoginAnswerer(t *testing.T) {
	t.Run("看到提示符后发出 ssh 命令", func(t *testing.T) {
		w := &recordingWriter{}
		a := newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "secret")
		a.Write([]byte("Last login: ...\r\nroot@jump:~# "))
		if !strings.Contains(w.String(), "ssh -tt") {
			t.Fatalf("应发出 ssh 命令，写入: %q", w.String())
		}
		// 第二次看到提示符不重复发
		a.Write([]byte("root@jump:~# "))
		if strings.Count(w.String(), "ssh -tt") != 1 {
			t.Fatalf("命令重复发出: %q", w.String())
		}
	})
	t.Run("看到密码提示送一次密码", func(t *testing.T) {
		w := &recordingWriter{}
		a := newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "s3cret")
		a.Write([]byte("deploy@h's password: "))
		a.Write([]byte("deploy@h's password: "))
		if got := strings.Count(w.String(), "s3cret\n"); got != 1 {
			t.Fatalf("密码应只送一次，写入: %q", w.String())
		}
	})
	t.Run("中文密码提示也认", func(t *testing.T) {
		w := &recordingWriter{}
		a := newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "pw")
		a.Write([]byte("密码："))
		if !strings.Contains(w.String(), "pw\n") {
			t.Fatalf("写入: %q", w.String())
		}
	})
	t.Run("确认主机密钥答 yes", func(t *testing.T) {
		w := &recordingWriter{}
		a := newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "pw")
		a.Write([]byte("Are you sure you want to continue connecting (yes/no/[fingerprint])?"))
		if !strings.Contains(w.String(), "yes\n") {
			t.Fatalf("写入: %q", w.String())
		}
	})
	t.Run("没有密码时看到密码提示不送", func(t *testing.T) {
		w := &recordingWriter{}
		a := newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "")
		a.Write([]byte("password: "))
		if w.String() != "" {
			t.Fatalf("写入: %q", w.String())
		}
	})
	t.Run("1.2 秒无提示符主动发命令", func(t *testing.T) {
		w := &recordingWriter{}
		newLoginAnswerer(w, &SessionConfig{Host: "h", Username: "u"}, "pw")
		time.Sleep(1500 * time.Millisecond)
		if !strings.Contains(w.String(), "ssh -tt") {
			t.Fatalf("超时后应主动发命令，写入: %q", w.String())
		}
	})
}

func TestApplyDialOptionsTimeout(t *testing.T) {
	zero := 0
	cfg := targetConfig(&SessionConfig{Username: "u", Options: &ConnectOptions{ReadyTimeoutMs: &zero}}, "")
	if cfg.Timeout != 120000000000 { // 120s
		t.Fatalf("readyTimeoutMs=0 应改成 120s，得到 %v", cfg.Timeout)
	}
	five := 5000
	cfg = targetConfig(&SessionConfig{Username: "u", Options: &ConnectOptions{ReadyTimeoutMs: &five}}, "")
	if cfg.Timeout.Milliseconds() != 5000 {
		t.Fatalf("got %v", cfg.Timeout)
	}
	cfg = targetConfig(&SessionConfig{Username: "u"}, "")
	if cfg.Timeout.Milliseconds() != 15000 {
		t.Fatalf("默认应为 15s，得到 %v", cfg.Timeout)
	}
}
