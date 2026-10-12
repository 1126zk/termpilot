package mcpx

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"termpilot/app/internal/storage"
)

// 超时与节奏。测试可以调小。
var (
	confirmTimeout = 60 * time.Second       // 危险操作确认（TS 60_000）
	captureTimeout = 60 * time.Second       // 截图（TS 60_000）
	linesTimeout   = 10 * time.Second       // 读取终端行（TS 10_000）
	modeTimeout    = 3 * time.Second        // 光标模式查询（TS 3_000）
	writeSettle    = 200 * time.Millisecond // term_write 发出后等回显（TS wait(200)）
	bindTimeout    = 8 * time.Second        // 前端打开标签（TS expectBind 8000）
	connectTimeout = 20 * time.Second       // SSH 首连（TS waitStatus 20_000）
	localTimeout   = 15 * time.Second       // 本机终端首连（TS waitStatus 15_000）
)

// errExiting 对应 TS stop() 时给挂起请求的「应用正在退出」。
var errExiting = errors.New("应用正在退出")

// Service 本机 MCP 服务，对应 TS McpService。只绑 127.0.0.1，每个请求都要带 Bearer 令牌。
type Service struct {
	deps Deps

	mu       sync.Mutex
	srv      *http.Server
	token    string
	runtime  McpRuntime
	clients  map[string]bool // 活跃 MCP 会话 id（对应 TS transports 的 size）
	mcp      *mcp.Server
	done     context.Context // 本轮运行的停止信号；Stop 时取消
	shutdown context.CancelFunc
}

// New 装配服务。mcp.Server 与工具注册只做一次，Apply/Stop 只控制 HTTP 监听。
func New(deps Deps) *Service {
	s := &Service{deps: deps, clients: map[string]bool{}}
	s.runtime = McpRuntime{Running: false, Port: storage.MCPDefaultPort, Clients: 0}
	s.done, s.shutdown = context.WithCancel(context.Background())
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "termpilot", Version: "0.1.0"}, nil)
	s.registerTools()
	return s
}

// State 对应 TS state()。
func (s *Service) State() McpRuntime {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runtime
}

// Apply 对应 TS apply(settings)：先停再按设置起。
func (s *Service) Apply(settings storage.McpSettings) error {
	_ = s.Stop()
	if !settings.Enabled {
		s.publish(McpRuntime{Running: false, Port: settings.Port, Clients: 0})
		log.Printf("[TermPilot] MCP disabled")
		return nil
	}
	s.mu.Lock()
	s.token = settings.Token
	s.mu.Unlock()
	if err := s.listen(settings.Port); err != nil {
		message := listenError(err, settings.Port)
		s.publish(McpRuntime{Running: false, Port: settings.Port, Clients: 0, Error: message})
		return errors.New(message)
	}
	s.publish(McpRuntime{Running: true, Port: settings.Port, Clients: 0})
	log.Printf("[TermPilot] MCP listening on http://%s:%d/mcp", storage.MCPHost, settings.Port)
	return nil
}

// Stop 对应 TS stop()：挂起的确认/截图/行读全部按「应用正在退出」收尾，再关监听。
func (s *Service) Stop() error {
	s.mu.Lock()
	s.shutdown()
	s.done, s.shutdown = context.WithCancel(context.Background())
	srv := s.srv
	s.srv = nil
	s.clients = map[string]bool{}
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Close()
}

// listen 起 HTTP 监听（TS listen + createServer 的组装）。
func (s *Service) listen(port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", storage.MCPHost, port))
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: s.rootHandler(port)}
	s.mu.Lock()
	s.srv = srv
	s.mu.Unlock()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[TermPilot] MCP server error: %v", err)
		}
	}()
	return nil
}

// rootHandler 对应 TS onRequest 的外层：Host 白名单 + 回环校验 → 403，
// Bearer 令牌 → 401，/cli 分流，/mcp 方法白名单 → 405。
func (s *Service) rootHandler(port int) http.Handler {
	mcpHandler := s.trackSessions(mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return s.mcp }, nil))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostAllowed(r, port) || !loopback(r) {
			writeJSON(w, http.StatusForbidden, rpcError("Forbidden"))
			return
		}
		s.mu.Lock()
		token := s.token
		s.mu.Unlock()
		if !authorized(r.Header.Get("Authorization"), token) {
			writeJSON(w, http.StatusUnauthorized, rpcError("Unauthorized"))
			return
		}
		if r.URL.Path == "/cli" {
			s.onCli(w, r)
			return
		}
		if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
			writeJSON(w, http.StatusMethodNotAllowed, rpcError("Method not allowed"))
			return
		}
		mcpHandler.ServeHTTP(w, r)
	})
}

// trackSessions 估算连接数（对应 TS transports.size）：initialize 响应头里出现的
// Mcp-Session-Id 记一个客户端，DELETE 摘掉。
func (s *Service) trackSessions(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		switch r.Method {
		case http.MethodPost:
			if id := w.Header().Get("Mcp-Session-Id"); id != "" {
				s.mu.Lock()
				if !s.clients[id] {
					s.clients[id] = true
					s.mu.Unlock()
					s.publishClients()
				} else {
					s.mu.Unlock()
				}
			}
		case http.MethodDelete:
			if id := r.Header.Get("Mcp-Session-Id"); id != "" {
				s.mu.Lock()
				_, ok := s.clients[id]
				delete(s.clients, id)
				s.mu.Unlock()
				if ok {
					s.publishClients()
				}
			}
		}
	})
}

func (s *Service) publish(next McpRuntime) {
	s.mu.Lock()
	s.runtime = next
	s.mu.Unlock()
	if s.deps.OnState != nil {
		s.deps.OnState(next)
	}
}

func (s *Service) publishClients() {
	s.mu.Lock()
	next := s.runtime
	next.Clients = len(s.clients)
	next.Error = ""
	s.mu.Unlock()
	s.publish(next)
}

// registerTools 对应 TS createServer()：按目录注册全部工具。
// 入参先经 go-sdk 按 inputSchema 校验（等价 TS SDK 的 zod 校验），再按
// TS 的 strip 语义剔掉未声明键，走 invoke。
func (s *Service) registerTools() {
	for i := range TOOLS {
		tool := TOOLS[i]
		def := &mcp.Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.mcpInputSchema(),
		}
		if tool.ReadOnly {
			def.Annotations = &mcp.ToolAnnotations{ReadOnlyHint: true}
		}
		mcp.AddTool(s.mcp, def,
			func(ctx context.Context, _ *mcp.CallToolRequest, in map[string]any) (*mcp.CallToolResult, any, error) {
				input := tool.stripUnknown(in)
				detail := auditDetail(input)
				work := func() (string, error) { return s.invoke(ctx, tool.Name, input) }
				if tool.Images == "" {
					return s.run(tool.Name, detail, work), nil, nil
				}
				_, hasStart := input["startLine"]
				_, hasEnd := input["endLine"]
				attach := tool.Images == "always" || hasStart || hasEnd
				return s.shot(tool.Name, detail, attach, work), nil, nil
			})
	}
}

// run 对应 TS run：成功/失败都写审计，失败包成 isError 结果。
func (s *Service) run(tool, detail string, work func() (string, error)) *mcp.CallToolResult {
	text, err := work()
	if err != nil {
		s.audit(tool, false, strings.TrimSpace(detail+" "+err.Error()))
		return errorResult(err)
	}
	s.audit(tool, true, detail)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// shot 对应 TS shot：截图类工具，attach 时把结果里的 PNG 文件读出来附进 content。
func (s *Service) shot(tool, detail string, attach bool, work func() (string, error)) *mcp.CallToolResult {
	text, err := work()
	if err != nil {
		s.audit(tool, false, strings.TrimSpace(detail+" "+err.Error()))
		return errorResult(err)
	}
	s.audit(tool, true, detail)
	content := []mcp.Content{&mcp.TextContent{Text: text}}
	if attach {
		for _, img := range pngsIn(text) {
			content = append(content, &mcp.ImageContent{Data: img.data, MIMEType: "image/png"})
		}
	}
	return &mcp.CallToolResult{Content: content}
}

func (s *Service) audit(tool string, ok bool, detail string) {
	if s.deps.Storage == nil {
		return
	}
	if err := s.deps.Storage.AppendAudit(tool, ok, detail); err != nil {
		log.Printf("[TermPilot] MCP audit failed: %v", err)
	}
}

func errorResult(err error) *mcp.CallToolResult {
	res := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}
	res.IsError = true
	return res
}

// ------------------------------------------------ 前端合成链路（对应 TS 的 wc.send + 等待 IPC 回复）

// ask 对应 TS ask：危险操作确认。60 秒没人答按拒绝；服务停止按拒绝。
func (s *Service) ask(ctx context.Context, command string) (bool, error) {
	if s.deps.Confirm == nil {
		return false, errors.New("窗口不可用，无法确认危险操作")
	}
	ok, err := waitReply(ctx, s.currentDone(), confirmTimeout, false, func(ctx context.Context) (bool, error) {
		return s.deps.Confirm(ctx, clipRunes(command, 2000))
	})
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errExiting) {
		return false, nil
	}
	return ok, err
}

// capture 对应 TS capture：让前端跑 captureReplay 并等 capture.reply。
// 发给前端的 EndLine 是 +1 后的开区间。返回的路径必须在 ScreenshotDir 下。
func (s *Service) capture(ctx context.Context, termID, mode string, startLine, endLine *int, cropOnly bool) (string, error) {
	if startLine != nil && endLine != nil && *endLine < *startLine {
		return "", errors.New("endLine 要大于或等于 startLine，两端都包含")
	}
	if s.deps.Capture == nil {
		return "", errors.New("窗口不可用，无法截图")
	}
	req := CaptureRequest{
		ID:        uuid.NewString(),
		TermID:    termID,
		Mode:      mode,
		StartLine: startLine,
		CropOnly:  cropOnly,
	}
	if endLine != nil {
		end := *endLine + 1
		req.EndLine = &end
	}
	reply, err := waitReply(ctx, s.currentDone(), captureTimeout, CaptureReply{}, func(ctx context.Context) (CaptureReply, error) {
		return s.deps.Capture(ctx, req)
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", errors.New("截图超时")
		}
		return "", err
	}
	if reply.Error != "" || len(reply.Paths) == 0 {
		return "", errors.New(orDefault(reply.Error, "截图失败"))
	}
	paths := s.filterScreenshotPaths(reply.Paths)
	if len(paths) == 0 {
		return "", errors.New("截图失败")
	}
	parts := make([]string, 0, len(paths)+1)
	if reply.Note != "" {
		parts = append(parts, reply.Note)
	}
	parts = append(parts, paths...)
	return strings.Join(parts, "\n"), nil
}

// filterScreenshotPaths 落盘限定 userData/screenshots：目录外的路径一律丢弃。
func (s *Service) filterScreenshotPaths(paths []string) []string {
	dir := s.deps.ScreenshotDir
	if dir == "" {
		return paths
	}
	allowed := make([]string, 0, len(paths))
	for _, p := range paths {
		if withinDir(dir, p) {
			allowed = append(allowed, p)
		}
	}
	return allowed
}

// lines 对应 TS lines：让前端读终端缓冲并等 term.lines 回复。
func (s *Service) lines(ctx context.Context, termID string, startLine, endLine *int) (string, error) {
	if startLine != nil && endLine != nil && *endLine < *startLine {
		return "", errors.New("endLine 要大于或等于 startLine，两端都包含")
	}
	if s.deps.Lines == nil {
		return "", errors.New("窗口不可用，无法读取终端")
	}
	req := TermLinesRequest{ID: uuid.NewString(), TermID: termID, StartLine: startLine}
	if startLine == nil && endLine != nil {
		zero := 0
		req.StartLine = &zero
	}
	if endLine != nil {
		end := *endLine + 1
		req.EndLine = &end
	}
	reply, err := waitReply(ctx, s.currentDone(), linesTimeout, TermLinesReply{}, func(ctx context.Context) (TermLinesReply, error) {
		return s.deps.Lines(ctx, req)
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", errors.New("读取终端行超时")
		}
		return "", err
	}
	if reply.Error != "" || reply.Lines == nil {
		return "", errors.New(orDefault(reply.Error, "读取终端行失败"))
	}
	return formatLines(reply), nil
}

// cursorMode 对应 TS cursorMode：查不到或超时都按 false（普通光标模式）。
func (s *Service) cursorMode(ctx context.Context, termID string) bool {
	if s.deps.Mode == nil {
		return false
	}
	req := TermModeRequest{ID: uuid.NewString(), TermID: termID}
	reply, err := waitReply(ctx, s.currentDone(), modeTimeout, TermModeReply{}, func(ctx context.Context) (TermModeReply, error) {
		return s.deps.Mode(ctx, req)
	})
	if err != nil || reply.ApplicationCursor == nil {
		return false
	}
	return *reply.ApplicationCursor
}

// currentDone 本轮运行的停止信号快照。
func (s *Service) currentDone() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// waitReply 给请求-应答回调套超时与服务停止兜底：超时返回 context.DeadlineExceeded，
// 服务停止返回 errExiting（对应 TS stop() 给挂起请求的收尾）。
func waitReply[T any](ctx context.Context, done context.Context, timeout time.Duration, zero T, fn func(context.Context) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type result struct {
		v   T
		err error
	}
	ch := make(chan result, 1)
	go func() {
		v, err := fn(ctx)
		ch <- result{v, err}
	}()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-ctx.Done():
		return zero, context.DeadlineExceeded
	case <-done.Done():
		return zero, errExiting
	}
}

// ------------------------------------------------ /cli 端点（对应 TS onCli，与 spike 验证的契约一致）

func (s *Service) onCli(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, cliResult{OK: false, Text: "只接受 POST"})
		return
	}
	var body struct {
		Op   any `json:"op"`
		Tool any `json:"tool"`
		Args any `json:"args"`
	}
	// TS 是 JSON.parse(raw || '{}')：空 body 按 {} 处理，落到 op 校验。
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1_000_000)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "Invalid JSON"})
		return
	}
	op, _ := body.Op.(string)
	toolName, _ := body.Tool.(string)
	switch op {
	case "tools":
		writeJSON(w, http.StatusOK, cliResult{OK: true, Text: ToolsText()})
	case "schema":
		text, err := SchemaText(toolName)
		if err != nil {
			writeJSON(w, http.StatusOK, cliResult{OK: false, Text: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, cliResult{OK: true, Text: text})
	case "call":
		if toolName == "" {
			writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "op 只能是 tools、schema 或 call"})
			return
		}
		raw, _ := body.Args.(map[string]any)
		if raw == nil {
			raw = map[string]any{}
		}
		args, err := parseToolArgs(toolName, raw)
		if err != nil {
			writeJSON(w, http.StatusOK, cliResult{OK: false, Text: err.Error()})
			return
		}
		detail := auditDetail(args)
		if detail == "" {
			detail = toolName
		}
		result := s.run(toolName, detail, func() (string, error) {
			return s.invoke(r.Context(), toolName, args)
		})
		writeJSON(w, http.StatusOK, cliResult{OK: !result.IsError, Text: resultText(result)})
	default:
		writeJSON(w, http.StatusBadRequest, cliResult{OK: false, Text: "op 只能是 tools、schema 或 call"})
	}
}

func resultText(result *mcp.CallToolResult) string {
	for _, c := range result.Content {
		if text, ok := c.(*mcp.TextContent); ok {
			return text.Text
		}
	}
	return ""
}

// ------------------------------------------------ 中间件与辅助（对应 TS hostAllowed/loopback/authorized 等）

func hostAllowed(r *http.Request, port int) bool {
	return r.Host == fmt.Sprintf("%s:%d", storage.MCPHost, port) ||
		r.Host == fmt.Sprintf("localhost:%d", port)
}

func loopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return host == "127.0.0.1" || host == "::ffff:127.0.0.1" || host == "::1"
}

// authorized 对应 TS authorized：Bearer 前缀 + crypto/subtle 常量时间比较。
func authorized(headerValue, token string) bool {
	if !strings.HasPrefix(headerValue, "Bearer ") || token == "" {
		return false
	}
	got := []byte(strings.TrimPrefix(headerValue, "Bearer "))
	expect := []byte(token)
	if len(got) != len(expect) {
		return false
	}
	return subtle.ConstantTimeCompare(got, expect) == 1
}

func rpcError(message string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"error":   map[string]any{"code": -32000, "message": message},
		"id":      nil,
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	buf, _ := json.Marshal(body)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

// listenError 对应 TS listenError：端口占用给中文提示。
func listenError(err error, port int) string {
	if errors.Is(err, syscall.EADDRINUSE) {
		return fmt.Sprintf("端口 %d 已被占用", port)
	}
	return err.Error()
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
