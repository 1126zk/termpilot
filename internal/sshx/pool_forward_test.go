package sshx

import (
	"net"
	"testing"

	"golang.org/x/crypto/ssh"
)

// 标签全关时 StopAllForwards 要停掉这台服务器的所有映射、放开本机端口，别的服务器不受影响。
func TestStopAllForwards(t *testing.T) {
	p := NewPool()
	listen := func() net.Listener {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	a1, a2, b1 := listen(), listen(), listen()
	defer b1.Close()

	slot := func(ls ...net.Listener) *poolSlot {
		s := &poolSlot{conn: &Conn{Client: &ssh.Client{}}, refs: 1, ready: make(chan struct{}), forwards: map[string]*activeForward{}}
		for _, l := range ls {
			rule := ForwardRule{Type: ForwardLocal, ListenPort: l.Addr().(*net.TCPAddr).Port, TargetPort: 80}
			s.forwards[rule.key()] = &activeForward{rule: rule, closer: l}
		}
		return s
	}
	p.slots["a"] = slot(a1, a2)
	p.slots["b"] = slot(b1)

	p.StopAllForwards("a")

	if got := p.ActiveForwards("a"); len(got) != 0 {
		t.Fatalf("a 还有映射: %v", got)
	}
	if got := p.ActiveForwards("b"); len(got) != 1 {
		t.Fatalf("b 的映射被误停: %v", got)
	}
	for _, l := range []net.Listener{a1, a2} {
		if _, err := l.Accept(); err == nil {
			t.Fatalf("%s 还在监听", l.Addr())
		}
	}
	// 没连着的会话调用也不出错
	p.StopAllForwards("missing")
}
