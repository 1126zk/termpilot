// Spike 4 服务器：验证官方 MCP go-sdk 的 StreamableHTTP 能否替代
// 现有 @modelcontextprotocol/sdk（TS）实现，并兼容 cli/main.go 的 /cli 协议。
// 监听 127.0.0.1:13927，避免与真实应用（3927）冲突。
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const addr = "127.0.0.1:13927"

func token() string {
	if t := os.Getenv("SPIKE_TOKEN"); t != "" {
		return t
	}
	return "spike-token-7f3a9c1e"
}

type echoInput struct {
	Text string `json:"text" jsonschema:"要原样返回的文本"`
}

func echo(text string) string { return text }

// ---- 工具目录（与 TS tool-catalog.ts 同构，spike 只注册 term_echo）----

type toolDef struct {
	Name        string
	Description string
}

var tools = []toolDef{
	{Name: "term_echo", Description: "原样返回输入文本"},
}

func findTool(name string) (toolDef, bool) {
	for _, t := range tools {
		if t.Name == name {
			return t, true
		}
	}
	return toolDef{}, false
}

// 对齐 TS 的 toolsText()：JSON.stringify([{name, description}], null, 2)
func toolsText() string {
	list := make([]toolDef, len(tools))
	copy(list, tools)
	buf, _ := json.MarshalIndent(list, "", "  ")
	return string(buf)
}

// 对齐 TS 的 toolSchema()：{name, description, inputSchema:{type, properties, required}}
func toolSchema(t toolDef) map[string]any {
	return map[string]any{
		"name":        t.Name,
		"description": t.Description,
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text": map[string]any{"type": "string", "description": "要原样返回的文本"},
			},
			"required": []string{"text"},
		},
	}
}

func schemaText(name string) (string, error) {
	if name == "" {
		all := make([]map[string]any, len(tools))
		for i, t := range tools {
			all[i] = toolSchema(t)
		}
		buf, _ := json.MarshalIndent(all, "", "  ")
		return string(buf), nil
	}
	t, ok := findTool(name)
	if !ok {
		return "", fmt.Errorf("未知命令: %s", name)
	}
	buf, _ := json.MarshalIndent(toolSchema(t), "", "  ")
	return string(buf), nil
}

// 对齐 TS 的 parseToolArgs + invoke 的参数校验
func callTool(name string, args map[string]any) (string, error) {
	if _, ok := findTool(name); !ok {
		return "", fmt.Errorf("未知命令: %s", name)
	}
	raw, present := args["text"]
	if !present || raw == nil || raw == "" {
		return "", fmt.Errorf("缺少 text")
	}
	text, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("text 必须是字符串")
	}
	return echo(text), nil
}

// ---- /cli 端点：与 src/main/services/McpService.ts 的 onCli 逐一对应 ----

type cliResult struct {
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	buf, _ := json.Marshal(body)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

func onCli(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, cliResult{OK: false, Text: "只接受 POST"})
		return
	}
	var body struct {
		Op   string         `json:"op"`
		Tool string         `json:"tool"`
		Args map[string]any `json:"args"`
	}
	// TS 是 JSON.parse(raw || '{}')：空 body 按 {} 处理，落到 op 校验
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1_000_000)).Decode(&body); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "Invalid JSON"})
		return
	}
	switch body.Op {
	case "tools":
		writeJSON(w, http.StatusOK, cliResult{OK: true, Text: toolsText()})
	case "schema":
		text, err := schemaText(body.Tool)
		if err != nil {
			writeJSON(w, http.StatusOK, cliResult{OK: false, Text: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, cliResult{OK: true, Text: text})
	case "call":
		if body.Tool == "" {
			writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "op 只能是 tools、schema 或 call"})
			return
		}
		args := body.Args
		if args == nil {
			args = map[string]any{}
		}
		text, err := callTool(body.Tool, args)
		if err != nil {
			writeJSON(w, http.StatusOK, cliResult{OK: false, Text: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, cliResult{OK: true, Text: text})
	default:
		writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "op 只能是 tools、schema 或 call"})
	}
}

// ---- 中间件：Host 校验 + Bearer 常量时间比较（对齐 TS 的 hostAllowed/authorized）----

func rpcError(message string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"error":   map[string]any{"code": -32000, "message": message},
		"id":      nil,
	}
}

func authorized(headerValue string) bool {
	if !strings.HasPrefix(headerValue, "Bearer ") {
		return false
	}
	got := []byte(strings.TrimPrefix(headerValue, "Bearer "))
	expect := []byte(token())
	if len(got) != len(expect) {
		return false
	}
	return subtle.ConstantTimeCompare(got, expect) == 1
}

func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Host, "127.0.0.1") {
			writeJSON(w, http.StatusForbidden, rpcError("Forbidden"))
			return
		}
		if !authorized(r.Header.Get("Authorization")) {
			writeJSON(w, http.StatusUnauthorized, rpcError("Unauthorized"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "termpilot-spike", Version: "0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "term_echo",
		Description: "原样返回输入文本",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in echoInput) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: echo(in.Text)}},
		}, nil, nil
	})

	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, nil)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcpHandler)
	mux.HandleFunc("/cli", onCli)

	log.Printf("[spike] MCP on http://%s/mcp, /cli ready", addr)
	if err := http.ListenAndServe(addr, guard(mux)); err != nil {
		log.Fatal(err)
	}
}
