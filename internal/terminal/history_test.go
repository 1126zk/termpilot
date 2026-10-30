package terminal

import (
	"sync"
	"testing"
)

type fakeHistory struct {
	mu       sync.Mutex
	commands []string
	ret      bool
}

func (f *fakeHistory) AppendHistory(termID, command string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, command)
	return f.ret
}

type fakeEmitter struct {
	mu      sync.Mutex
	data    []DataEvent
	status  []StatusEvent
	meta    []MetaEvent
	history []string
}

func (f *fakeEmitter) TermData(e DataEvent) { f.mu.Lock(); f.data = append(f.data, e); f.mu.Unlock() }
func (f *fakeEmitter) TermStatus(e StatusEvent) {
	f.mu.Lock()
	f.status = append(f.status, e)
	f.mu.Unlock()
}
func (f *fakeEmitter) TermMeta(e MetaEvent) { f.mu.Lock(); f.meta = append(f.meta, e); f.mu.Unlock() }
func (f *fakeEmitter) HistoryChanged(termID string) {
	f.mu.Lock()
	f.history = append(f.history, termID)
	f.mu.Unlock()
}

func (f *fakeEmitter) statuses() []StatusEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]StatusEvent(nil), f.status...)
}

func newTestService() (*Service, *fakeHistory, *fakeEmitter) {
	hist := &fakeHistory{ret: true}
	em := &fakeEmitter{}
	return NewService(nil, hist, em, nil), hist, em
}

func TestCaptureInputSettlesOnEnter(t *testing.T) {
	svc, hist, em := newTestService()
	svc.Input("term-1", "ls -la\r")
	if len(hist.commands) != 1 || hist.commands[0] != "ls -la" {
		t.Fatalf("commands = %v", hist.commands)
	}
	if len(em.history) != 1 || em.history[0] != "term-1" {
		t.Fatalf("HistoryChanged = %v", em.history)
	}
}

func TestCaptureInputBackspace(t *testing.T) {
	svc, hist, _ := newTestService()
	svc.Input("term-1", "ab\x7fc\r")
	if len(hist.commands) != 1 || hist.commands[0] != "ac" {
		t.Fatalf("commands = %v", hist.commands)
	}
}

func TestCaptureInputCRLF(t *testing.T) {
	svc, hist, _ := newTestService()
	svc.Input("term-1", "ls\r\npwd\r\n")
	if len(hist.commands) != 2 || hist.commands[0] != "ls" || hist.commands[1] != "pwd" {
		t.Fatalf("commands = %v", hist.commands)
	}
}

func TestCaptureInputDropsDirtyLines(t *testing.T) {
	svc, hist, _ := newTestService()
	// 含方向键（ESC <0x20 之后的字符也会进 buf，但行已 dirty）
	svc.Input("term-1", "ls\x1b[A\r")
	// 括号粘贴换行：换行把行标脏
	svc.Input("term-1", "\x1b[200~ls\nla\x1b[201~\r")
	// strip 后少于 2 个字符
	svc.Input("term-1", "a\r")
	if len(hist.commands) != 0 {
		t.Fatalf("脏行/短行不应进历史，commands = %v", hist.commands)
	}
}

func TestCaptureInputFiltersFocusEvents(t *testing.T) {
	svc, hist, _ := newTestService()
	svc.Input("term-1", "\x1b[Ils\x1b[O\r")
	if len(hist.commands) != 1 || hist.commands[0] != "ls" {
		t.Fatalf("commands = %v", hist.commands)
	}
}

func TestCaptureInputHistoryRejectedNoEvent(t *testing.T) {
	svc, hist, em := newTestService()
	hist.ret = false // 比如与上一条重复，没写进去
	svc.Input("term-1", "ls\r")
	if len(hist.commands) != 1 {
		t.Fatalf("commands = %v", hist.commands)
	}
	if len(em.history) != 0 {
		t.Fatalf("没落库不该发 HistoryChanged: %v", em.history)
	}
}

func TestInputDisconnectedSkipsHistoryAndNotifiesOnce(t *testing.T) {
	svc, hist, em := newTestService()
	addFakeTerm(svc, "term-1", KindSSH, nil)
	svc.BindView("term-1")
	svc.sendStatus("term-1", "conn-1", StatusDisconnected, "")
	svc.Input("term-1", "ls\r")
	svc.Input("term-1", "pwd\r")
	if len(hist.commands) != 0 {
		t.Fatalf("断开输入不应进历史: %v", hist.commands)
	}
	if len(em.data) != 1 {
		t.Fatalf("重复输入只提示一次，data events = %d", len(em.data))
	}
	svc.sendStatus("term-1", "conn-1", StatusConnected, "")
	svc.sendStatus("term-1", "conn-1", StatusDisconnected, "")
	svc.Input("term-1", "pwd\r")
	if len(em.data) != 2 {
		t.Fatalf("重连后再次断开应重新提示，data events = %d", len(em.data))
	}
}
