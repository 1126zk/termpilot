package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"termpilot/internal/mcpx"
)

// MCP 的四个请求-应答链路（对应 Electron 版 wc.send(事件) + 等 IPC 回复）：
// Go 侧发事件给前端后阻塞等 reply 通道，ctx 取消/超时由 mcpx 控制。

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "req-" + hex.EncodeToString(b[:])
}

type confirmRegistry struct {
	mu      sync.Mutex
	pending map[string]chan bool
}

type captureRegistry struct {
	mu      sync.Mutex
	pending map[string]chan mcpx.CaptureReply
}

type linesRegistry struct {
	mu      sync.Mutex
	pending map[string]chan mcpx.TermLinesReply
}

type modeRegistry struct {
	mu      sync.Mutex
	pending map[string]chan mcpx.TermModeReply
}

var confirms = &confirmRegistry{pending: map[string]chan bool{}}
var captures = &captureRegistry{pending: map[string]chan mcpx.CaptureReply{}}
var linesReqs = &linesRegistry{pending: map[string]chan mcpx.TermLinesReply{}}
var modeReqs = &modeRegistry{pending: map[string]chan mcpx.TermModeReply{}}

// mcpConfirm 对应 Deps.Confirm：发 mcp:confirm 弹窗请求，等 mcp:confirm-reply。
func (a *App) mcpConfirm(ctx context.Context, command string) (bool, error) {
	id := newRequestID()
	ch := make(chan bool, 1)
	confirms.mu.Lock()
	confirms.pending[id] = ch
	confirms.mu.Unlock()
	defer func() {
		confirms.mu.Lock()
		delete(confirms.pending, id)
		confirms.mu.Unlock()
	}()
	a.emit("mcp:confirm", map[string]string{"id": id, "command": command})
	select {
	case ok := <-ch:
		return ok, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func (a *App) hMcpConfirmReply(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	ok, err := arg[bool](args, 1)
	if err != nil {
		return nil, err
	}
	confirms.mu.Lock()
	ch := confirms.pending[id]
	confirms.mu.Unlock()
	if ch != nil {
		ch <- ok
	}
	return nil, nil
}

// mcpCapture 对应 Deps.Capture：发 capture:run 让前端跑合成截图，等 capture:reply。
func (a *App) mcpCapture(ctx context.Context, req mcpx.CaptureRequest) (mcpx.CaptureReply, error) {
	ch := make(chan mcpx.CaptureReply, 1)
	captures.mu.Lock()
	captures.pending[req.ID] = ch
	captures.mu.Unlock()
	defer func() {
		captures.mu.Lock()
		delete(captures.pending, req.ID)
		captures.mu.Unlock()
	}()
	a.emit("capture:run", req)
	select {
	case reply := <-ch:
		return reply, nil
	case <-ctx.Done():
		return mcpx.CaptureReply{}, ctx.Err()
	}
}

func (a *App) hCaptureReply(args []interface{}) (interface{}, error) {
	reply, err := arg[mcpx.CaptureReply](args, 0)
	if err != nil {
		return nil, err
	}
	captures.mu.Lock()
	ch := captures.pending[reply.ID]
	captures.mu.Unlock()
	if ch != nil {
		ch <- reply
	}
	return nil, nil
}

// mcpLines 对应 Deps.Lines：发 term:lines 让前端按缓冲行读，等 term:lines-reply。
func (a *App) mcpLines(ctx context.Context, req mcpx.TermLinesRequest) (mcpx.TermLinesReply, error) {
	ch := make(chan mcpx.TermLinesReply, 1)
	linesReqs.mu.Lock()
	linesReqs.pending[req.ID] = ch
	linesReqs.mu.Unlock()
	defer func() {
		linesReqs.mu.Lock()
		delete(linesReqs.pending, req.ID)
		linesReqs.mu.Unlock()
	}()
	a.emit("term:lines", req)
	select {
	case reply := <-ch:
		return reply, nil
	case <-ctx.Done():
		return mcpx.TermLinesReply{}, ctx.Err()
	}
}

func (a *App) hTermLinesReply(args []interface{}) (interface{}, error) {
	reply, err := arg[mcpx.TermLinesReply](args, 0)
	if err != nil {
		return nil, err
	}
	linesReqs.mu.Lock()
	ch := linesReqs.pending[reply.ID]
	linesReqs.mu.Unlock()
	if ch != nil {
		ch <- reply
	}
	return nil, nil
}

// mcpMode 对应 Deps.Mode：发 term:mode 问前端光标模式，等 term:mode-reply。
func (a *App) mcpMode(ctx context.Context, req mcpx.TermModeRequest) (mcpx.TermModeReply, error) {
	ch := make(chan mcpx.TermModeReply, 1)
	modeReqs.mu.Lock()
	modeReqs.pending[req.ID] = ch
	modeReqs.mu.Unlock()
	defer func() {
		modeReqs.mu.Lock()
		delete(modeReqs.pending, req.ID)
		modeReqs.mu.Unlock()
	}()
	a.emit("term:mode", req)
	select {
	case reply := <-ch:
		return reply, nil
	case <-ctx.Done():
		return mcpx.TermModeReply{}, ctx.Err()
	}
}

func (a *App) hTermModeReply(args []interface{}) (interface{}, error) {
	reply, err := arg[mcpx.TermModeReply](args, 0)
	if err != nil {
		return nil, err
	}
	modeReqs.mu.Lock()
	ch := modeReqs.pending[reply.ID]
	modeReqs.mu.Unlock()
	if ch != nil {
		ch <- reply
	}
	return nil, nil
}
