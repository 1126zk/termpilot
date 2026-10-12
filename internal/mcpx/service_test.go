package mcpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testToken = "test-token-123456"

// startTestServer 起真实 HTTP 服务器（httptest），Host 白名单按实际端口放行。
func startTestServer(t *testing.T, svc *Service) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := httptest.NewUnstartedServer(svc.rootHandler(port))
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return fmt.Sprintf("127.0.0.1:%d", port)
}

// cliPost 复刻 spike verify 的 cliPost。
func cliPost(t *testing.T, addr string, body any, authHeader string) (int, cliResult) {
	t.Helper()
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, "http://"+addr+"/cli", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("content-type", "application/json")
	if authHeader != "" {
		req.Header.Set("authorization", authHeader)
	}
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		t.Fatal(err)
	}
	var out cliResult
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("响应不是 JSON: %s", strings.TrimSpace(string(buf)))
	}
	return res.StatusCode, out
}

func cliOK(t *testing.T, addr string, body any) (bool, string) {
	t.Helper()
	_, out := cliPost(t, addr, body, "Bearer "+testToken)
	return out.OK, out.Text
}

func TestCliTools(t *testing.T) {
	svc, _, _, _, _ := newTestService()
	svc.token = testToken
	addr := startTestServer(t, svc)

	ok, text := cliOK(t, addr, map[string]any{"op": "tools"})
	if !ok {
		t.Fatalf("op=tools: ok=false text=%q", text)
	}
	for _, tool := range TOOLS {
		if !strings.Contains(text, tool.Name) {
			t.Errorf("op=tools 缺 %s", tool.Name)
		}
	}
}

func TestCliSchema(t *testing.T) {
	svc, _, _, _, _ := newTestService()
	svc.token = testToken
	addr := startTestServer(t, svc)

	ok, text := cliOK(t, addr, map[string]any{"op": "schema"})
	if !ok || !strings.Contains(text, "inputSchema") || !strings.Contains(text, "term_exec") {
		t.Errorf("op=schema 全部: ok=%v text=%.200q", ok, text)
	}

	ok, text = cliOK(t, addr, map[string]any{"op": "schema", "tool": "term_exec"})
	if !ok || !strings.Contains(text, `"timeout"`) || !strings.Contains(text, `"maximum": 3600`) {
		t.Errorf("op=schema term_exec: ok=%v text=%.300q", ok, text)
	}

	ok, text = cliOK(t, addr, map[string]any{"op": "schema", "tool": "no_such_tool"})
	if ok || !strings.Contains(text, "未知命令") {
		t.Errorf("op=schema 未知工具: ok=%v text=%q", ok, text)
	}
}

func TestCliCall(t *testing.T) {
	svc, st, _, _, _ := newTestService()
	svc.token = testToken
	addr := startTestServer(t, svc)

	ok, text := cliOK(t, addr, map[string]any{"op": "call", "tool": "connection_list"})
	if !ok || !strings.Contains(text, "conn-1234abcd") || !strings.Contains(text, `"jump": false`) {
		t.Errorf("connection_list: ok=%v text=%q", ok, text)
	}

	// 缺必填参数 → 200 + ok:false（工具错误不走 HTTP 状态码）
	ok, text = cliOK(t, addr, map[string]any{"op": "call", "tool": "term_exec", "args": map[string]any{}})
	if ok || !strings.Contains(text, "connection: Required") {
		t.Errorf("缺参数: ok=%v text=%q", ok, text)
	}

	// 未知工具
	ok, text = cliOK(t, addr, map[string]any{"op": "call", "tool": "no_such_tool", "args": map[string]any{}})
	if ok || !strings.Contains(text, "未知命令") {
		t.Errorf("未知工具: ok=%v text=%q", ok, text)
	}

	// 非法 op → 400
	status, out := cliPost(t, addr, map[string]any{"op": "bogus"}, "Bearer "+testToken)
	if status != http.StatusBadRequest || out.OK {
		t.Errorf("非法 op: status=%d out=%+v", status, out)
	}

	// call 不带 tool → 400
	status, _ = cliPost(t, addr, map[string]any{"op": "call"}, "Bearer "+testToken)
	if status != http.StatusBadRequest {
		t.Errorf("call 缺 tool: status=%d", status)
	}

	// 非 POST → 405
	req, _ := http.NewRequest(http.MethodGet, "http://"+addr+"/cli", nil)
	req.Header.Set("authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /cli: status=%d", res.StatusCode)
	}

	// 参数校验：conn- 前缀
	ok, text = cliOK(t, addr, map[string]any{
		"op": "call", "tool": "term_exec",
		"args": map[string]any{"connection": "term-12345678", "command": "ls"},
	})
	if ok || !strings.Contains(text, "是终端编号。连接请填 conn- 开头") {
		t.Errorf("term- 误填: ok=%v text=%q", ok, text)
	}
	ok, text = cliOK(t, addr, map[string]any{
		"op": "call", "tool": "term_exec",
		"args": map[string]any{"connection": "web", "command": "ls"},
	})
	if ok || !strings.Contains(text, "不是连接编号") {
		t.Errorf("名称查找: ok=%v text=%q", ok, text)
	}

	// term- 前缀校验
	ok, text = cliOK(t, addr, map[string]any{
		"op": "call", "tool": "term_read",
		"args": map[string]any{"termId": "conn-1234abcd"},
	})
	if ok || !strings.Contains(text, "是连接编号。终端请填 term- 开头") {
		t.Errorf("conn- 误填: ok=%v text=%q", ok, text)
	}

	// 审计：两次失败 + 一次成功都落了
	if len(st.audit) == 0 {
		t.Fatal("审计为空")
	}
	last := st.audit[0]
	if last.tool != "connection_list" || !last.ok {
		t.Errorf("首条审计: %+v", last)
	}
}

func TestCliAuth(t *testing.T) {
	svc, _, _, _, _ := newTestService()
	svc.token = testToken
	addr := startTestServer(t, svc)

	status, _ := cliPost(t, addr, map[string]any{"op": "tools"}, "")
	if status != http.StatusUnauthorized {
		t.Errorf("无令牌: status=%d", status)
	}
	status, _ = cliPost(t, addr, map[string]any{"op": "tools"}, "Bearer wrong-token-00000")
	if status != http.StatusUnauthorized {
		t.Errorf("错令牌: status=%d", status)
	}

	// 错 Host 头 → 403
	payload, _ := json.Marshal(map[string]any{"op": "tools"})
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/cli", bytes.NewReader(payload))
	req.Host = "evil.example.com"
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("错 Host: status=%d", res.StatusCode)
	}

	// /mcp 无令牌 → 401
	req, _ = http.NewRequest(http.MethodPost, "http://"+addr+"/mcp", strings.NewReader(`{}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("/mcp 无令牌: status=%d", res.StatusCode)
	}

	// /mcp 非法方法 → 405
	req, _ = http.NewRequest(http.MethodPut, "http://"+addr+"/mcp", strings.NewReader(`{}`))
	req.Header.Set("authorization", "Bearer "+testToken)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("/mcp PUT: status=%d", res.StatusCode)
	}
}

// bearerTransport 给 go-sdk client 的每个请求加 Bearer 头（同 spike verify）。
type bearerTransport struct{ base http.RoundTripper }

func (bt bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("Authorization", "Bearer "+testToken)
	return bt.base.RoundTrip(r2)
}

// TestMCPEndToEnd 用 go-sdk 官方 client 走 StreamableHTTP：ListTools 24 个、
// CallTool connection_list 返回连接视图、缺参数被 inputSchema 拦下。
func TestMCPEndToEnd(t *testing.T) {
	svc, st, _, _, _ := newTestService()
	svc.token = testToken
	addr := startTestServer(t, svc)

	client := mcp.NewClient(&mcp.Implementation{Name: "mcpx-test", Version: "0.1.0"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:   "http://" + addr + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{base: http.DefaultTransport}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer session.Close()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(listed.Tools) != len(TOOLS) {
		t.Fatalf("ListTools 数量: got %d, want %d", len(listed.Tools), len(TOOLS))
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range listed.Tools {
		byName[tool.Name] = tool
	}
	for _, tool := range TOOLS {
		got, ok := byName[tool.Name]
		if !ok {
			t.Errorf("ListTools 缺 %s", tool.Name)
			continue
		}
		if got.Description != tool.Description {
			t.Errorf("%s: description 不一致", tool.Name)
		}
		if (got.Annotations != nil && got.Annotations.ReadOnlyHint) != tool.ReadOnly {
			t.Errorf("%s: readOnlyHint 不一致", tool.Name)
		}
	}
	// inputSchema 抽查：term_exec 的 required 与 timeout 上限
	execTool := byName["term_exec"]
	schemaBytes, _ := json.Marshal(execTool.InputSchema)
	var schema struct {
		Properties map[string]struct {
			Type    string   `json:"type"`
			Maximum *float64 `json:"maximum"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(schemaBytes, &schema); err != nil {
		t.Fatalf("inputSchema 不是 JSON: %v", err)
	}
	if schema.Properties["timeout"].Maximum == nil || *schema.Properties["timeout"].Maximum != 3600 {
		t.Errorf("term_exec.timeout.maximum: %v", schema.Properties["timeout"].Maximum)
	}
	if schema.Properties["maxBytes"].Type != "integer" {
		t.Errorf("term_exec.maxBytes.type: %q", schema.Properties["maxBytes"].Type)
	}
	joined := strings.Join(schema.Required, ",")
	if joined != "connection,command" {
		t.Errorf("term_exec.required: %v", schema.Required)
	}

	// CallTool：connection_list
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "connection_list", Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("CallTool connection_list: %v", err)
	}
	if res.IsError {
		t.Fatalf("connection_list isError: %v", res.Content)
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok || !strings.Contains(text.Text, "conn-1234abcd") {
		t.Errorf("connection_list 返回: %v", res.Content[0])
	}

	// CallTool：schema 校验（缺 command）
	res, err = session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "term_exec",
		Arguments: map[string]any{"connection": "conn-1234abcd"},
	})
	if err != nil {
		t.Fatalf("CallTool term_exec: %v", err)
	}
	if !res.IsError {
		t.Errorf("缺 command 应 isError")
	}
	// 校验失败不进 invoke，也不写审计（与 TS SDK 行为一致：zod 校验在 handler 之前）
	for _, rec := range st.audit {
		if rec.tool == "term_exec" {
			t.Errorf("校验失败的调用不应写审计: %+v", rec)
		}
	}

	// 连接数（对应 TS transports.size）
	if got := svc.State().Clients; got != 1 {
		t.Errorf("clients: got %d, want 1", got)
	}
}
