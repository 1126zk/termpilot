// Spike 4 验证客户端：自己构建并拉起 spike 服务器，然后逐项验证。
// (a) go-sdk 官方 client 走 StreamableHTTP 调 term_echo
// (b) 按 cli/main.go 的原始 HTTP 形状手发 /cli 三种 op
// (c) 无令牌/错令牌/错 Host 的负向用例
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	addr  = "127.0.0.1:13927"
	token = "spike-token-verify-9b2c"
)

var failures int

func report(ok bool, name, detail string) {
	if ok {
		fmt.Printf("[PASS] %s\n", name)
		return
	}
	failures++
	fmt.Printf("[FAIL] %s -- %s\n", name, detail)
}

// bearerTransport 给 go-sdk client 的每个请求加 Bearer 头
type bearerTransport struct{ base http.RoundTripper }

func (t bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("Authorization", "Bearer "+token)
	return t.base.RoundTrip(r2)
}

// cliPost 复刻 cli/main.go 的 post()：POST /cli，Bearer 认证，读 {ok, text}
func cliPost(body map[string]any, authHeader string) (int, map[string]any, error) {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, "http://"+addr+"/cli", bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	if authHeader != "" {
		req.Header.Set("authorization", authHeader)
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return res.StatusCode, nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(buf, &out); err != nil {
		return res.StatusCode, nil, fmt.Errorf("响应不是 JSON: %s", strings.TrimSpace(string(buf)))
	}
	return res.StatusCode, out, nil
}

func cliOK(body map[string]any) (bool, string) {
	_, out, err := cliPost(body, "Bearer "+token)
	if err != nil {
		return false, err.Error()
	}
	ok, _ := out["ok"].(bool)
	text, _ := out["text"].(string)
	return ok, text
}

func main() {
	stop, err := startServer()
	if err != nil {
		fmt.Printf("[FAIL] 启动 spike 服务器 -- %v\n", err)
		fmt.Println("SPIKE_RESULT: FAIL")
		os.Exit(1)
	}
	defer stop()

	checkSDKClient()
	checkCLI()
	checkAuth()

	if failures > 0 {
		fmt.Printf("SPIKE_RESULT: FAIL (%d 项未过)\n", failures)
		os.Exit(1)
	}
	fmt.Println("SPIKE_RESULT: PASS")
}

func startServer() (func(), error) {
	dir, err := os.MkdirTemp("", "spike4")
	if err != nil {
		return nil, err
	}
	bin := filepath.Join(dir, "spike-server.exe")
	build := exec.Command("go", "build", "-o", bin, "./server")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return nil, fmt.Errorf("go build ./server: %w", err)
	}
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(), "SPIKE_TOKEN="+token)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	stop := func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		_ = os.RemoveAll(dir)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return stop, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	stop()
	return nil, fmt.Errorf("服务器 15 秒内没有监听 %s", addr)
}

// (a) go-sdk 官方 client 走 StreamableHTTP
func checkSDKClient() {
	client := mcp.NewClient(&mcp.Implementation{Name: "spike-verify", Version: "0.1.0"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:   "http://" + addr + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{base: http.DefaultTransport}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		report(false, "sdk client Connect", err.Error())
		return
	}
	defer session.Close()
	report(true, "sdk client Connect (StreamableHTTP /mcp)", "")

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		report(false, "sdk client ListTools", err.Error())
	} else {
		found := false
		for _, t := range listed.Tools {
			if t.Name == "term_echo" {
				found = true
			}
		}
		report(found, "sdk client ListTools 含 term_echo", fmt.Sprintf("tools=%v", listed.Tools))
	}

	want := "hello 中文 echo 🎯"
	res, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "term_echo",
		Arguments: map[string]any{"text": want},
	})
	if err != nil {
		report(false, "sdk client CallTool term_echo", err.Error())
		return
	}
	if res.IsError {
		report(false, "sdk client CallTool term_echo", "服务器返回 isError")
		return
	}
	if len(res.Content) == 0 {
		report(false, "sdk client CallTool term_echo", "content 为空")
		return
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	report(ok && text.Text == want, "sdk client CallTool term_echo 原样返回",
		fmt.Sprintf("want=%q got=%v", want, res.Content[0]))
}

// (b) 按 cli/main.go 的原始 HTTP 形状手发 /cli
func checkCLI() {
	ok, text := cliOK(map[string]any{"op": "tools"})
	report(ok && strings.Contains(text, "term_echo") && strings.Contains(text, "原样返回"),
		"cli op=tools", fmt.Sprintf("ok=%v text=%q", ok, text))

	ok, text = cliOK(map[string]any{"op": "schema"})
	report(ok && strings.Contains(text, "term_echo") && strings.Contains(text, "inputSchema"),
		"cli op=schema (全部)", fmt.Sprintf("ok=%v text=%q", ok, text))

	ok, text = cliOK(map[string]any{"op": "schema", "tool": "term_echo"})
	report(ok && strings.Contains(text, `"text"`) && strings.Contains(text, `"required"`),
		"cli op=schema tool=term_echo", fmt.Sprintf("ok=%v text=%q", ok, text))

	ok, text = cliOK(map[string]any{"op": "schema", "tool": "no_such_tool"})
	report(!ok && strings.Contains(text, "未知命令"), "cli op=schema 未知工具 -> ok:false",
		fmt.Sprintf("ok=%v text=%q", ok, text))

	want := "ping 中文"
	ok, text = cliOK(map[string]any{"op": "call", "tool": "term_echo", "args": map[string]any{"text": want}})
	report(ok && text == want, "cli op=call term_echo", fmt.Sprintf("ok=%v text=%q", ok, text))

	ok, text = cliOK(map[string]any{"op": "call", "tool": "no_such_tool", "args": map[string]any{}})
	report(!ok && strings.Contains(text, "未知命令"), "cli op=call 未知工具 -> ok:false",
		fmt.Sprintf("ok=%v text=%q", ok, text))

	ok, text = cliOK(map[string]any{"op": "call", "tool": "term_echo", "args": map[string]any{}})
	report(!ok && strings.Contains(text, "缺少 text"), "cli op=call 缺参数 -> ok:false",
		fmt.Sprintf("ok=%v text=%q", ok, text))

	status, out, err := cliPost(map[string]any{"op": "bogus"}, "Bearer "+token)
	report(err == nil && status == http.StatusBadRequest && out["ok"] == false,
		"cli op 非法 -> 400", fmt.Sprintf("status=%d out=%v err=%v", status, out, err))
}

// (c) 鉴权与 Host 负向用例
func checkAuth() {
	status, _, err := cliPost(map[string]any{"op": "tools"}, "")
	report(err == nil && status == http.StatusUnauthorized, "cli 无令牌 -> 401",
		fmt.Sprintf("status=%d err=%v", status, err))

	status, _, err = cliPost(map[string]any{"op": "tools"}, "Bearer wrong-token")
	report(err == nil && status == http.StatusUnauthorized, "cli 错令牌 -> 401",
		fmt.Sprintf("status=%d err=%v", status, err))

	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/mcp", strings.NewReader(`{}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	status = 0
	if err == nil {
		status = res.StatusCode
		_ = res.Body.Close()
	}
	report(err == nil && status == http.StatusUnauthorized, "mcp 无令牌 -> 401",
		fmt.Sprintf("status=%d err=%v", status, err))

	req, _ = http.NewRequest(http.MethodPost, "http://"+addr+"/cli", strings.NewReader(`{"op":"tools"}`))
	req.Host = "evil.example.com"
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+token)
	res, err = (&http.Client{Timeout: 5 * time.Second}).Do(req)
	status = 0
	if err == nil {
		status = res.StatusCode
		_ = res.Body.Close()
	}
	report(err == nil && status == http.StatusForbidden, "错 Host 头 -> 403",
		fmt.Sprintf("status=%d err=%v", status, err))
}
