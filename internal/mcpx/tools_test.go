package mcpx

import (
	"context"
	"strings"
	"testing"
	"time"

	"termpilot/internal/storage"
	"termpilot/internal/terminal"
)

func ptrInt(v int) *int { return &v }

func withTerm(term *fakeTerminal, id, status string, kind terminal.Kind) {
	term.terms = append(term.terms, terminal.TermInfo{ID: id, Kind: kind, Status: status, Title: "PowerShell (1)"})
}

// TestConnectionOpenClose 开关标签事件 + 开连接文案。
func TestConnectionOpenClose(t *testing.T) {
	ctx := context.Background()
	svc, st, term, sftp, _ := newTestService()
	var opened []TabOpen
	var closedTabs []string
	svc.deps.OnOpenTab = func(tab TabOpen) { opened = append(opened, tab) }
	svc.deps.OnCloseTab = func(id string) { closedTabs = append(closedTabs, id) }

	out, err := svc.invoke(ctx, "connection_open", map[string]any{"connection": "conn-1234abcd"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "已打开连接 conn-1234abcd（web）。") || !strings.Contains(out, "标题：web (1)") {
		t.Errorf("开连接文案: %q", out)
	}
	if len(opened) != 1 || opened[0].Kind != "ssh" || opened[0].SessionID == nil || *opened[0].SessionID != "s1" {
		t.Errorf("OnOpenTab: %+v", opened)
	}
	termID := opened[0].TermID
	if !IsTermID(termID) {
		t.Errorf("termId 形状: %q", termID)
	}
	if len(term.created) != 1 || term.created[0].Kind != terminal.KindSSH || term.created[0].Cols != 120 || term.created[0].Rows != 32 {
		t.Errorf("Create 参数: %+v", term.created)
	}

	// 关掉连接：终端关掉、标签关掉、文件通道断开
	term.terms = []terminal.TermInfo{{ID: termID, Kind: terminal.KindSSH, Status: "connected", SessionID: ptrStr("s1")}}
	out, err = svc.invoke(ctx, "connection_close", map[string]any{"connection": "conn-1234abcd"})
	if err != nil || out != "已断开 web，关闭 1 个终端" {
		t.Errorf("关连接: out=%q err=%v", out, err)
	}
	if len(closedTabs) != 1 || closedTabs[0] != termID {
		t.Errorf("OnCloseTab: %v", closedTabs)
	}
	if len(sftp.closed) != 1 || sftp.closed[0] != "s1" {
		t.Errorf("sftp.Close: %v", sftp.closed)
	}
	_ = st
}

func ptrStr(s string) *string { return &s }

// TestTermCRUD term_list / term_update / term_close / term_reconnect。
func TestTermCRUD(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	withTerm(term, "term-aaaa1111", "connected", terminal.KindSSH)
	term.terms[0].SessionID = ptrStr("s1")

	out, err := svc.invoke(ctx, "term_list", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"termId": "term-aaaa1111"`) || !strings.Contains(out, `"connection": "conn-1234abcd"`) {
		t.Errorf("term_list: %q", out)
	}

	out, err = svc.invoke(ctx, "term_update", map[string]any{"termId": "term-aaaa1111", "remark": "在跑部署"})
	if err != nil || out != "已写上备注" {
		t.Errorf("term_update: out=%q err=%v", out, err)
	}
	if term.labels["term-aaaa1111"] != "在跑部署" {
		t.Errorf("备注: %v", term.labels)
	}

	out, err = svc.invoke(ctx, "term_reconnect", map[string]any{"termId": "term-aaaa1111"})
	if err != nil || !strings.Contains(out, "已经连着") {
		t.Errorf("term_reconnect 已连接: out=%q err=%v", out, err)
	}
	term.terms[0].Status = "disconnected"
	out, err = svc.invoke(ctx, "term_reconnect", map[string]any{"termId": "term-aaaa1111"})
	if err != nil || !strings.Contains(out, "已重新连接终端 term-aaaa1111") || !strings.Contains(out, "连接：conn-1234abcd（web）") {
		t.Errorf("term_reconnect: out=%q err=%v", out, err)
	}

	out, err = svc.invoke(ctx, "term_close", map[string]any{"termId": "term-aaaa1111"})
	if err != nil || out != "已关闭" {
		t.Errorf("term_close: out=%q err=%v", out, err)
	}
	if len(term.closed) != 1 {
		t.Errorf("Close 次数: %v", term.closed)
	}
}

// TestTermReadPty term_read 的 ANSI 清洗与 term_pty 的退出码行。
func TestTermReadPty(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	withTerm(term, "term-bbbb2222", "connected", terminal.KindSSH)
	term.tail = "\x1b[32mgreen\x1b[0m\r\nok\r\n"

	out, err := svc.invoke(ctx, "term_read", map[string]any{"termId": "term-bbbb2222"})
	if err != nil || out != "green\nok" {
		t.Errorf("term_read: out=%q err=%v", out, err)
	}

	code := 3
	term.execResult = terminal.ExecResult{Output: "partial\n", ExitCode: &code, Finished: true}
	out, err = svc.invoke(ctx, "term_pty", map[string]any{"termId": "term-bbbb2222", "command": "ls"})
	if err != nil || !strings.HasSuffix(out, "\n\nexit code: 3") {
		t.Errorf("term_pty 完成: out=%q err=%v", out, err)
	}

	term.execResult = terminal.ExecResult{Output: "running\n", Finished: false}
	out, err = svc.invoke(ctx, "term_pty", map[string]any{"termId": "term-bbbb2222", "command": "top"})
	if err != nil || !strings.HasSuffix(out, "命令还在跑，以上是已经回来的内容。") {
		t.Errorf("term_pty 未完: out=%q err=%v", out, err)
	}
}

// TestTermWrite 按键编码、光标模式查询、写后读屏。
func TestTermWrite(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	withTerm(term, "term-cccc3333", "connected", terminal.KindSSH)
	truthy := true
	svc.deps.Mode = func(_ context.Context, req TermModeRequest) (TermModeReply, error) {
		if req.TermID != "term-cccc3333" {
			t.Errorf("mode termId: %q", req.TermID)
		}
		return TermModeReply{ID: req.ID, ApplicationCursor: &truthy}, nil
	}
	svc.deps.Lines = func(_ context.Context, req TermLinesRequest) (TermLinesReply, error) {
		return TermLinesReply{
			ID: req.ID, Length: ptrInt(2), ViewportY: ptrInt(0), Rows: ptrInt(24),
			Lines: []TermLine{{N: 0, Text: "menu"}, {N: 1, Text: "> item"}},
		}, nil
	}
	out, err := svc.invoke(ctx, "term_write", map[string]any{"termId": "term-cccc3333", "keys": []any{"down", "enter"}})
	if err != nil {
		t.Fatal(err)
	}
	// 应用光标模式下 down = ESC O B，enter = \r
	payload := term.inputs["term-cccc3333"]
	if len(payload) != 1 || payload[0] != "\x1bOB\r" {
		t.Errorf("payload: %q", payload)
	}
	if !strings.Contains(out, "缓冲共 2 行，当前画面是第 0–23 行。") || !strings.Contains(out, "1|> item") {
		t.Errorf("写后读屏: %q", out)
	}

	// 缺内容 → 报错
	_, err = svc.invoke(ctx, "term_write", map[string]any{"termId": "term-cccc3333"})
	if err == nil || !strings.Contains(err.Error(), "要提供 keys、text、submit 或 data") {
		t.Errorf("空 write: err=%v", err)
	}

	// 不认识的按键
	_, err = svc.invoke(ctx, "term_write", map[string]any{"termId": "term-cccc3333", "keys": "f99"})
	if err == nil || !strings.Contains(err.Error(), "不认识的按键: f99") {
		t.Errorf("坏按键: err=%v", err)
	}
}

// TestTermLines 范围读取：ranged 时 startLine 补 0、endLine +1。
func TestTermLines(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	withTerm(term, "term-dddd4444", "connected", terminal.KindSSH)
	var gotReq TermLinesRequest
	svc.deps.Lines = func(_ context.Context, req TermLinesRequest) (TermLinesReply, error) {
		gotReq = req
		return TermLinesReply{ID: req.ID, Length: ptrInt(100), ViewportY: ptrInt(80), Rows: ptrInt(24),
			Lines: []TermLine{{N: 10, Text: "x"}}}, nil
	}
	out, err := svc.invoke(ctx, "term_lines", map[string]any{"termId": "term-dddd4444", "endLine": float64(50)})
	if err != nil {
		t.Fatal(err)
	}
	if gotReq.StartLine == nil || *gotReq.StartLine != 0 {
		t.Errorf("ranged 时 startLine 应补 0: %+v", gotReq.StartLine)
	}
	if gotReq.EndLine == nil || *gotReq.EndLine != 51 {
		t.Errorf("endLine 应 +1: %+v", gotReq.EndLine)
	}
	if !strings.Contains(out, "缓冲共 100 行，当前画面是第 80–103 行。\n10|x") {
		t.Errorf("formatLines: %q", out)
	}

	// endLine < startLine → 拒绝
	_, err = svc.invoke(ctx, "term_lines", map[string]any{
		"termId": "term-dddd4444", "startLine": float64(9), "endLine": float64(3),
	})
	if err == nil || !strings.Contains(err.Error(), "endLine 要大于或等于 startLine") {
		t.Errorf("行范围: err=%v", err)
	}
}

// TestScreenshot 截图链路：视口/回滚模式、endLine+1、note+paths 拼接、目录限定、超时。
func TestScreenshot(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	withTerm(term, "term-eeee5555", "connected", terminal.KindSSH)
	svc.deps.ScreenshotDir = t.TempDir()

	var gotReq CaptureRequest
	svc.deps.Capture = func(_ context.Context, req CaptureRequest) (CaptureReply, error) {
		gotReq = req
		return CaptureReply{
			ID:    req.ID,
			Note:  "缓冲共 100 行，已截取第 10–20 行",
			Paths: []string{svc.deps.ScreenshotDir + "/shot-1.png"},
		}, nil
	}
	out, err := svc.invoke(ctx, "term_screenshot_scrollback", map[string]any{
		"termId": "term-eeee5555", "startLine": float64(10), "endLine": float64(20),
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotReq.Mode != "scrollback" || !gotReq.CropOnly {
		t.Errorf("scrollback 请求: %+v", gotReq)
	}
	if gotReq.EndLine == nil || *gotReq.EndLine != 21 {
		t.Errorf("endLine 应 +1: %+v", gotReq.EndLine)
	}
	if !strings.Contains(out, "缓冲共 100 行") || !strings.Contains(out, "shot-1.png") {
		t.Errorf("截图返回: %q", out)
	}

	// term_screenshot 不带行号 → viewport
	out, err = svc.invoke(ctx, "term_screenshot", map[string]any{"termId": "term-eeee5555"})
	if err != nil || gotReq.Mode != "viewport" || gotReq.CropOnly {
		t.Errorf("viewport: out=%q req=%+v err=%v", out, gotReq, err)
	}
	// term_screenshot 带行号 → scrollback + cropOnly
	_, err = svc.invoke(ctx, "term_screenshot", map[string]any{"termId": "term-eeee5555", "startLine": float64(0)})
	if err != nil || gotReq.Mode != "scrollback" || !gotReq.CropOnly {
		t.Errorf("ranged screenshot: req=%+v err=%v", gotReq, err)
	}

	// 目录外的路径被丢弃
	svc.deps.Capture = func(_ context.Context, req CaptureRequest) (CaptureReply, error) {
		return CaptureReply{ID: req.ID, Paths: []string{t.TempDir() + "/evil.png"}}, nil
	}
	_, err = svc.invoke(ctx, "term_screenshot", map[string]any{"termId": "term-eeee5555"})
	if err == nil || !strings.Contains(err.Error(), "截图失败") {
		t.Errorf("目录外路径: err=%v", err)
	}

	// 超时
	svc.deps.Capture = func(ctx context.Context, req CaptureRequest) (CaptureReply, error) {
		select {}
	}
	restore := captureTimeout
	captureTimeout = 50 * time.Millisecond
	defer func() { captureTimeout = restore }()
	_, err = svc.invoke(ctx, "term_screenshot", map[string]any{"termId": "term-eeee5555"})
	if err == nil || !strings.Contains(err.Error(), "截图超时") {
		t.Errorf("截图超时: err=%v", err)
	}

	// 无窗口
	svc.deps.Capture = nil
	_, err = svc.invoke(ctx, "term_screenshot", map[string]any{"termId": "term-eeee5555"})
	if err == nil || !strings.Contains(err.Error(), "窗口不可用，无法截图") {
		t.Errorf("无窗口: err=%v", err)
	}
}

// TestConnectionCreateUpdateDelete 连接 CRUD 与 publishSessions。
func TestConnectionCreateUpdateDelete(t *testing.T) {
	ctx := context.Background()
	svc, st, _, _, _ := newTestService()
	svc.deps.Confirm = func(context.Context, string) (bool, error) { return true, nil }
	var changed int
	svc.deps.OnSessionChanged = func(_ []*storage.SessionConfig) { changed++ }

	// create
	out, err := svc.invoke(ctx, "connection_create", map[string]any{
		"name": "db", "host": "2.2.2.2", "username": "root", "secret": "pw",
	})
	if err != nil || !strings.Contains(out, `"id": "conn-new0001"`) {
		t.Errorf("create: out=%q err=%v", out, err)
	}
	if changed != 1 {
		t.Errorf("publishSessions: %d", changed)
	}

	// 重名拒绝
	_, err = svc.invoke(ctx, "connection_create", map[string]any{
		"name": "db", "host": "3.3.3.3", "username": "root", "secret": "pw",
	})
	if err == nil || !strings.Contains(err.Error(), "已有同名连接: db") {
		t.Errorf("重名: err=%v", err)
	}

	// 缺 secret 拒绝
	_, err = svc.invoke(ctx, "connection_create", map[string]any{
		"name": "x", "host": "3.3.3.3", "username": "root",
	})
	if err == nil || !strings.Contains(err.Error(), "需要填写密码（secret）") {
		t.Errorf("缺 secret: err=%v", err)
	}

	// update：只改 remark，其余沿用
	out, err = svc.invoke(ctx, "connection_update", map[string]any{
		"connection": "conn-1234abcd", "remark": "生产库",
	})
	if err != nil || !strings.Contains(out, `"remark": "生产库"`) || !strings.Contains(out, `"host": "1.2.3.4"`) {
		t.Errorf("update: out=%q err=%v", out, err)
	}

	// delete（确认放行）
	out, err = svc.invoke(ctx, "connection_delete", map[string]any{"connection": "conn-1234abcd"})
	if err != nil || out != "已删除 web" {
		t.Errorf("delete: out=%q err=%v", out, err)
	}
	if len(st.deleted) != 1 || st.deleted[0] != "s1" {
		t.Errorf("删除: %v", st.deleted)
	}
}

// TestOpenLocal 本机终端。
func TestOpenLocal(t *testing.T) {
	ctx := context.Background()
	svc, _, term, _, _ := newTestService()
	var opened []TabOpen
	svc.deps.OnOpenTab = func(tab TabOpen) { opened = append(opened, tab) }
	out, err := svc.invoke(ctx, "term_open_local", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "已打开本机终端 term-") || !strings.Contains(out, "标题：PowerShell (1)") {
		t.Errorf("openLocal: %q", out)
	}
	if len(opened) != 1 || opened[0].Kind != "local" || opened[0].SessionID != nil {
		t.Errorf("OnOpenTab local: %+v", opened)
	}
	if len(term.created) != 1 || term.created[0].Kind != terminal.KindLocal {
		t.Errorf("Create local: %+v", term.created)
	}
}

// TestState 运行态默认值与启停。
func TestState(t *testing.T) {
	svc, _, _, _, _ := newTestService()
	if got := svc.State(); got.Running || got.Port != 3927 || got.Clients != 0 {
		t.Errorf("默认 state: %+v", got)
	}
	var published []McpRuntime
	svc.deps.OnState = func(st McpRuntime) { published = append(published, st) }
	if err := svc.Apply(storage.McpSettings{Enabled: false, Port: 4001}); err != nil {
		t.Fatal(err)
	}
	if got := svc.State(); got.Running || got.Port != 4001 {
		t.Errorf("disabled state: %+v", got)
	}
	if len(published) != 1 || published[0].Running {
		t.Errorf("state 事件: %+v", published)
	}
}
