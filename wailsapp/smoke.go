package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"termpilot/app/internal/storage"
	"termpilot/app/internal/terminal"
)

// TERMPILOT_SMOKE=1 时的自检：建一个本机终端，写 echo，读回缓冲，
// 结果写到 userData/smoke.log 后退出。验证 storage + terminal + ConPTY
// 在真实 Wails 应用里端到端工作，不依赖人工看窗口。
func (a *App) runSmoke() {
	log := func(format string, args ...interface{}) {
		line := fmt.Sprintf(format+"\n", args...)
		f, err := os.OpenFile(filepath.Join(a.userData, "smoke.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.WriteString(line)
			_ = f.Close()
		}
	}

	time.Sleep(3 * time.Second)
	termID := "term-smoke1"
	log("smoke: create local terminal")
	a.terminal.Create(terminal.CreateOptions{
		TermID: termID,
		Kind:   terminal.KindLocal,
		Shell:  "cmd",
		Cols:   80,
		Rows:   24,
	})
	a.terminal.Input(termID, "echo SMOKE_OK\r\n")

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		tail, err := a.terminal.ReadTail(termID, 4000)
		if err == nil && contains(tail, "SMOKE_OK") {
			log("SMOKE_RESULT: PASS")
			a.terminal.Close(termID)
			os.Exit(0)
		}
		time.Sleep(500 * time.Millisecond)
	}
	log("SMOKE_RESULT: FAIL (没有读到 SMOKE_OK)")
	os.Exit(1)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TERMPILOT_SMOKE=2 时的自检：打开 MCP，用与 cli/main.go 相同的 HTTP 形状
// 打 /cli 的三个 op，验证 MCP 接线（go-sdk 服务器 + 鉴权 + 工具目录）端到端工作。
func (a *App) runSmoke2() {
	log := func(format string, args ...interface{}) {
		line := fmt.Sprintf(format+"\n", args...)
		f, err := os.OpenFile(filepath.Join(a.userData, "smoke.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.WriteString(line)
			_ = f.Close()
		}
	}
	fail := func(format string, args ...interface{}) {
		log("SMOKE2_RESULT: FAIL ("+format+")", args...)
		os.Exit(1)
	}

	time.Sleep(2 * time.Second)
	settings, err := a.store.SaveMcpSettings(&storage.McpSettingsInput{
		Enabled:          true,
		Port:             13929,
		Token:            "smoke-token-1234567890",
		ConfirmDangerous: false,
	})
	if err != nil {
		fail("save settings: %v", err)
	}
	if err := a.mcp.Apply(*settings); err != nil {
		fail("apply: %v", err)
	}
	time.Sleep(500 * time.Millisecond)

	post := func(body string) (int, string) {
		req, err := http.NewRequest("POST", "http://127.0.0.1:13929/cli", strings.NewReader(body))
		if err != nil {
			fail("new request: %v", err)
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("authorization", "Bearer smoke-token-1234567890")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return -1, err.Error()
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(data)
	}

	code, body := post(`{"op":"tools"}`)
	if code != 200 || !contains(body, "connection_list") || !contains(body, "term_screenshot") || !contains(body, "sftp_remove") {
		fail("tools: code=%d body=%.200s", code, body)
	}
	code, body = post(`{"op":"schema","tool":"term_exec"}`)
	if code != 200 || !contains(body, "term_exec") || !contains(body, "inputSchema") {
		fail("schema: code=%d body=%.200s", code, body)
	}
	code, body = post(`{"op":"call","tool":"connection_list"}`)
	if code != 200 || !contains(body, `"ok":true`) {
		fail("call connection_list: code=%d body=%.200s", code, body)
	}
	// 负向：无令牌 401
	req, _ := http.NewRequest("POST", "http://127.0.0.1:13929/cli", strings.NewReader(`{"op":"tools"}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fail("no-token request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		fail("no-token should be 401, got %d", resp.StatusCode)
	}
	// /mcp 端点活着（initialize 应返回 JSONRPC 响应而不是 404）
	req, _ = http.NewRequest("POST", "http://127.0.0.1:13929/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	req.Header.Set("authorization", "Bearer smoke-token-1234567890")
	req.Header.Set("MCP-Protocol-Version", "2025-03-26")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		fail("mcp initialize: %v", err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !contains(string(data), "termpilot") {
		fail("mcp initialize: code=%d body=%.200s", resp.StatusCode, string(data))
	}

	log("SMOKE2_RESULT: PASS")
	os.Exit(0)
}

// TERMPILOT_SMOKE=4：开启 MCP（固定 13929/smoke-token-1234567890）后保持存活，
// 供外部用真实 CLI（userData/bin/termpilot.exe）做端到端调用与拉起测试。
func (a *App) runSmoke4() {
	time.Sleep(2 * time.Second)
	settings, err := a.store.SaveMcpSettings(&storage.McpSettingsInput{
		Enabled:          true,
		Port:             13929,
		Token:            "smoke-token-1234567890",
		ConfirmDangerous: false,
	})
	if err == nil {
		_ = a.mcp.Apply(*settings)
	}
	select {}
}
