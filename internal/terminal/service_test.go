package terminal

import (
	"encoding/base64"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"termpilot/internal/sshx"
)

// fakeChannel 测试用通道：写入时触发 onWrite（模拟远端回显/输出）。
type fakeChannel struct {
	mu      sync.Mutex
	written []byte
	onWrite func([]byte)
	resized [][2]int
	closed  bool
}

func (f *fakeChannel) Write(b []byte) error {
	f.mu.Lock()
	f.written = append(f.written, b...)
	cb := f.onWrite
	f.mu.Unlock()
	if cb != nil {
		cb(b)
	}
	return nil
}

func (f *fakeChannel) Resize(cols, rows int) error {
	f.mu.Lock()
	f.resized = append(f.resized, [2]int{cols, rows})
	f.mu.Unlock()
	return nil
}

func (f *fakeChannel) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}

func (f *fakeChannel) input() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.written)
}

// addFakeTerm 直接往服务里塞一扇带假通道的终端，绕过拨号。
func addFakeTerm(svc *Service, termID string, kind Kind, ch Channel) *Entry {
	entry := &Entry{id: termID, kind: kind, title: "PowerShell (1)", liveGen: 1, ch: ch}
	if kind == KindSSH {
		entry.sessionID = "conn-1"
	}
	svc.mu.Lock()
	svc.terms[termID] = entry
	svc.mu.Unlock()
	return entry
}

var execMarkerRe = regexp.MustCompile(`__TP_DONE_\w+__`)

func TestExecCommandPosixProbe(t *testing.T) {
	svc, _, _ := newTestService()
	ch := &fakeChannel{}
	addFakeTerm(svc, "term-1", KindSSH, ch)
	svc.sendData("term-1", []byte("user@host:~$ "))

	ch.onWrite = func(b []byte) {
		marker := execMarkerRe.FindString(string(b))
		go func() {
			time.Sleep(50 * time.Millisecond)
			svc.sendData("term-1", []byte(string(b)))
			svc.sendData("term-1", []byte("total 42\r\n"))
			if marker != "" {
				svc.sendData("term-1", []byte(marker+"0\n"))
			}
			svc.sendData("term-1", []byte("user@host:~$ "))
		}()
	}

	res, err := svc.ExecCommand("term-1", "ls -la", 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Finished {
		t.Error("finished = false")
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Errorf("exitCode = %v, want 0", res.ExitCode)
	}
	if !strings.Contains(res.Output, "total 42") {
		t.Errorf("output 缺命令输出: %q", res.Output)
	}
	if strings.Contains(res.Output, "__TP_DONE_") {
		t.Errorf("output 应剔掉 marker 行: %q", res.Output)
	}
	// 探针真实写进了终端
	if !strings.Contains(ch.input(), "printf '__TP_DONE_") {
		t.Errorf("写入里缺退出码探针: %q", ch.input())
	}
}

func TestExecCommandPromptOnly(t *testing.T) {
	// 本机 Windows PowerShell 没有退出码探针（在 windows 上 kind=local 即非 posix），
	// 只靠提示符回归。测试强制本机语义。
	svc, _, _ := newTestService()
	ch := &fakeChannel{}
	addFakeTerm(svc, "term-1", KindLocal, ch)
	svc.sendData("term-1", []byte(`PS C:\Users\x> `))

	ch.onWrite = func(b []byte) {
		go func() {
			time.Sleep(50 * time.Millisecond)
			svc.sendData("term-1", []byte(string(b)+"\r\n"))
			svc.sendData("term-1", []byte("hi\r\n"))
			svc.sendData("term-1", []byte(`PS C:\Users\x> `))
		}()
	}

	start := time.Now()
	res, err := svc.ExecCommand("term-1", "echo hi", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Finished {
		t.Errorf("finished = false（耗时 %v）", time.Since(start))
	}
	// POSIX 探针只在 kind=ssh 或非 Windows 平台启用
	svc.mu.Lock()
	kind := svc.terms["term-1"].kind
	svc.mu.Unlock()
	if kind == KindLocal && res.ExitCode != nil {
		// 本机无探针时拿不到退出码
		t.Errorf("exitCode = %v, want nil", *res.ExitCode)
	}
	if !strings.Contains(res.Output, "hi") {
		t.Errorf("output 缺命令输出: %q", res.Output)
	}
}

func TestExecCommandDisconnected(t *testing.T) {
	svc, _, _ := newTestService()
	if _, err := svc.ExecCommand("term-x", "ls", time.Second); err == nil {
		t.Fatal("断开终端应报错")
	}
	entry := addFakeTerm(svc, "term-1", KindSSH, nil)
	_ = entry
	if _, err := svc.ExecCommand("term-1", "ls", time.Second); err == nil {
		t.Fatal("无通道终端应报错")
	}
}

func TestExecCommandTimeout(t *testing.T) {
	svc, _, _ := newTestService()
	ch := &fakeChannel{} // 远端不回任何提示符
	addFakeTerm(svc, "term-1", KindLocal, ch)
	start := time.Now()
	res, err := svc.ExecCommand("term-1", "sleep 99", 700*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if res.Finished {
		t.Error("超时前不应 finished")
	}
	if elapsed := time.Since(start); elapsed < 600*time.Millisecond {
		t.Errorf("返回太早: %v", elapsed)
	}
}

func TestSendDataAndBindView(t *testing.T) {
	svc, _, em := newTestService()
	addFakeTerm(svc, "term-1", KindSSH, &fakeChannel{})

	svc.sendData("term-1", []byte("early output\r\n"))
	if len(em.data) != 0 {
		t.Fatal("视图未订阅前不该下发增量数据")
	}
	svc.BindView("term-1")
	if len(em.data) != 1 {
		t.Fatalf("BindView 应补发一次积压, got %d 条", len(em.data))
	}
	raw, err := base64.StdEncoding.DecodeString(em.data[0].Data)
	if err != nil || string(raw) != "early output\r\n" {
		t.Fatalf("补发数据 = %q, err=%v", raw, err)
	}
	if em.data[0].TermID != "term-1" {
		t.Fatalf("termId = %q", em.data[0].TermID)
	}

	svc.sendData("term-1", []byte("next"))
	if len(em.data) != 2 {
		t.Fatalf("订阅后应下发增量, got %d 条", len(em.data))
	}
	raw, _ = base64.StdEncoding.DecodeString(em.data[1].Data)
	if string(raw) != "next" {
		t.Fatalf("增量数据 = %q", raw)
	}

	svc.BindView("term-1") // 第二次不再补发
	if len(em.data) != 2 {
		t.Fatalf("重复 BindView 不应再补发, got %d 条", len(em.data))
	}
}

func TestReadTailAndCwdOf(t *testing.T) {
	svc, _, _ := newTestService()
	addFakeTerm(svc, "term-1", KindSSH, &fakeChannel{})
	if _, err := svc.ReadTail("term-x", 10); err == nil {
		t.Error("不存在的终端 ReadTail 应报错")
	}
	svc.sendData("term-1", []byte("line1\r\nline2\r\nuser@host:/srv/www$ "))
	tail, err := svc.ReadTail("term-1", 8)
	if err != nil {
		t.Fatal(err)
	}
	if tail != "rv/www$ " {
		t.Errorf("tail = %q, want 末尾 8 个字符", tail)
	}
	if cwd := svc.CwdOf("term-1"); cwd != "/srv/www" {
		t.Errorf("CwdOf = %q, want /srv/www", cwd)
	}
	if cwd := svc.CwdOf("term-x"); cwd != "" {
		t.Errorf("不存在的终端 CwdOf 应返回空, got %q", cwd)
	}
}

func TestSetLabel(t *testing.T) {
	svc, _, em := newTestService()
	addFakeTerm(svc, "term-1", KindSSH, &fakeChannel{})
	title := strings.Repeat("长", 100)
	remark := "  跑部署  "
	svc.SetLabel("term-1", LabelPatch{Title: &title, Remark: &remark})
	svc.mu.Lock()
	entry := svc.terms["term-1"]
	svc.mu.Unlock()
	if got := len([]rune(entry.title)); got != 80 {
		t.Errorf("标题应裁到 80 字符, got %d", got)
	}
	if entry.remark != "跑部署" {
		t.Errorf("remark = %q", entry.remark)
	}
	if len(em.meta) != 1 || em.meta[0].Title != entry.title {
		t.Fatalf("meta 事件 = %+v", em.meta)
	}
	// 空标题保留旧值
	empty := "   "
	svc.SetLabel("term-1", LabelPatch{Title: &empty})
	if svc.terms["term-1"].title != entry.title {
		t.Error("空标题不应覆盖旧标题")
	}
}

func TestResize(t *testing.T) {
	svc, _, _ := newTestService()
	ch := &fakeChannel{}
	addFakeTerm(svc, "term-1", KindSSH, ch)
	svc.Resize("term-1", 120, 40)
	svc.Resize("term-1", 0, 40)  // 非法尺寸忽略
	svc.Resize("term-x", 80, 24) // 不存在忽略
	if len(ch.resized) != 1 || ch.resized[0] != [2]int{120, 40} {
		t.Fatalf("resized = %v", ch.resized)
	}
}

func TestReconnectGuards(t *testing.T) {
	svc, _, _ := newTestService()
	if err := svc.Reconnect("term-x"); err == nil {
		t.Error("不存在的终端应报错")
	}
	addFakeTerm(svc, "term-1", KindLocal, nil)
	if err := svc.Reconnect("term-1"); err == nil || !strings.Contains(err.Error(), "本机终端") {
		t.Errorf("本机终端应提示不可重连: %v", err)
	}
	svc2 := NewService(&fakeSessions{}, nil, nil, nil)
	entry := addFakeTerm(svc2, "term-2", KindSSH, nil)
	entry.sessionID = "conn-missing"
	if err := svc2.Reconnect("term-2"); err == nil || !strings.Contains(err.Error(), "已经删除") {
		t.Errorf("已删除会话应报错: %v", err)
	}
}

func TestWaitStatus(t *testing.T) {
	svc, _, _ := newTestService()
	go func() {
		time.Sleep(50 * time.Millisecond)
		svc.sendStatus("term-1", "conn-1", StatusConnected, "")
	}()
	if err := svc.WaitStatus("term-1", 2*time.Second); err != nil {
		t.Fatal(err)
	}
	// 已 connected 直接返回
	if err := svc.WaitStatus("term-1", time.Second); err != nil {
		t.Fatal(err)
	}
	// error 状态立即失败
	svc.sendStatus("term-2", "", StatusError, "认证失败：用户名或密码不对")
	if err := svc.WaitStatus("term-2", time.Second); err == nil || err.Error() != "认证失败：用户名或密码不对" {
		t.Errorf("err = %v", err)
	}
	// 超时
	if err := svc.WaitStatus("term-3", 150*time.Millisecond); err == nil || err.Error() != "连接超时" {
		t.Errorf("err = %v", err)
	}
}

func TestExpectBindMarkBound(t *testing.T) {
	svc, _, _ := newTestService()
	done := make(chan error, 1)
	go func() { done <- svc.ExpectBind("term-1", 2*time.Second) }()
	time.Sleep(50 * time.Millisecond)
	svc.MarkBound("term-1")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// 没人绑定 → 超时
	if err := svc.ExpectBind("term-2", 100*time.Millisecond); err == nil {
		t.Error("应超时")
	}
}

func TestCloseCleansUp(t *testing.T) {
	svc, _, _ := newTestService()
	ch := &fakeChannel{}
	addFakeTerm(svc, "term-1", KindSSH, ch)
	svc.sendData("term-1", []byte("x"))
	svc.Close("term-1")
	if !ch.closed {
		t.Error("通道应被关闭")
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if len(svc.terms) != 0 || len(svc.output) != 0 || len(svc.lastStatus) != 0 || len(svc.viewReady) != 0 || len(svc.lines) != 0 {
		t.Error("Close 应清空该终端的所有状态")
	}
}

func TestListTerms(t *testing.T) {
	svc, _, _ := newTestService()
	addFakeTerm(svc, "term-b", KindSSH, &fakeChannel{})
	addFakeTerm(svc, "term-a", KindLocal, &fakeChannel{})
	svc.sendStatus("term-b", "conn-1", StatusConnected, "")
	infos := svc.ListTerms()
	if len(infos) != 2 || infos[0].ID != "term-a" || infos[1].ID != "term-b" {
		t.Fatalf("ListTerms 排序/数量错误: %+v", infos)
	}
	if infos[0].SessionID != nil {
		t.Error("本机终端 sessionId 应为 nil")
	}
	if infos[1].SessionID == nil || *infos[1].SessionID != "conn-1" {
		t.Errorf("SSH 终端 sessionId 错误: %+v", infos[1].SessionID)
	}
	if infos[1].Status != "connected" || infos[0].Status != "unknown" {
		t.Errorf("status 错误: %+v", infos)
	}
}

func TestFriendlyConnectError(t *testing.T) {
	cases := map[string]string{
		"All configured authentication methods failed": "认证失败：用户名或密码不对",
		"ssh: unable to authenticate":                  "认证失败：用户名或密码不对",
		"dial tcp: lookup x: ENOTFOUND":                "找不到主机：检查地址或网络",
		"dial tcp 1.2.3.4:22: ECONNREFUSED":            "连接被拒绝：目标端口没有开放",
		"read: ETIMEDOUT":                              "连接超时",
		"dial tcp: EHOSTUNREACH":                       "主机不可达：检查网络",
		"Connection lost before handshake":             "握手前连接中断",
		"别的错误":                                         "别的错误",
	}
	for in, want := range cases {
		if got := friendlyConnectError(errString(in)); got != want {
			t.Errorf("friendlyConnectError(%q) = %q, want %q", in, got, want)
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// fakeSessions 会话来源全不命中的假实现（Reconnect 守卫测试用）。
type fakeSessions struct{}

func (f *fakeSessions) FindSession(id string) *sshx.SessionConfig { return nil }
func (f *fakeSessions) GetSecret(sessionID string) string         { return "" }
func (f *fakeSessions) GetJumpSecret(sessionID string) string     { return "" }
